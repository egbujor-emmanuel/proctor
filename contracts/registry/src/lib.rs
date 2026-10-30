//! PROCTOR certificate registry.
//!
//! Exam authors register a secret exam by its commitment (SHA-256 of the exam
//! bytes); the exam itself lives only as an OutLayer secret. Anyone can pay
//! for a sitting. The contract asks OutLayer to run the exam runner inside a
//! TEE, and a certificate is written **only** from OutLayer's callback, after
//! the contract re-checks the runner's output against what it registered.
//! Certified candidates can be re-tested at any time; a failed re-test
//! revokes the certificate.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

/// Gas reserved for our own callback. The OutLayer call gets the rest.
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
/// Kept by the registry from each sitting deposit to pay for the storage the
/// sitting and its outcome or certificate use. The rest goes to OutLayer.
const SITTING_STORAGE_FEE: NearToken = NearToken::from_millinear(5);
/// Smallest deposit accepted for a sitting (storage fee plus a compute floor).
const MIN_SITTING_DEPOSIT: NearToken = NearToken::from_millinear(20);
const BPS_SCALE: u32 = 10_000;
const MAX_ID_LEN: usize = 64;
const MAX_TITLE_LEN: usize = 160;
const MAX_MODEL_LEN: usize = 128;
const MAX_RESPONSE_IDS: usize = 64;
const EVENT_STANDARD: &str = "proctor";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Exams,
    Certificates,
    Sittings,
    Outcomes,
    Latest,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Exam {
    pub exam_id: String,
    pub author: AccountId,
    pub title: String,
    /// SHA-256 (hex) of the exact exam bytes stored as the OutLayer secret.
    pub commitment: String,
    pub pass_mark_bps: u32,
    /// OutLayer secrets profile, owned by `author`, holding EXAM_JSON and
    /// NEARAI_API_KEY.
    pub secrets_profile: String,
    pub active: bool,
    pub sittings: u64,
    pub registered_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CertStatus {
    Active,
    Revoked { reason: String, at_ns: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Certificate {
    pub cert_id: u64,
    pub exam_id: String,
    pub exam_commitment: String,
    pub candidate_model: String,
    /// SHA-256 of the exam-runner wasm that produced the score.
    pub runner_hash: String,
    pub score_bps: u32,
    pub correct: u32,
    pub total: u32,
    pub issued_at_ns: u64,
    pub last_verified_ns: u64,
    pub retests_passed: u32,
    pub status: CertStatus,
    pub requested_by: AccountId,
    pub sitting_id: u64,
    /// NEAR AI gateway completion ids; anyone can fetch their signatures.
    pub response_ids: Vec<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SittingKind {
    Initial,
    Retest { cert_id: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Sitting {
    pub sitting_id: u64,
    pub exam_id: String,
    pub candidate_model: String,
    pub requested_by: AccountId,
    pub kind: SittingKind,
    pub requested_at_ns: u64,
}

/// What became of a sitting. Every sitting ends in exactly one of these.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SittingOutcome {
    Certified { cert_id: u64, score_bps: u32 },
    Failed { score_bps: u32 },
    RetestPassed { cert_id: u64, score_bps: u32 },
    Revoked { cert_id: u64, score_bps: u32 },
    /// Some questions could not be asked; nothing is certified or revoked.
    Incomplete { failed_calls: u32 },
    /// OutLayer reported a failed run.
    RunnerFailed,
    /// The runner output did not match what the registry expected.
    Rejected { reason: String },
}

/// The fields of the exam runner's output the registry checks.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RunnerOutput {
    pub request_id: String,
    pub exam_id: String,
    pub candidate: RunnerCandidate,
    pub exam_commitment: String,
    pub total: u32,
    pub correct: u32,
    pub score_bps: u32,
    pub complete: bool,
    pub failed_calls: u32,
    #[serde(default)]
    pub response_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RunnerCandidate {
    pub model: String,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub outlayer_account: AccountId,
    pub runner_source: Value,
    pub runner_hash: String,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
    pub exams: u32,
    pub certificates: u32,
    pub next_sitting_id: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    outlayer_account: AccountId,
    /// OutLayer `ExecutionSource` as JSON (e.g. a Project or WasmUrl source).
    runner_source_json: String,
    runner_hash: String,
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u64,
    exams: IterableMap<String, Exam>,
    certificates: Vector<Certificate>,
    sittings: LookupMap<u64, Sitting>,
    outcomes: LookupMap<u64, SittingOutcome>,
    /// `candidate_model|exam_id` -> latest certificate id.
    latest: LookupMap<String, u64>,
    next_sitting_id: u64,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn require_id(value: &str, what: &str, max: usize) {
    require!(!value.trim().is_empty(), format!("{what} must not be empty"));
    require!(value.len() <= max, format!("{what} is longer than {max} bytes"));
}

fn latest_key(model: &str, exam_id: &str) -> String {
    format!("{model}|{exam_id}")
}

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[near]
impl Registry {
    #[init]
    pub fn new(
        owner: AccountId,
        outlayer_account: AccountId,
        runner_source: Value,
        runner_hash: String,
    ) -> Self {
        require!(is_hex64(&runner_hash), "runner_hash must be 64 lowercase hex characters");
        Self {
            owner,
            outlayer_account,
            runner_source_json: runner_source.to_string(),
            runner_hash,
            max_instructions: 50_000_000_000,
            max_memory_mb: 256,
            max_execution_seconds: 180,
            exams: IterableMap::new(StorageKey::Exams),
            certificates: Vector::new(StorageKey::Certificates),
            sittings: LookupMap::new(StorageKey::Sittings),
            outcomes: LookupMap::new(StorageKey::Outcomes),
            latest: LookupMap::new(StorageKey::Latest),
            next_sitting_id: 0,
        }
    }

    // ---------------------------------------------------------------- admin

    /// Points future sittings at a new runner build. Existing certificates
    /// keep the hash of the runner that produced them.
    pub fn set_runner(&mut self, runner_source: Value, runner_hash: String) {
        self.assert_owner();
        require!(is_hex64(&runner_hash), "runner_hash must be 64 lowercase hex characters");
        self.runner_source_json = runner_source.to_string();
        self.runner_hash = runner_hash.clone();
        emit("runner_updated", json!({ "runner_hash": runner_hash }));
    }

    pub fn set_limits(&mut self, max_instructions: u64, max_memory_mb: u32, max_execution_seconds: u64) {
        self.assert_owner();
        require!(max_execution_seconds <= 180, "OutLayer caps a run at 180 seconds");
        self.max_instructions = max_instructions;
        self.max_memory_mb = max_memory_mb;
        self.max_execution_seconds = max_execution_seconds;
    }

    // ---------------------------------------------------------------- exams

    /// Registers a secret exam by its commitment. The caller becomes the
    /// author and must own `secrets_profile` on OutLayer. Attach enough NEAR to
    /// cover the storage this record uses; any excess is refunded.
    #[payable]
    pub fn register_exam(
        &mut self,
        exam_id: String,
        title: String,
        commitment: String,
        pass_mark_bps: u32,
        secrets_profile: String,
    ) {
        require_id(&exam_id, "exam_id", MAX_ID_LEN);
        require_id(&title, "title", MAX_TITLE_LEN);
        require_id(&secrets_profile, "secrets_profile", MAX_ID_LEN);
        require!(is_hex64(&commitment), "commitment must be 64 lowercase hex characters");
        require!(pass_mark_bps <= BPS_SCALE, "pass_mark_bps must be at most 10000");
        require!(!self.exams.contains_key(&exam_id), "exam_id is already registered");

        let storage_before = env::storage_usage();
        let author = env::predecessor_account_id();
        let exam = Exam {
            exam_id: exam_id.clone(),
            author: author.clone(),
            title,
            commitment: commitment.clone(),
            pass_mark_bps,
            secrets_profile,
            active: true,
            sittings: 0,
            registered_at_ns: env::block_timestamp(),
        };
        self.exams.insert(exam_id.clone(), exam);
        self.exams.flush();

        let used = env::storage_usage().saturating_sub(storage_before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {cost} to cover storage"));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(author.clone()).transfer(refund).detach();
        }
        emit(
            "exam_registered",
            json!({ "exam_id": exam_id, "author": author, "commitment": commitment, "pass_mark_bps": pass_mark_bps }),
        );
    }

    pub fn set_exam_active(&mut self, exam_id: String, active: bool) {
        let mut exam = self.exams.get(&exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(env::predecessor_account_id() == exam.author, "only the exam author can do this");
        exam.active = active;
        self.exams.insert(exam_id.clone(), exam);
        emit("exam_status", json!({ "exam_id": exam_id, "active": active }));
    }

    // ------------------------------------------------------------- sittings

    /// Pays for a sitting of `exam_id` by `candidate_model`. The deposit, less
    /// a small storage fee, is forwarded to OutLayer; OutLayer refunds unused
    /// compute to the caller.
    #[payable]
    pub fn sit_exam(&mut self, exam_id: String, candidate_model: String) -> Promise {
        require_id(&candidate_model, "candidate_model", MAX_MODEL_LEN);
        let exam = self.exams.get(&exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(exam.active, "exam is not active");
        self.start_sitting(exam, candidate_model, SittingKind::Initial)
    }

    /// Re-tests the candidate behind an active certificate with the same
    /// exam. Anyone may pay for a re-test; a failed one revokes the
    /// certificate.
    #[payable]
    pub fn retest(&mut self, cert_id: u64) -> Promise {
        let cert = self.cert(cert_id);
        require!(cert.status == CertStatus::Active, "certificate is not active");
        let exam = self.exams.get(&cert.exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        self.start_sitting(exam, cert.candidate_model, SittingKind::Retest { cert_id })
    }

    /// OutLayer's answer for a sitting. Never panics, so the outcome is
    /// always recorded.
    #[private]
    pub fn on_sitting_result(
        &mut self,
        sitting_id: u64,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> SittingOutcome {
        let Some(sitting) = self.sittings.remove(&sitting_id) else {
            return SittingOutcome::Rejected { reason: "unknown sitting".into() };
        };
        let outcome = match result {
            Ok(Some(value)) => match serde_json::from_value::<RunnerOutput>(value) {
                Ok(output) => self.apply_output(&sitting, output),
                Err(_) => SittingOutcome::Rejected { reason: "malformed runner output".into() },
            },
            Ok(None) | Err(_) => SittingOutcome::RunnerFailed,
        };
        if let Some(mut exam) = self.exams.get(&sitting.exam_id).cloned() {
            exam.sittings += 1;
            self.exams.insert(sitting.exam_id.clone(), exam);
        }
        self.outcomes.insert(sitting_id, outcome.clone());
        emit(
            "sitting_resolved",
            json!({ "sitting_id": sitting_id, "exam_id": sitting.exam_id, "candidate_model": sitting.candidate_model, "outcome": outcome }),
        );
        outcome
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            outlayer_account: self.outlayer_account.clone(),
            runner_source: serde_json::from_str(&self.runner_source_json).unwrap_or(Value::Null),
            runner_hash: self.runner_hash.clone(),
            max_instructions: self.max_instructions,
            max_memory_mb: self.max_memory_mb,
            max_execution_seconds: self.max_execution_seconds,
            exams: self.exams.len(),
            certificates: self.certificates.len(),
            next_sitting_id: self.next_sitting_id,
        }
    }

    pub fn get_exam(&self, exam_id: String) -> Option<Exam> {
        self.exams.get(&exam_id).cloned()
    }

    pub fn list_exams(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Exam> {
        self.exams
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_certificate(&self, cert_id: u64) -> Option<Certificate> {
        u32::try_from(cert_id).ok().and_then(|i| self.certificates.get(i)).cloned()
    }

    pub fn list_certificates(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Certificate> {
        self.certificates
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn latest_certificate(&self, candidate_model: String, exam_id: String) -> Option<Certificate> {
        self.latest
            .get(&latest_key(&candidate_model, &exam_id))
            .and_then(|id| self.get_certificate(*id))
    }

    /// True when the candidate's latest certificate for this exam is active.
    pub fn is_certified(&self, candidate_model: String, exam_id: String) -> bool {
        self.latest_certificate(candidate_model, exam_id)
            .is_some_and(|c| c.status == CertStatus::Active)
    }

    pub fn get_sitting(&self, sitting_id: u64) -> Option<Sitting> {
        self.sittings.get(&sitting_id).cloned()
    }

    pub fn get_outcome(&self, sitting_id: u64) -> Option<SittingOutcome> {
        self.outcomes.get(&sitting_id).cloned()
    }
}

impl Registry {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn cert(&self, cert_id: u64) -> Certificate {
        self.get_certificate(cert_id).unwrap_or_else(|| env::panic_str("unknown certificate"))
    }

    fn start_sitting(&mut self, exam: Exam, candidate_model: String, kind: SittingKind) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_SITTING_DEPOSIT, format!("attach at least {MIN_SITTING_DEPOSIT}"));
        let compute = deposit.saturating_sub(SITTING_STORAGE_FEE);
        require!(
            env::prepaid_gas() >= Gas::from_tgas(150),
            "attach at least 150 TGas so OutLayer and the callback can run"
        );

        let sitting_id = self.next_sitting_id;
        self.next_sitting_id += 1;
        let requested_by = env::predecessor_account_id();
        let sitting = Sitting {
            sitting_id,
            exam_id: exam.exam_id.clone(),
            candidate_model: candidate_model.clone(),
            requested_by: requested_by.clone(),
            kind: kind.clone(),
            requested_at_ns: env::block_timestamp(),
        };
        self.sittings.insert(sitting_id, sitting);

        let input = json!({
            "request_id": format!("sitting-{sitting_id}"),
            "candidate": { "model": candidate_model },
        });
        let args = json!({
            "source": serde_json::from_str::<Value>(&self.runner_source_json).unwrap_or(Value::Null),
            "resource_limits": {
                "max_instructions": self.max_instructions,
                "max_memory_mb": self.max_memory_mb,
                "max_execution_seconds": self.max_execution_seconds,
            },
            "input_data": input.to_string(),
            "secrets_ref": { "profile": exam.secrets_profile, "account_id": exam.author },
            "response_format": "Json",
            "payer_account_id": requested_by,
        });
        emit(
            "sitting_requested",
            json!({ "sitting_id": sitting_id, "exam_id": exam.exam_id, "candidate_model": candidate_model, "kind": kind }),
        );

        Promise::new(self.outlayer_account.clone())
            .function_call_weight(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                compute,
                Gas::from_tgas(0),
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_sitting_result(sitting_id),
            )
    }

    /// Checks a runner output against the sitting and the registered exam,
    /// then certifies, fails, re-verifies or revokes.
    fn apply_output(&mut self, sitting: &Sitting, output: RunnerOutput) -> SittingOutcome {
        let Some(exam) = self.exams.get(&sitting.exam_id).cloned() else {
            return SittingOutcome::Rejected { reason: "exam no longer registered".into() };
        };
        if output.exam_commitment != exam.commitment {
            return SittingOutcome::Rejected { reason: "exam commitment mismatch".into() };
        }
        if output.exam_id != exam.exam_id {
            return SittingOutcome::Rejected { reason: "exam id mismatch".into() };
        }
        if output.candidate.model != sitting.candidate_model {
            return SittingOutcome::Rejected { reason: "candidate mismatch".into() };
        }
        if output.request_id != format!("sitting-{}", sitting.sitting_id) {
            return SittingOutcome::Rejected { reason: "request id mismatch".into() };
        }
        if output.total == 0 || output.correct > output.total {
            return SittingOutcome::Rejected { reason: "inconsistent counts".into() };
        }
        let expected_bps = ((u64::from(output.correct) * u64::from(BPS_SCALE)) / u64::from(output.total)) as u32;
        if output.score_bps != expected_bps {
            return SittingOutcome::Rejected { reason: "score does not match counts".into() };
        }
        if !output.complete {
            return SittingOutcome::Incomplete { failed_calls: output.failed_calls };
        }

        let passed = output.score_bps >= exam.pass_mark_bps;
        let now = env::block_timestamp();
        match &sitting.kind {
            SittingKind::Initial if passed => {
                let cert_id = u64::from(self.certificates.len());
                let mut response_ids = output.response_ids;
                response_ids.truncate(MAX_RESPONSE_IDS);
                self.certificates.push(Certificate {
                    cert_id,
                    exam_id: exam.exam_id.clone(),
                    exam_commitment: exam.commitment.clone(),
                    candidate_model: sitting.candidate_model.clone(),
                    runner_hash: self.runner_hash.clone(),
                    score_bps: output.score_bps,
                    correct: output.correct,
                    total: output.total,
                    issued_at_ns: now,
                    last_verified_ns: now,
                    retests_passed: 0,
                    status: CertStatus::Active,
                    requested_by: sitting.requested_by.clone(),
                    sitting_id: sitting.sitting_id,
                    response_ids,
                });
                self.latest.insert(latest_key(&sitting.candidate_model, &exam.exam_id), cert_id);
                SittingOutcome::Certified { cert_id, score_bps: output.score_bps }
            }
            SittingKind::Initial => SittingOutcome::Failed { score_bps: output.score_bps },
            SittingKind::Retest { cert_id } => {
                let cert_id = *cert_id;
                let Some(index) = u32::try_from(cert_id).ok() else {
                    return SittingOutcome::Rejected { reason: "unknown certificate".into() };
                };
                let Some(cert) = self.certificates.get_mut(index) else {
                    return SittingOutcome::Rejected { reason: "unknown certificate".into() };
                };
                if cert.status != CertStatus::Active {
                    return SittingOutcome::Rejected { reason: "certificate already revoked".into() };
                }
                if passed {
                    cert.retests_passed += 1;
                    cert.last_verified_ns = now;
                    SittingOutcome::RetestPassed { cert_id, score_bps: output.score_bps }
                } else {
                    cert.status = CertStatus::Revoked {
                        reason: format!(
                            "re-test scored {} bps, below the pass mark of {} bps",
                            output.score_bps, exam.pass_mark_bps
                        ),
                        at_ns: now,
                    };
                    SittingOutcome::Revoked { cert_id, score_bps: output.score_bps }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
