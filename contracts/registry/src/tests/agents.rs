//! Agents sitting through their own endpoint: owner-bound ids, the endpoint
//! on record, and re-tests that ask the same endpoint.

use super::*;

pub(super) const ENDPOINT: &str = "https://agent.example.org/v1/chat/completions";
pub(super) const AGENT: &str = "agent:alice.testnet/research-bot";

/// A registry whose exam author lets agents sit through their own endpoints.
pub(super) fn setup_agents() -> Registry {
    let mut r = setup();
    set("author.testnet", NearToken::from_millinear(10), 300);
    r.set_exam_agents(EXAM.into(), true);
    r
}

pub(super) fn sit_agent(r: &mut Registry, caller: &str, name: &str, endpoint: &str) -> u64 {
    set(caller, NearToken::from_millinear(100), 300);
    let id = r.get_config().next_sitting_id;
    let _ = r.sit_exam_as_agent(EXAM.into(), name.into(), endpoint.into(), None);
    id
}

/// A runner output for an agent candidate, answered from `endpoint`.
pub(super) fn agent_output(sitting_id: u64, correct: u32, endpoint: &str) -> Value {
    let mut out = output_with(sitting_id, correct, QUESTIONS, 0);
    out["candidate"] = json!({ "model": AGENT, "endpoint": endpoint });
    out
}

/// The `input_data` of the most recent request to OutLayer.
fn last_runner_input() -> Value {
    let receipts = get_created_receipts();
    let args = receipts
        .iter()
        .filter(|rc| rc.receiver_id == acc("outlayer.testnet"))
        .flat_map(|rc| rc.actions.iter())
        .find_map(|a| match a {
            MockAction::FunctionCallWeight { args, .. } => Some(String::from_utf8(args.clone()).unwrap()),
            _ => None,
        })
        .expect("a request to OutLayer");
    let args: Value = serde_json::from_str(&args).unwrap();
    serde_json::from_str(args["input_data"].as_str().unwrap()).unwrap()
}

#[test]
fn an_agent_is_named_after_the_account_that_registers_it() {
    let mut r = setup_agents();
    let id = sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
    let sitting = r.get_sitting(id).unwrap();
    assert_eq!(sitting.candidate_model, AGENT);
    assert_eq!(sitting.candidate_endpoint.as_deref(), Some(ENDPOINT));
    // The runner is told which endpoint to ask.
    assert_eq!(
        last_runner_input(),
        json!({ "request_id": format!("sitting-{id}"), "candidate": { "model": AGENT, "endpoint": ENDPOINT } })
    );
}

#[test]
fn nobody_can_certify_an_agent_under_someone_elses_account() {
    let mut r = setup_agents();
    // Mallory picks the same name; the id is still hers, not Alice's.
    let id = sit_agent(&mut r, "mallory.testnet", "research-bot", ENDPOINT);
    assert_eq!(r.get_sitting(id).unwrap().candidate_model, "agent:mallory.testnet/research-bot");
}

#[test]
fn the_certificate_records_the_endpoint_and_retests_ask_it_again() {
    let mut r = setup_agents();
    let id = sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
    let outcome = resolve(&mut r, id, Ok(Some(agent_output(id, 5, ENDPOINT))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 10_000 });
    assert_eq!(r.get_certificate(0).unwrap().candidate_endpoint.as_deref(), Some(ENDPOINT));
    assert!(r.is_certified(AGENT.into(), EXAM.into()));

    // Anyone may pay for the re-test; it goes to the endpoint on record.
    let retest = start_retest(&mut r, 0);
    assert_eq!(last_runner_input()["candidate"], json!({ "model": AGENT, "endpoint": ENDPOINT }));
    assert_eq!(r.get_sitting(retest).unwrap().candidate_endpoint.as_deref(), Some(ENDPOINT));
}

#[test]
fn an_answer_from_another_endpoint_is_rejected() {
    let mut r = setup_agents();
    let id = sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
    let out = agent_output(id, 5, "https://stronger-model.example.org/v1/chat/completions");
    let outcome = resolve(&mut r, id, Ok(Some(out)));
    assert_eq!(rejected_reason(&outcome), "candidate endpoint mismatch");
    assert!(r.get_certificate(0).is_none());
}

#[test]
fn a_degraded_agent_is_caught_by_its_retests() {
    let mut r = setup_agents();
    let id = sit_agent(&mut r, "alice.testnet", "research-bot", ENDPOINT);
    resolve(&mut r, id, Ok(Some(agent_output(id, 5, ENDPOINT))));
    // The agent quietly swaps in a weaker model behind the same endpoint.
    let first = start_retest_at(&mut r, 0, HOUR_NS);
    assert_eq!(resolve(&mut r, first, Ok(Some(agent_output(first, 1, ENDPOINT)))), SittingOutcome::Suspended { cert_id: 0, score_bps: 2000 });
    let second = start_retest_at(&mut r, 0, 2 * HOUR_NS);
    assert_eq!(resolve(&mut r, second, Ok(Some(agent_output(second, 1, ENDPOINT)))), SittingOutcome::Revoked { cert_id: 0, score_bps: 2000 });
    assert!(!r.is_certified(AGENT.into(), EXAM.into()));
}

#[test]
#[should_panic(expected = "endpoint must be an https:// URL")]
fn an_agent_endpoint_must_be_https() {
    let mut r = setup_agents();
    sit_agent(&mut r, "alice.testnet", "research-bot", "http://agent.example.org/v1/chat/completions");
}

#[test]
#[should_panic(expected = "endpoint is longer than 256 bytes")]
fn an_agent_endpoint_is_bounded() {
    let mut r = setup_agents();
    let long = format!("https://{}.example.org/", "a".repeat(250));
    sit_agent(&mut r, "alice.testnet", "research-bot", &long);
}

#[test]
#[should_panic(expected = "name must not contain /")]
fn an_agent_name_cannot_fake_an_owner() {
    let mut r = setup_agents();
    sit_agent(&mut r, "mallory.testnet", "alice.testnet/research-bot", ENDPOINT);
}

#[test]
fn model_sittings_still_ignore_the_endpoint_the_runner_reports() {
    let mut r = setup_agents();
    let id = sit(&mut r);
    assert_eq!(r.get_sitting(id).unwrap().candidate_endpoint, None);
    // The runner reports the NEAR AI gateway for model sittings; that is fine.
    let outcome = resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(outcome, SittingOutcome::Certified { cert_id: 0, score_bps: 10_000 });
}
