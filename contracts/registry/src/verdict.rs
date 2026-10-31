//! Turning OutLayer's answer into a sitting outcome: reading the raw
//! promise result, checking the runner output, and certifying, failing,
//! re-verifying or revoking.

use super::*;

/// What OutLayer handed the callback.
pub(crate) enum RunnerResult {
    Output(RunnerOutput),
    /// The run produced nothing (`null`); OutLayer settled the deposit itself.
    NoOutput,
    /// Bytes that are not a runner output.
    Malformed(String),
    /// The OutLayer call failed, so NEAR returned the deposit to this contract.
    CallFailed,
}

/// Reads OutLayer's result without panicking, whatever it contains.
pub(crate) fn read_runner_result() -> RunnerResult {
    if env::promise_results_count() != 1 {
        return RunnerResult::Malformed("expected exactly one promise result".into());
    }
    match env::promise_result_checked(0, MAX_OUTPUT_BYTES) {
        Err(PromiseError::Failed) => RunnerResult::CallFailed,
        Err(PromiseError::TooLong(len)) => {
            RunnerResult::Malformed(format!("runner output is {len} bytes; the limit is {MAX_OUTPUT_BYTES}"))
        }
        Ok(bytes) => match serde_json::from_slice::<Option<RunnerOutput>>(&bytes) {
            Ok(Some(output)) => RunnerResult::Output(output),
            Ok(None) => RunnerResult::NoOutput,
            Err(e) => RunnerResult::Malformed(truncated(format!("malformed runner output: {e}"))),
        },
        // `PromiseError` is non-exhaustive.
        #[allow(unreachable_patterns)]
        Err(_) => RunnerResult::Malformed("unreadable promise result".into()),
    }
}

impl Registry {
    /// Records an outcome, frees the certificate for its next re-test, and
    /// emits the result (with the completion ids, which are not stored).
    pub(crate) fn finish_sitting(&mut self, sitting: &Sitting, outcome: SittingOutcome, response_ids: &[String]) -> SittingOutcome {
        if let SittingKind::Retest { cert_id } = sitting.kind {
            if let Some(cert) = self.cert_mut(cert_id) {
                if cert.retest_in_flight == Some(sitting.sitting_id) {
                    cert.retest_in_flight = None;
                }
            }
        }
        if let Some(exam) = self.exams.get_mut(&sitting.exam_id) {
            exam.sittings = exam.sittings.saturating_add(1);
        }
        self.outcomes.insert(sitting.sitting_id, outcome.clone());
        let ids: &[String] = if matches!(outcome, SittingOutcome::Rejected { .. }) { &[] } else { response_ids };
        emit(
            "sitting_resolved",
            json!({
                "sitting_id": sitting.sitting_id,
                "exam_id": sitting.exam_id,
                "candidate_model": sitting.candidate_model,
                "outcome": outcome,
                "response_ids": ids,
            }),
        );
        outcome
    }

    /// Checks a runner output against the sitting and the registered exam.
    fn check_output(&self, sitting: &Sitting, exam: &Exam, output: &RunnerOutput) -> Result<(), String> {
        if output.exam_commitment != exam.commitment {
            return Err(truncated(format!("exam commitment mismatch: got {}", output.exam_commitment)));
        }
        if output.exam_id != exam.exam_id {
            return Err("exam id mismatch".into());
        }
        if output.candidate.model != sitting.candidate_model {
            return Err("candidate mismatch".into());
        }
        if output.request_id != format!("sitting-{}", sitting.sitting_id) {
            return Err("request id mismatch".into());
        }
        if output.total != exam.question_count {
            return Err(format!("runner asked {} questions; the exam has {}", output.total, exam.question_count));
        }
        if u64::from(output.correct) + u64::from(output.failed_calls) > u64::from(output.total) {
            return Err("correct answers plus failed calls exceed the question count".into());
        }
        if output.complete != (output.failed_calls == 0) {
            return Err("complete flag disagrees with failed_calls".into());
        }
        let expected_bps = ((u64::from(output.correct) * u64::from(BPS_SCALE)) / u64::from(output.total)) as u32;
        if output.score_bps != expected_bps {
            return Err(format!("score {} bps does not match {}/{}", output.score_bps, output.correct, output.total));
        }
        let answered = output.total - output.failed_calls;
        if output.response_ids.len() != answered as usize {
            return Err(format!("{} response ids for {answered} answered questions", output.response_ids.len()));
        }
        if output.response_ids.iter().any(|id| id.is_empty() || id.len() > MAX_RESPONSE_ID_LEN) {
            return Err(format!("response ids must be 1-{MAX_RESPONSE_ID_LEN} bytes"));
        }
        Ok(())
    }

    /// Certifies, fails, re-verifies or revokes, once the output checks out.
    pub(crate) fn apply_output(&mut self, sitting: &Sitting, output: &RunnerOutput) -> SittingOutcome {
        let Some(exam) = self.exams.get(&sitting.exam_id).cloned() else {
            return SittingOutcome::Rejected { reason: "exam no longer registered".into() };
        };
        if let Err(reason) = self.check_output(sitting, &exam, output) {
            return SittingOutcome::Rejected { reason };
        }
        if !output.complete {
            return SittingOutcome::Incomplete { failed_calls: output.failed_calls };
        }

        let passed = output.score_bps >= exam.pass_mark_bps;
        let now = env::block_timestamp();
        match &sitting.kind {
            SittingKind::Initial if passed => {
                // Two initial sittings can be in flight at once; only the first
                // pass may certify.
                if self.holds_live_certificate(&sitting.candidate_model, &exam.exam_id) {
                    return SittingOutcome::Rejected { reason: "candidate is already certified".into() };
                }
                let cert_id = u64::from(self.certificates.len());
                self.certificates.push(Certificate {
                    cert_id,
                    exam_id: exam.exam_id.clone(),
                    exam_commitment: exam.commitment.clone(),
                    candidate_model: sitting.candidate_model.clone(),
                    runner_hash: sitting.runner_hash.clone(),
                    score_bps: output.score_bps,
                    correct: output.correct,
                    total: output.total,
                    issued_at_ns: now,
                    last_verified_ns: now,
                    retests_passed: 0,
                    status: CertStatus::Active,
                    requested_by: sitting.requested_by.clone(),
                    sitting_id: sitting.sitting_id,
                    response_ids_hash: response_ids_hash(&output.response_ids),
                    response_count: output.response_ids.len() as u32,
                    retest_in_flight: None,
                    last_retest_requested_ns: None,
                });
                self.latest.insert(latest_key(&sitting.candidate_model, &exam.exam_id), cert_id);
                SittingOutcome::Certified { cert_id, score_bps: output.score_bps }
            }
            SittingKind::Initial => SittingOutcome::Failed { score_bps: output.score_bps },
            SittingKind::Retest { cert_id } => {
                let cert_id = *cert_id;
                let Some(cert) = self.cert_mut(cert_id) else {
                    return SittingOutcome::Rejected { reason: "unknown certificate".into() };
                };
                let score_bps = output.score_bps;
                let shortfall = format!("re-test scored {score_bps} bps, below the pass mark of {} bps", exam.pass_mark_bps);
                // Two strikes: one failed re-test can be noise, two in a row is a regression.
                match (&cert.status, passed) {
                    (CertStatus::Revoked { .. }, _) => {
                        SittingOutcome::Rejected { reason: "certificate already revoked".into() }
                    }
                    (_, true) => {
                        cert.status = CertStatus::Active;
                        cert.retests_passed = cert.retests_passed.saturating_add(1);
                        cert.last_verified_ns = now;
                        SittingOutcome::RetestPassed { cert_id, score_bps }
                    }
                    (CertStatus::Active, false) => {
                        cert.status = CertStatus::Suspended {
                            reason: format!("{shortfall}; a second failed re-test revokes"),
                            at_ns: now,
                        };
                        SittingOutcome::Suspended { cert_id, score_bps }
                    }
                    (CertStatus::Suspended { .. }, false) => {
                        cert.status = CertStatus::Revoked { reason: format!("second failed re-test: {shortfall}"), at_ns: now };
                        SittingOutcome::Revoked { cert_id, score_bps }
                    }
                }
            }
        }
    }
}
