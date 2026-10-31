//! The registry re-checks every runner output before acting on it.

use super::*;

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
