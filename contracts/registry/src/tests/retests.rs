//! Re-tests, two strikes before revocation, and expiring stuck sittings.

use super::*;

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
fn first_failed_retest_suspends_the_certificate() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 1))));
    assert_eq!(outcome, SittingOutcome::Suspended { cert_id: 0, score_bps: 2000 });
    let cert = r.get_certificate(0).unwrap();
    assert!(matches!(cert.status, CertStatus::Suspended { .. }));
    assert!(!r.is_certified(MODEL.into(), EXAM.into()), "a suspended candidate is not certified");
}

#[test]
fn second_failed_retest_in_a_row_revokes() {
    let mut r = certified();
    let id = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, id, Ok(Some(output(id, 1))));
    let id = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 2))));
    assert_eq!(outcome, SittingOutcome::Revoked { cert_id: 0, score_bps: 4000 });
    assert!(matches!(r.get_certificate(0).unwrap().status, CertStatus::Revoked { .. }));
    assert!(!r.is_certified(MODEL.into(), EXAM.into()));
}

#[test]
fn passing_retest_restores_a_suspended_certificate() {
    let mut r = certified();
    let id = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, id, Ok(Some(output(id, 1))));
    let id = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 4))));
    assert_eq!(outcome, SittingOutcome::RetestPassed { cert_id: 0, score_bps: 8000 });
    assert_eq!(r.get_certificate(0).unwrap().status, CertStatus::Active);
    assert!(r.is_certified(MODEL.into(), EXAM.into()));
    // The strike is cleared: the next failure suspends again rather than revoking.
    let id = start_retest_at(&mut r, 0, 3 * HOUR_NS);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 0))));
    assert_eq!(outcome, SittingOutcome::Suspended { cert_id: 0, score_bps: 0 });
}

#[test]
fn outages_while_suspended_neither_restore_nor_revoke() {
    let mut r = certified();
    let id = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, id, Ok(Some(output(id, 1))));
    let id = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    resolve(&mut r, id, Ok(Some(output_with(id, 0, QUESTIONS, 2))));
    let id = start_retest_at(&mut r, 0, 3 * HOUR_NS);
    resolve(&mut r, id, Ok(None));
    assert!(matches!(r.get_certificate(0).unwrap().status, CertStatus::Suspended { .. }));
}

#[test]
#[should_panic(expected = "candidate already holds a certificate for this exam")]
fn suspended_candidate_cannot_start_over_with_a_fresh_sitting() {
    let mut r = certified();
    let id = start_retest(&mut r, 0);
    resolve(&mut r, id, Ok(Some(output(id, 1))));
    sit(&mut r);
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

fn revoked() -> Registry {
    let mut r = certified();
    let id = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, id, Ok(Some(output(id, 0))));
    let id = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    resolve(&mut r, id, Ok(Some(output(id, 0))));
    r
}

#[test]
#[should_panic(expected = "certificate is revoked")]
fn revoked_certificate_cannot_be_retested() {
    let mut r = revoked();
    start_retest_at(&mut r, 0, 5 * HOUR_NS);
}

#[test]
fn a_revoked_candidate_may_sit_the_exam_again() {
    let mut r = revoked();
    let id = sit(&mut r);
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 1, score_bps: 10_000 });
    assert_eq!(r.latest_certificate(MODEL.into(), EXAM.into()).unwrap().cert_id, 1);
    assert!(matches!(r.get_certificate(0).unwrap().status, CertStatus::Revoked { .. }));
}



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
