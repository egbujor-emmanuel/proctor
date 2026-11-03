//! Re-test integrity and abuse limits added after the security review:
//! failed runs cannot burn the re-test slot, silent agents take strikes,
//! agent sittings are the author's choice, and inputs are tightly bounded.

use super::agents::{agent_output, setup_agents, sit_agent, AGENT, ENDPOINT};
use super::*;

/// An agent certificate (cert 0) for alice's research-bot.
fn certified_agent() -> Registry {
    let mut r = setup_agents();
    let id = sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
    resolve(&mut r, id, Ok(Some(agent_output(id, 5, ENDPOINT))));
    r
}

/// An agent run where the endpoint failed `failed` of the questions.
fn silent_agent_output(sitting_id: u64, failed: u32) -> Value {
    let mut out = output_with(sitting_id, 0, QUESTIONS, failed);
    out["candidate"] = json!({ "model": AGENT, "endpoint": ENDPOINT });
    out
}

fn status(r: &Registry) -> CertStatus {
    r.get_certificate(0).unwrap().status
}

#[test]
fn a_re_test_that_judged_nothing_does_not_use_up_the_hourly_slot() {
    let mut r = certified();
    let first = start_retest_at(&mut r, 0, HOUR_NS);
    assert!(matches!(resolve(&mut r, first, Ok(Some(output_with(first, 0, QUESTIONS, 2)))), SittingOutcome::Incomplete { .. }));
    assert_eq!(r.get_certificate(0).unwrap().last_retest_requested_ns, None);
    // So anyone can re-test straight away, not an hour later.
    let again = start_retest_at(&mut r, 0, HOUR_NS + 1);
    assert_eq!(r.get_certificate(0).unwrap().retest_in_flight, Some(again));
}

#[test]
fn an_outage_also_gives_the_slot_back() {
    let mut r = certified();
    let first = start_retest_at(&mut r, 0, HOUR_NS);
    assert!(matches!(resolve(&mut r, first, Ok(None)), SittingOutcome::RunnerFailed { .. }));
    assert_eq!(r.get_certificate(0).unwrap().last_retest_requested_ns, None);
}

#[test]
#[should_panic(expected = "at least an hour apart")]
fn a_re_test_with_a_verdict_keeps_the_hourly_gap() {
    let mut r = certified();
    let first = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, first, Ok(Some(output(first, 5))));
    start_retest_at(&mut r, 0, HOUR_NS + 1);
}

#[test]
fn an_agent_that_goes_silent_on_its_re_tests_is_suspended_then_revoked() {
    let mut r = certified_agent();
    for round in 1..=6u64 {
        let id = start_retest_at(&mut r, 0, round * HOUR_NS);
        assert!(matches!(resolve(&mut r, id, Ok(Some(silent_agent_output(id, QUESTIONS)))), SittingOutcome::Incomplete { .. }));
        match round {
            1 | 2 => assert_eq!(status(&r), CertStatus::Active),
            3..=5 => assert!(matches!(status(&r), CertStatus::Suspended { ref reason, .. } if reason.contains("left 3 re-tests in a row incomplete"))),
            _ => assert!(matches!(status(&r), CertStatus::Revoked { .. })),
        }
    }
    assert!(get_logs().iter().any(|l| l.contains("silent_strike")));
}

#[test]
#[should_panic(expected = "at least an hour apart")]
fn an_agents_silent_re_test_keeps_the_hourly_gap() {
    // Otherwise a third party could stack strikes during one outage of the endpoint.
    let mut r = certified_agent();
    let id = start_retest_at(&mut r, 0, HOUR_NS);
    resolve(&mut r, id, Ok(Some(silent_agent_output(id, QUESTIONS))));
    start_retest_at(&mut r, 0, HOUR_NS + 1);
}

#[test]
fn a_verdict_resets_the_silence_count() {
    let mut r = certified_agent();
    let mut at = HOUR_NS;
    for _ in 0..2 {
        let id = start_retest_at(&mut r, 0, at);
        resolve(&mut r, id, Ok(Some(silent_agent_output(id, 1))));
        at += HOUR_NS;
    }
    let pass = start_retest_at(&mut r, 0, at);
    resolve(&mut r, pass, Ok(Some(agent_output(pass, 5, ENDPOINT))));
    for _ in 0..2 {
        at += HOUR_NS;
        let id = start_retest_at(&mut r, 0, at);
        resolve(&mut r, id, Ok(Some(silent_agent_output(id, 1))));
    }
    assert_eq!(status(&r), CertStatus::Active);
}

#[test]
fn a_model_candidate_is_never_struck_for_outages() {
    let mut r = certified();
    for round in 1..=4u64 {
        let id = start_retest_at(&mut r, 0, round * HOUR_NS);
        resolve(&mut r, id, Ok(Some(output_with(id, 0, QUESTIONS, QUESTIONS))));
    }
    assert_eq!(status(&r), CertStatus::Active);
}

#[test]
#[should_panic(expected = "this exam does not accept agent endpoints")]
fn agents_need_the_authors_permission() {
    let mut r = setup();
    sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
}

#[test]
fn the_author_can_allow_and_disallow_agents() {
    let mut r = setup();
    assert!(!r.exam_accepts_agents(EXAM.into()));
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_agents(EXAM.into(), true);
    assert!(r.exam_accepts_agents(EXAM.into()));
    r.set_exam_agents(EXAM.into(), false);
    assert!(!r.exam_accepts_agents(EXAM.into()));
}

#[test]
#[should_panic(expected = "only the exam author can do this")]
fn only_the_author_decides_about_agents() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_agents(EXAM.into(), true);
}

#[test]
fn an_agent_that_leaves_its_paid_sitting_incomplete_still_pays_the_author() {
    let mut r = setup_agents();
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_fee(EXAM.into(), NearToken::from_millinear(20));
    set("alice.testnet", NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam_as_agent(EXAM.into(), "research-bot".into(), ENDPOINT.into(), None);
    assert!(matches!(resolve(&mut r, id, Ok(Some(silent_agent_output(id, QUESTIONS)))), SittingOutcome::Incomplete { .. }));
    // The endpoint saw the questions, so failing them is not a free harvest.
    assert_eq!(r.get_author_balance(acc("author.testnet")), NearToken::from_millinear(20));
    assert!(!transfers_to("alice.testnet").contains(&NearToken::from_millinear(20)));
}

#[test]
#[should_panic(expected = "agent: ids are issued only by sit_exam_as_agent")]
fn nobody_can_sit_a_model_under_an_agent_id() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_millinear(100), 300);
    let _ = r.sit_exam(EXAM.into(), "agent:victim.testnet/bot".into(), None);
}

#[test]
fn endpoints_must_be_public_https_hosts() {
    for bad in [
        "https://127.0.0.1/v1/chat/completions",
        "https://localhost/v1",
        "https://agent.example.org:8443/v1",
        "https://user@agent.example.org/v1",
        "https://agent.example.org/v1#frag",
        "https://agent.example.org/v1?x=1",
        "https://intranet/v1",
        "https://[::1]/v1",
        "https://cloud-api.near.ai/v1/files",
        "http://agent.example.org/v1",
        // Encodings a URL parser would resolve to another host.
        "https://%31%32%37.0.0.1/v1",
        "https://0x7f.1/v1",
        "https://10.0.0.1/v1",
        "https://cloud\u{2010}api.near.ai/v1/chat/completions",
        "https://agent.example.1/v1",
    ] {
        let result = std::panic::catch_unwind(|| checks::require_endpoint(bad));
        assert!(result.is_err(), "{bad} should be refused");
    }
    checks::require_endpoint("https://agent.example.org/v1/chat/completions");
    checks::require_endpoint(checks::NEAR_AI_COMPLETIONS);
}

#[test]
fn response_ids_must_be_printable_without_spaces() {
    let mut r = setup();
    let id = sit(&mut r);
    let mut out = output(id, 5);
    out["response_ids"][0] = json!("chatcmpl-a\nb");
    assert_eq!(rejected_reason(&resolve(&mut r, id, Ok(Some(out)))), "response ids must be printable ASCII without spaces");
}

/// Delivers the transfer's result to the withdrawal callback.
fn finish_withdrawal(r: &mut Registry, result: PromiseResult, amount: NearToken) -> bool {
    testing_env!(
        ctx("registry.testnet", NearToken::from_yoctonear(0), 300, 0).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
    r.on_withdrawn(acc("author.testnet"), amount)
}

#[test]
fn a_failed_withdrawal_puts_the_earnings_back() {
    let mut r = setup();
    let amount = NearToken::from_millinear(20);
    assert!(!finish_withdrawal(&mut r, PromiseResult::Failed, amount));
    assert_eq!(r.get_author_balance(acc("author.testnet")), amount);
    assert!(get_logs().iter().any(|l| l.contains("withdrawal_failed")));
}

#[test]
fn a_successful_withdrawal_is_recorded_once_it_lands() {
    let mut r = setup();
    assert!(finish_withdrawal(&mut r, PromiseResult::Successful(vec![]), NearToken::from_millinear(20)));
    assert_eq!(r.get_author_balance(acc("author.testnet")), NearToken::from_yoctonear(0));
    assert!(get_logs().iter().any(|l| l.contains("earnings_withdrawn")));
}

#[test]
#[should_panic(expected = "Method on_withdrawn is private")]
fn only_the_contract_records_withdrawals() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.on_withdrawn(acc("mallory.testnet"), NearToken::from_near(1));
}
