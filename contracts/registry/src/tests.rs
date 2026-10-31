use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::testing_env;

const COMMIT: &str = "7dd0aefd001086f5bafaae03736ff06facf351efe1e9187b9e93bb4817c4d1d4";
const RUNNER_HASH: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const MODEL: &str = "Qwen/Qwen3.8-27B";
const EXAM: &str = "near-basics-v1";

fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, gas_tgas: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("registry.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .account_balance(NearToken::from_near(50));
    b
}

fn set(predecessor: &str, deposit: NearToken, gas_tgas: u64) {
    testing_env!(ctx(predecessor, deposit, gas_tgas).build());
}

fn setup() -> Registry {
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    let mut r = Registry::new(
        acc("owner.testnet"),
        acc("outlayer.testnet"),
        json!({ "Project": { "project_id": "owner.testnet/proctor-exam-runner", "version_key": null } }),
        RUNNER_HASH.to_string(),
    );
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "NEAR basics".into(), COMMIT.into(), 6000, "exam-near-basics".into());
    r
}

fn sit(r: &mut Registry) -> u64 {
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
    id
}

fn output(sitting_id: u64, correct: u32, total: u32) -> Value {
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
        "complete": true,
        "failed_calls": 0,
        "response_ids": ["chatcmpl-1"],
    })
}

fn resolve(r: &mut Registry, sitting_id: u64, result: Result<Option<Value>, PromiseError>) -> SittingOutcome {
    set("registry.testnet", NearToken::from_yoctonear(0), 300);
    r.on_sitting_result(sitting_id, result)
}

#[test]
fn registers_exam_with_author_and_commitment() {
    let r = setup();
    let exam = r.get_exam(EXAM.into()).unwrap();
    assert_eq!(exam.author, acc("author.testnet"));
    assert_eq!(exam.commitment, COMMIT);
    assert!(exam.active);
    assert!(get_logs().iter().any(|l| l.contains("exam_registered")));
}

#[test]
#[should_panic(expected = "commitment must be 64 lowercase hex characters")]
fn rejects_bad_commitment() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("x".into(), "X".into(), "not-a-hash".into(), 6000, "p".into());
}

#[test]
#[should_panic(expected = "exam_id is already registered")]
fn rejects_duplicate_exam() {
    let mut r = setup();
    set("other.testnet", NearToken::from_near(1), 300);
    r.register_exam(EXAM.into(), "Copy".into(), COMMIT.into(), 6000, "p".into());
}

#[test]
#[should_panic(expected = "pass_mark_bps must be at most 10000")]
fn rejects_pass_mark_over_100_percent() {
    let mut r = setup();
    set("author.testnet", NearToken::from_near(1), 300);
    r.register_exam("y".into(), "Y".into(), COMMIT.into(), 10_001, "p".into());
}

#[test]
fn sitting_calls_outlayer_with_public_input_only() {
    let mut r = setup();
    let id = sit(&mut r);
    assert_eq!(r.get_sitting(id).unwrap().candidate_model, MODEL);

    let receipts = get_created_receipts();
    let call = receipts
        .iter()
        .find(|rc| rc.receiver_id == acc("outlayer.testnet"))
        .expect("a receipt to OutLayer");
    let (method, args) = call
        .actions
        .iter()
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { method_name, args, .. } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                String::from_utf8(args.clone()).unwrap(),
            )),
            _ => None,
        })
        .expect("a function call action");
    assert_eq!(method, "request_execution");
    assert!(args.contains(MODEL));
    // The sitting input names the candidate; the exam never leaves OutLayer secrets.
    assert!(!args.contains("questions"));
}

#[test]
#[should_panic(expected = "attach at least")]
fn sitting_requires_minimum_deposit() {
    let mut r = setup();
    set("alice.testnet", NearToken::from_millinear(1), 300);
    let _ = r.sit_exam(EXAM.into(), MODEL.into());
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
#[should_panic(expected = "only the exam author can do this")]
fn only_author_can_deactivate_exam() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.set_exam_active(EXAM.into(), false);
}

#[test]
fn passing_sitting_issues_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 4, 5))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 8000 });

    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.candidate_model, MODEL);
    assert_eq!(cert.exam_commitment, COMMIT);
    assert_eq!(cert.runner_hash, RUNNER_HASH);
    assert_eq!(cert.status, CertStatus::Active);
    assert!(r.is_certified(MODEL.into(), EXAM.into()));
    assert!(r.get_sitting(id).is_none(), "pending sitting is cleared");
    assert_eq!(r.get_outcome(id), Some(outcome));
    assert_eq!(r.get_exam(EXAM.into()).unwrap().sittings, 1);
}

#[test]
fn failing_sitting_records_failure_without_certificate() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 2, 5))));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 4000 });
    assert!(r.get_certificate(0).is_none());
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn pass_mark_is_decided_by_registry_not_runner() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 1, 5);
    out["passed"] = json!(true); // a runner claiming a pass does not matter
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Failed { score_bps: 2000 });
}

#[test]
fn rejects_output_for_a_different_exam() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5, 5);
    out["exam_commitment"] = json!("2222222222222222222222222222222222222222222222222222222222222222");
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Rejected { reason: "exam commitment mismatch".into() });
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn rejects_output_for_a_different_candidate() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5, 5);
    out["candidate"]["model"] = json!("some/other-model");
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Rejected { reason: "candidate mismatch".into() });
}

#[test]
fn rejects_tampered_score() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 2, 5);
    out["score_bps"] = json!(10_000);
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Rejected { reason: "score does not match counts".into() });
}

#[test]
fn rejects_output_replayed_from_another_sitting() {
    let mut r = setup();
    let first = sit(&mut r);
    let second = sit(&mut r);
    let outcome = resolve(&mut r, second, Ok(Some(output(first, 5, 5))));
    assert_eq!(outcome, SittingOutcome::Rejected { reason: "request id mismatch".into() });
}

#[test]
fn malformed_output_is_rejected() {
    let mut r = setup();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(json!({ "hello": "world" }))));
    assert_eq!(outcome, SittingOutcome::Rejected { reason: "malformed runner output".into() });
}

#[test]
fn incomplete_sitting_is_neither_pass_nor_fail() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 3, 5);
    out["complete"] = json!(false);
    out["failed_calls"] = json!(2);
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(outcome, SittingOutcome::Incomplete { failed_calls: 2 });
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn failed_run_is_recorded() {
    let mut r = setup();
    let id = sit(&mut r);
    assert_eq!(resolve(&mut r, id, Ok(None)), SittingOutcome::RunnerFailed);
    let id2 = sit(&mut r);
    assert_eq!(resolve(&mut r, id2, Err(PromiseError::Failed)), SittingOutcome::RunnerFailed);
}

#[test]
#[should_panic(expected = "Method on_sitting_result is private")]
fn outsiders_cannot_forge_results() {
    let mut r = setup();
    let id = sit(&mut r);
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.on_sitting_result(id, Ok(Some(output(id, 5, 5))));
}

fn certified() -> Registry {
    let mut r = setup();
    let id = sit(&mut r);
    resolve(&mut r, id, Ok(Some(output(id, 5, 5))));
    r
}

fn start_retest(r: &mut Registry, cert_id: u64) -> u64 {
    set("anyone.testnet", NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.retest(cert_id);
    id
}

#[test]
fn passing_retest_reverifies_certificate() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 4, 5))));
    assert_eq!(outcome, SittingOutcome::RetestPassed { cert_id: 0, score_bps: 8000 });
    let cert = r.get_certificate(0).unwrap();
    assert_eq!(cert.retests_passed, 1);
    assert_eq!(cert.status, CertStatus::Active);
}

#[test]
fn failing_retest_revokes_certificate() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 1, 5))));
    assert_eq!(outcome, SittingOutcome::Revoked { cert_id: 0, score_bps: 2000 });
    let cert = r.get_certificate(0).unwrap();
    assert!(matches!(cert.status, CertStatus::Revoked { .. }));
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn outage_during_retest_does_not_revoke() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    let mut out = output(id, 0, 5);
    out["complete"] = json!(false);
    out["failed_calls"] = json!(5);
    assert_eq!(resolve(&mut r, id, Ok(Some(out))), SittingOutcome::Incomplete { failed_calls: 5 });
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);

    let id2 = start_retest(&mut r, 0);
    assert_eq!(resolve(&mut r, id2, Ok(None)), SittingOutcome::RunnerFailed);
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);
}

#[test]
#[should_panic(expected = "certificate is not active")]
fn revoked_certificate_cannot_be_retested() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    resolve(&mut r, id, Ok(Some(output(id, 0, 5))));
    start_retest(&mut r, 0);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_owner_can_change_runner() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.set_runner(json!({}), RUNNER_HASH.into());
}

#[test]
#[should_panic(expected = "OutLayer caps a run at 180 seconds")]
fn limits_respect_outlayer_cap() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.set_limits(1_000_000_000, 128, 181);
}
