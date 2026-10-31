use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult};

const COMMIT: &str = "7dd0aefd001086f5bafaae03736ff06facf351efe1e9187b9e93bb4817c4d1d4";
const RUNNER_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_HASH: &str = "3333333333333333333333333333333333333333333333333333333333333333";
const MODEL: &str = "Qwen/Qwen3.8-27B";
const EXAM: &str = "near-basics-v1";
const QUESTIONS: u32 = 5;
const HOUR_NS: u64 = 60 * NS_PER_MINUTE;

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, gas_tgas: u64, at_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("registry.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .block_timestamp(at_ns)
        .account_balance(NearToken::from_near(50));
    b
}

fn set(predecessor: &str, deposit: NearToken, gas_tgas: u64) {
    testing_env!(ctx(predecessor, deposit, gas_tgas, 0).build());
}

fn set_at(predecessor: &str, deposit: NearToken, at_ns: u64) {
    testing_env!(ctx(predecessor, deposit, 300, at_ns).build());
}

fn runner_source() -> Value {
    json!({ "Project": { "project_id": "owner.testnet/proctor-exam-runner", "version_key": null } })
}

fn setup() -> Registry {
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::new(acc("owner.testnet"), acc("outlayer.testnet"), runner_source(), RUNNER_HASH.to_string());
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "NEAR basics".into(), COMMIT.into(), 6000, QUESTIONS, "exam-near-basics".into());
    r
}

fn sit(r: &mut Registry) -> u64 {
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
    id
}

/// A well-formed runner output: one completion id per answered question.
fn output_with(sitting_id: u64, correct: u32, total: u32, failed_calls: u32) -> Value {
    let ids: Vec<String> = (0..total - failed_calls).map(|i| format!("chatcmpl-{sitting_id}-{i}")).collect();
    json!({
        "proctor_version": "0.1.0",
        "request_id": format!("sitting-{sitting_id}"),
        "exam_id": EXAM,
        "candidate": { "model": MODEL, "endpoint": "https://cloud-api.near.ai/v1/chat/completions" },
        "exam_commitment": COMMIT,
        "total": total,
        "correct": correct,
        "score_bps": (correct as u64 * 10_000 / total as u64) as u32,
        "passed": true,
        "complete": failed_calls == 0,
        "failed_calls": failed_calls,
        "response_ids": ids,
    })
}

fn output(sitting_id: u64, correct: u32) -> Value {
    output_with(sitting_id, correct, QUESTIONS, 0)
}

/// Delivers raw promise result bytes to the callback, as the chain would.
fn resolve_raw(r: &mut Registry, sitting_id: u64, result: PromiseResult) -> SittingOutcome {
    testing_env!(
        ctx("registry.testnet", NearToken::from_yoctonear(0), 300, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    r.on_sitting_result(sitting_id)
}

fn resolve(r: &mut Registry, sitting_id: u64, result: Result<Option<Value>, PromiseError>) -> SittingOutcome {
    let raw = match result {
        Ok(value) => PromiseResult::Successful(serde_json::to_vec(&value).unwrap()),
        Err(_) => PromiseResult::Failed,
    };
    resolve_raw(r, sitting_id, raw)
}

fn rejected_reason(outcome: &SittingOutcome) -> &str {
    match outcome {
        SittingOutcome::Rejected { reason } => reason,
        other => panic!("expected Rejected, got {other:?}"),
    }
}

fn transfers_to(account: &str) -> Vec<NearToken> {
    get_created_receipts()
        .into_iter()
        .filter(|rc| rc.receiver_id == acc(account))
        .flat_map(|rc| rc.actions)
        .filter_map(|a| match a {
            MockAction::Transfer { deposit, .. } => Some(deposit),
            _ => None,
        })
        .collect()
}

// ------------------------------------------------------------------ exams

#[test]
fn registers_exam_with_author_and_commitment() {
    let r = setup();
    let exam = r.get_exam(EXAM.into()).unwrap();
    assert_eq!(exam.author, acc("author.testnet"));
    assert_eq!(exam.commitment, COMMIT);
    assert_eq!(exam.question_count, QUESTIONS);
    assert!(exam.active);
    assert!(get_logs().iter().any(|l| l.contains("exam_registered")));
}

#[test]
#[should_panic(expected = "commitment must be 64 lowercase hex characters")]
fn rejects_bad_commitment() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("x".into(), "X".into(), "not-a-hash".into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "exam_id is already registered")]
fn rejects_duplicate_exam() {
    let mut r = setup();
    set("other.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "Copy".into(), COMMIT.into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "pass_mark_bps must be at most 10000")]
fn rejects_pass_mark_over_100_percent() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 10_001, 5, "p".into());
}

#[test]
#[should_panic(expected = "question_count must be between 1 and 64")]
fn rejects_exam_over_the_question_cap() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 6000, 65, "p".into());
}

#[test]
#[should_panic(expected = "exam_id may only use letters, digits")]
fn rejects_exam_id_with_separator() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("e|f".into(), "Y".into(), COMMIT.into(), 6000, 5, "p".into());
}

#[test]
#[should_panic(expected = "secrets_profile must be 1-64 letters, digits, - or _")]
fn rejects_profile_outlayer_would_refuse() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 6000, 5, "my.profile".into());
}

#[test]
#[should_panic(expected = "only the exam author can do this")]
fn only_author_can_deactivate_exam() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_active(EXAM.into(), false);
}

// --------------------------------------------------------------- sittings

#[test]
fn sitting_calls_outlayer_with_public_input_only() {
    let mut r = setup();
    let id = sit(&mut r);
    let sitting = r.get_sitting(id).unwrap();
    assert_eq!(sitting.candidate_model, MODEL);
    assert_eq!(sitting.compute_deposit, NearToken::from_millinear(85));
    assert_eq!(sitting.runner_hash, RUNNER_HASH);

    let receipts = get_created_receipts();
    let call = receipts
        .iter()
        .find(|rc| rc.receiver_id == acc("outlayer.testnet"))
        .expect("a receipt to OutLayer");
    let (method, args, deposit) = call
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                String::from_utf8(args.clone()).unwrap(),
                *attached_deposit,
            )),
            _ => None,
        })
        .expect("a function call action");
    assert_eq!(method, "request_execution");
    assert_eq!(deposit, NearToken::from_millinear(85));
    let args: Value = serde_json::from_str(&args).unwrap();
    assert_eq!(args["payer_account_id"], "alice.testnet");
    assert_eq!(args["secrets_ref"]["account_id"], "author.testnet");
    // The public input names the candidate and the sitting, and nothing else:
    // the exam never leaves OutLayer secrets.
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap();
    assert_eq!(input, json!({ "request_id": format!("sitting-{id}"), "candidate": { "model": MODEL } }));

    let callback = receipts
        .iter()
        .find(|rc| rc.receiver_id == acc("registry.testnet"))
        .expect("a callback receipt");
    assert!(callback.actions.iter().any(|a| matches!(
        a,
        MockAction::FunctionCallWeight { method_name, prepaid_gas, .. }
            if method_name == b"on_sitting_result" && *prepaid_gas == CALLBACK_GAS
    )));
}

#[test]
#[should_panic(expected = "attach at least")]
fn sitting_requires_minimum_deposit() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(1), 300);
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
}

#[test]
#[should_panic(expected = "attach at least 150 TGas")]
fn sitting_requires_enough_gas() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(100), 100);
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
}

#[test]
#[should_panic(expected = "candidate_model may only use letters, digits")]
fn rejects_candidate_with_separator() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let _ = r.sit_exam(EXAM.into(), "Victim|e".into());
}

#[test]
#[should_panic(expected = "exam is not active")]
fn inactive_exam_cannot_be_sat() {
    let mut r = setup();
    set("author.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_active(EXAM.into(), false);
    sit(&mut r);
}

#[test]
fn passing_sitting_issues_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let out = output_with(id, 4, QUESTIONS, 0);
    let outcome = resolve(&mut r, id, Ok(Some(out.clone())));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 8000 });

    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.candidate_model, MODEL);
    assert_eq!(cert.exam_commitment, COMMIT);
    assert_eq!(cert.runner_hash, RUNNER_HASH);
    assert_eq!(cert.status, CertStatus::Active);
    let ids: Vec<String> = serde_json::from_value(out["response_ids"].clone()).unwrap();
    assert_eq!(cert.response_count, QUESTIONS);
    assert_eq!(cert.response_ids_hash, response_ids_hash(&ids));
    assert!(r.is_certified(MODEL.into(), EXAM.into()));
    assert!(r.get_sitting(id).is_none(), "pending sitting is cleared");
    assert_eq!(r.get_outcome(id), Some(outcome));
    assert_eq!(r.get_exam(EXAM.into()).unwrap().sittings, 1);
    // The completion ids are published in the event, not stored.
    let logs = get_logs();
    assert!(logs.iter().any(|l| l.contains("sitting_resolved") && l.contains(&ids[0])));
}

#[test]
fn pass_at_exactly_the_pass_mark_certifies() {
    let mut r = setup();
    let id = sit(&mut r);
    // 3/5 = 6000 bps, the registered pass mark.
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 3))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 6000 });
}

#[test]
fn failing_sitting_records_failure_without_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 2))));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 4000 });
    assert!(r.get_certificate(0).is_none());
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn pass_mark_is_decided_by_registry_not_runner() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 1);
    out["passed"] = json!(true); // a runner claiming a pass does not matter
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 2000 });
}

#[test]
#[should_panic(expected = "candidate already holds an active certificate")]
fn certified_candidate_cannot_sit_again() {
    let mut r = certified();
    sit(&mut r);
}

#[test]
fn only_the_first_of_two_concurrent_passes_certifies() {
    let mut r = setup();
    let first = sit(&mut r);
    let second = sit(&mut r);
    resolve(&mut r, first, Ok(Some(output(first, 5))));
    let outcome = resolve(&mut r, second, Ok(Some(output(second, 5))));
    assert_eq!(rejected_reason(&outcome), "candidate is already certified");
    assert_eq!(r.get_config().certificates, 1);
    assert_eq!(r.latest_certificate(MODEL.into(), EXAM.into()).unwrap().cert_id, 0);
}

// ---------------------------------------------------- output verification

#[test]
fn rejects_output_for_a_different_exam() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["exam_commitment"] = json!("2222222222222222222222222222222222222222222222222222222222222222");
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert!(rejected_reason(&outcome).starts_with("exam commitment mismatch"));
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn rejects_output_with_a_different_exam_id() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["exam_id"] = json!("some-other-exam");
    assert_eq!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))), "exam id mismatch");
}

#[test]
fn rejects_output_for_a_different_candidate() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["candidate"]["model"] = json!("some/other-model");
    assert_eq!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))), "candidate mismatch");
}

#[test]
fn rejects_tampered_score() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 2);
    out["score_bps"] = json!(10_000);
    assert!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))).starts_with("score 10000 bps does not match"));
}

#[test]
fn rejects_output_replayed_from_another_sitting() {
    let mut r = setup();
    let first = sit(&mut r);
    let second = sit(&mut r);
    let outcome = resolve(&mut r, second, Ok(Some(output(first, 5))));
    assert_eq!(rejected_reason(&outcome), "request id mismatch");
}

#[test]
fn rejects_a_run_over_fewer_questions_than_registered() {
    let mut r = setup();
    let id = sit(&mut r);
    // 1/1 would otherwise be a perfect score.
    let outcome = resolve(&mut r, id, Ok(Some(output_with(id, 1, 1, 0))));
    assert!(rejected_reason(&outcome).starts_with("runner asked 1 questions"));
}

#[test]
fn rejects_complete_flag_that_disagrees_with_failed_calls() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output_with(id, 3, QUESTIONS, 2);
    out["complete"] = json!(true);
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(rejected_reason(&outcome), "complete flag disagrees with failed_calls");
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn rejects_more_answers_than_questions_asked() {
    let mut r = setup();
    let id = sit(&mut r);
    let out = output_with(id, 4, QUESTIONS, 2);
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(rejected_reason(&outcome), "correct answers plus failed calls exceed the question count");
}

#[test]
fn rejects_missing_or_oversized_response_ids() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["response_ids"] = json!(["only-one"]);
    assert!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))).starts_with("1 response ids for 5"));

    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["response_ids"][0] = json!("x".repeat(MAX_RESPONSE_ID_LEN + 1));
    assert!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))).starts_with("response ids must be"));
}

#[test]
fn malformed_output_is_rejected() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(json!({ "hello": "world" }))));
    assert!(rejected_reason(&outcome).starts_with("malformed runner output"));
}

#[test]
fn non_json_result_is_recorded_not_stuck() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve_raw(&mut r, id, PromiseResult::Successful(b"<html>502 Bad Gateway</html>".to_vec()));
    assert!(rejected_reason(&outcome).starts_with("malformed runner output"));
    assert!(r.get_sitting(id).is_none());
    assert_eq!(r.get_outcome(id), Some(outcome));

    let id = sit(&mut r);
    let outcome = resolve_raw(&mut r, id, PromiseResult::Successful(vec![]));
    assert!(rejected_reason(&outcome).starts_with("malformed runner output"));
}

#[test]
fn oversized_result_is_rejected_without_parsing() {
    let mut r = setup();
    let id = sit(&mut r);
    let huge = vec![b' '; MAX_OUTPUT_BYTES + 1];
    let outcome = resolve_raw(&mut r, id, PromiseResult::Successful(huge));
    assert!(rejected_reason(&outcome).starts_with("runner output is"));
}

#[test]
fn incomplete_sitting_is_neither_pass_nor_fail() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output_with(id, 3, QUESTIONS, 2))));
    assert_eq!(outcome, SittingOutcome::Incomplete { failed_calls: 2 });
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn failed_run_is_recorded_and_settled_by_outlayer() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(None));
    assert!(matches!(outcome, SittingOutcome::RunnerFailed { .. }));
    // OutLayer refunds the payer of a failed run itself; the registry must not pay twice.
    assert!(transfers_to("alice.testnet").is_empty());
}

#[test]
fn refused_request_refunds_the_payer() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Err(PromiseError::Failed));
    assert!(matches!(outcome, SittingOutcome::RunnerFailed { .. }));
    assert_eq!(transfers_to("alice.testnet"), vec![NearToken::from_millinear(85)]);
}

#[test]
#[should_panic(expected = "Method on_sitting_result is private")]
fn outsiders_cannot_forge_results() {
    let mut r = setup();
    let id = sit(&mut r);
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.on_sitting_result(id);
}

#[test]
fn second_callback_for_a_sitting_changes_nothing() {
    let mut r = setup();
    let id = sit(&mut r);
    let first = resolve(&mut r, id, Ok(Some(output(id, 5))));
    let again = resolve(&mut r, id, Ok(Some(output(id, 0))));
    assert_eq!(rejected_reason(&again), "unknown sitting");
    assert_eq!(r.get_outcome(id), Some(first));
    assert_eq!(r.get_exam(EXAM.into()).unwrap().sittings, 1);
    assert!(get_logs().iter().any(|l| l.contains("sitting_rejected")));
}

// ----------------------------------------------------------------- retests

fn certified() -> Registry {
    let mut r = setup();
    let id = sit(&mut r);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    r
}

fn start_retest_at(r: &mut Registry, cert_id: u64, at_ns: u64) -> u64 {
    set_at("anyone.testnet", NearToken::from_millinear(100), at_ns);
    let id = r.get_config().next_sitting_id;
    let _ = r.retest(cert_id);
    id
}

fn start_retest(r: &mut Registry, cert_id: u64) -> u64 {
    start_retest_at(r, cert_id, HOUR_NS)
}

#[test]
fn passing_retest_reverifies_certificate() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    assert_eq!(r.get_certificate(0).unwrap().retest_in_flight, Some(id));
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 4))));
    assert_eq!(outcome, SittingOutcome::RetestPassed { cert_id: 0, score_bps: 8000 });
    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.retests_passed, 1);
    assert_eq!(cert.status, CertStatus::Active);
    assert_eq!(cert.retest_in_flight, None);
}

#[test]
fn failing_retest_revokes_certificate() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 1))));
    assert_eq!(outcome, SittingOutcome::Revoked { cert_id: 0, score_bps: 2000 });
    let cert = r.get_certificate(0).unwrap();
    assert!(matches!(cert.status, CertStatus::Revoked { .. }));
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn nothing_but_a_complete_failing_run_revokes() {
    let mut r = certified();
    let failures: Vec<PromiseResult> = vec![
        PromiseResult::Failed,
        PromiseResult::Successful(b"null".to_vec()),
        PromiseResult::Successful(b"not json".to_vec()),
        PromiseResult::Successful(serde_json::to_vec(&json!({ "hello": "world" })).unwrap()),
    ];
    for (round, result) in failures.into_iter().enumerate() {
        let id = start_retest_at(&mut r, 0, HOUR_NS * (round as u64 + 1));
        resolve_raw(&mut r, id, result);
        assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active, "round {round}");
    }
    // An outage that leaves every question unasked is incomplete, not a fail.
    let id = start_retest_at(&mut r, 0, HOUR_NS * 10);
    let outcome = resolve(&mut r, id, Ok(Some(output_with(id, 0, QUESTIONS, QUESTIONS))));
    assert_eq!(outcome, SittingOutcome::Incomplete { failed_calls: QUESTIONS });
    // So is a retest whose output belongs to another candidate.
    let id = start_retest_at(&mut r, 0, HOUR_NS * 11);
    let mut out = output(id, 0);
    out["candidate"]["model"] = json!("some/other-model");
    resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);
}

#[test]
#[should_panic(expected = "a re-test of this certificate is already running")]
fn only_one_retest_runs_at_a_time() {
    let mut r = certified();
    start_retest(&mut r, 0);
    start_retest_at(&mut r, 0, HOUR_NS * 5);
}

#[test]
#[should_panic(expected = "re-tests of one certificate must be at least an hour apart")]
fn retests_are_rate_limited() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    start_retest_at(&mut r, 0, HOUR_NS + 30 * NS_PER_MINUTE);
}

#[test]
fn retest_allowed_again_after_the_cooldown() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    let next = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    assert_eq!(r.get_certificate(0).unwrap().retest_in_flight, Some(next));
}

#[test]
#[should_panic(expected = "certificate is not active")]
fn revoked_certificate_cannot_be_retested() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    resolve(&mut r, id, Ok(Some(output(id, 0))));
    start_retest_at(&mut r, 0, 5 * HOUR_NS);
}

// ------------------------------------------------------------------ expiry

#[test]
#[should_panic(expected = "a sitting can be expired 30 minutes after it was requested")]
fn sittings_cannot_be_expired_early() {
    let mut r = setup();
    let id = sit(&mut r);
    set_at("anyone.testnet", NearToken::from_yoctonear(0), 29 * NS_PER_MINUTE);
    r.expire_sitting(id);
}

#[test]
fn a_stuck_retest_can_be_expired_without_revoking() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    set_at("anyone.testnet", NearToken::from_yoctonear(0), HOUR_NS + SITTING_TIMEOUT_NS);
    assert_eq!(r.expire_sitting(id), SittingOutcome::Expired);
    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.status, CertStatus::Active);
    assert_eq!(cert.retest_in_flight, None);
    assert!(r.get_sitting(id).is_none());
    // A callback that turns up afterwards changes nothing.
    let late = resolve(&mut r, id, Ok(Some(output(id, 0))));
    assert_eq!(rejected_reason(&late), "unknown sitting");
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);
}

// ------------------------------------------------------------------- admin

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_owner_can_change_runner() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.set_runner(runner_source(), RUNNER_HASH.into());
}

#[test]
#[should_panic(expected = "runner_source must be an OutLayer ExecutionSource object")]
fn runner_source_must_be_an_object() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_runner(Value::Null, RUNNER_HASH.into());
}

#[test]
fn certificate_records_the_runner_the_sitting_started_with() {
    let mut r = setup();
    let id = sit(&mut r);
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_runner(runner_source(), OTHER_HASH.into());
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(r.get_certificate(0).unwrap().runner_hash, RUNNER_HASH);
}

#[test]
#[should_panic(expected = "OutLayer caps a run at 180 seconds")]
fn limits_respect_outlayer_cap() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_limits(1_000_000_000, 128, 181);
}

#[test]
#[should_panic(expected = "max_instructions must be between")]
fn limits_cannot_be_set_too_low_to_finish() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_limits(0, 0, 0);
}

#[test]
fn owner_can_set_limits_within_bounds() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_limits(100_000_000_000, 512, 120);
    let config = r.get_config();
    assert_eq!((config.max_instructions, config.max_memory_mb, config.max_execution_seconds), (100_000_000_000, 512, 120));
    assert!(get_logs().iter().any(|l| l.contains("limits_updated")));
}

// ----------------------------------------------------------------- storage

/// `near_sdk::store` collections cache writes until flushed (the wasm entry
/// point does this after each call), so flush before reading storage usage.
fn flush(r: &mut Registry) {
    r.exams.flush();
    r.certificates.flush();
    r.sittings.flush();
    r.outcomes.flush();
    r.latest.flush();
}

#[test]
fn storage_fee_covers_a_worst_case_certificate() {
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::new(acc("owner.testnet"), acc("outlayer.testnet"), runner_source(), RUNNER_HASH.to_string());
    let exam_id = "e".repeat(MAX_ID_LEN);
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam(exam_id.clone(), "T".into(), COMMIT.into(), 0, MAX_QUESTIONS, "p".into());

    // Each testing_env! resets the storage counter, so measure each step
    // inside its own environment and add the two.
    let model = "m".repeat(MAX_MODEL_LEN);
    let payer = format!("{}.testnet", "a".repeat(56)); // 64 bytes, the longest account id
    set(&payer, NearToken::from_millinear(100), 300);
    let before_sit = env::storage_usage();
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(exam_id.clone(), model.clone());
    flush(&mut r);
    let sit_bytes = env::storage_usage() - before_sit;

    let ids: Vec<String> = (0..MAX_QUESTIONS).map(|_| "i".repeat(MAX_RESPONSE_ID_LEN)).collect();
    let out = json!({
        "request_id": format!("sitting-{id}"), "exam_id": exam_id, "candidate": { "model": model },
        "exam_commitment": COMMIT, "total": MAX_QUESTIONS, "correct": MAX_QUESTIONS, "score_bps": 10_000,
        "complete": true, "failed_calls": 0, "response_ids": ids,
    });
    testing_env!(
        ctx("registry.testnet", NearToken::from_yoctonear(0), 300, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(serde_json::to_vec(&out).unwrap())],
    );
    let before_callback = env::storage_usage();
    let outcome = r.on_sitting_result(id);
    flush(&mut r);
    assert!(matches!(outcome, SittingOutcome::Certified { .. }), "{outcome:?}");
    // The callback frees the sitting record, so its delta may be negative.
    let callback_bytes = env::storage_usage() as i64 - before_callback as i64;

    assert!(sit_bytes > 0 && callback_bytes != 0, "storage was not measured");
    let used = u64::try_from(sit_bytes as i64 + callback_bytes).unwrap();
    let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
    assert!(cost <= SITTING_STORAGE_FEE, "a certified sitting uses {used} bytes ({cost}), more than the fee");
}

// ------------------------------------------------------------------- views

#[test]
fn certificate_lookup_never_returns_another_pairs_certificate() {
    let r = certified();
    assert!(r.latest_certificate(MODEL.into(), EXAM.into()).is_some());
    assert!(r.latest_certificate("Qwen/Qwen3.8".into(), format!("27B|{EXAM}")).is_none());
    assert!(!r.is_certified(MODEL.into(), "other-exam".into()));
}

#[test]
fn certificates_page_by_index() {
    let r = certified();
    assert_eq!(r.list_certificates(None, None).len(), 1);
    assert!(r.list_certificates(Some(1), Some(10)).is_empty());
    assert!(r.list_certificates(Some(u32::MAX), Some(10)).is_empty());
}
