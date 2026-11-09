use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseError};

use super::*;

const MINUTE_NS: u64 = 60_000_000_000;

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

fn ctx(predecessor: &str, deposit: NearToken, now_ns: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("escrow.testnet"))
        .predecessor_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .block_timestamp(now_ns)
        .build());
}

fn escrow() -> Escrow {
    ctx("deployer.testnet", NearToken::from_near(0), 0);
    Escrow::new(acc("registry.testnet"))
}

/// A job for alice.testnet's agent, made by bob.testnet with 1 NEAR, due in 60 minutes.
fn with_job() -> (Escrow, U64) {
    let mut e = escrow();
    ctx("bob.testnet", NearToken::from_near(1), 0);
    let id = e.create_job("agent:alice.testnet/helper".into(), "near-reasoning-pool-v1".into(), 60);
    (e, id)
}

fn state(e: &Escrow, id: U64) -> JobState {
    e.get_job(id).unwrap().state
}

#[test]
fn a_job_records_the_buyer_the_owner_and_the_deadline() {
    let (e, id) = with_job();
    let job = e.get_job(id).unwrap();
    assert_eq!(job.buyer, acc("bob.testnet"));
    assert_eq!(job.payee, acc("alice.testnet"));
    assert_eq!(job.amount, NearToken::from_near(1));
    assert_eq!(job.deadline_ns.0, 60 * MINUTE_NS);
    assert_eq!(job.state, JobState::Open);
    assert_eq!(e.jobs_created().0, 1);
}

#[test]
fn a_live_certificate_at_delivery_pays_the_owner() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.deliver(id);
    assert_eq!(state(&e, id), JobState::Checking);
    ctx("escrow.testnet", NearToken::from_near(0), MINUTE_NS);
    assert!(e.on_checked(id, Ok(true)));
    assert_eq!(state(&e, id), JobState::Paid);
}

#[test]
fn a_certificate_that_is_no_longer_live_refunds_the_buyer() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.deliver(id);
    ctx("escrow.testnet", NearToken::from_near(0), MINUTE_NS);
    assert!(!e.on_checked(id, Ok(false)));
    assert_eq!(state(&e, id), JobState::Refunded);
}

#[test]
fn a_failed_registry_call_reopens_the_job_instead_of_locking_funds() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.deliver(id);
    ctx("escrow.testnet", NearToken::from_near(0), MINUTE_NS);
    assert!(!e.on_checked(id, Err(PromiseError::Failed)));
    assert_eq!(state(&e, id), JobState::Open);
    // The owner can deliver again.
    ctx("alice.testnet", NearToken::from_near(0), 2 * MINUTE_NS);
    let _ = e.deliver(id);
    assert_eq!(state(&e, id), JobState::Checking);
}

#[test]
#[should_panic(expected = "only the agent's owner can deliver")]
fn nobody_but_the_agents_owner_can_deliver() {
    let (mut e, id) = with_job();
    ctx("mallory.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.deliver(id);
}

#[test]
#[should_panic(expected = "this job is not open")]
fn a_job_cannot_be_delivered_twice() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.deliver(id);
    let _ = e.deliver(id);
}

#[test]
#[should_panic(expected = "the deadline has passed")]
fn late_delivery_is_refused() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), 61 * MINUTE_NS);
    let _ = e.deliver(id);
}

#[test]
fn the_buyer_takes_back_an_undelivered_job_after_the_deadline() {
    let (mut e, id) = with_job();
    ctx("bob.testnet", NearToken::from_near(0), 61 * MINUTE_NS);
    let _ = e.cancel(id);
    assert_eq!(state(&e, id), JobState::Cancelled);
}

#[test]
#[should_panic(expected = "the deadline has not passed")]
fn the_buyer_cannot_cancel_before_the_deadline() {
    let (mut e, id) = with_job();
    ctx("bob.testnet", NearToken::from_near(0), MINUTE_NS);
    let _ = e.cancel(id);
}

#[test]
#[should_panic(expected = "only the buyer can cancel")]
fn only_the_buyer_can_cancel() {
    let (mut e, id) = with_job();
    ctx("alice.testnet", NearToken::from_near(0), 61 * MINUTE_NS);
    let _ = e.cancel(id);
}

#[test]
#[should_panic(expected = "this job is not being checked")]
fn a_stray_callback_changes_nothing() {
    let (mut e, id) = with_job();
    ctx("escrow.testnet", NearToken::from_near(0), MINUTE_NS);
    e.on_checked(id, Ok(true));
}

#[test]
fn agent_ids_must_name_their_owner() {
    for bad in ["alice.testnet/helper", "agent:alice.testnet", "agent:alice.testnet/", "agent:alice.testnet/a/b", "agent:NOT VALID/helper"] {
        let result = std::panic::catch_unwind(|| {
            let mut e = escrow();
            ctx("bob.testnet", NearToken::from_near(1), 0);
            e.create_job(bad.into(), "exam".into(), 60);
        });
        assert!(result.is_err(), "{bad} should be refused");
    }
}

#[test]
#[should_panic(expected = "attach at least 0.01 NEAR")]
fn a_job_needs_real_funds() {
    let mut e = escrow();
    ctx("bob.testnet", NearToken::from_yoctonear(1), 0);
    e.create_job("agent:alice.testnet/helper".into(), "exam".into(), 60);
}

#[test]
#[should_panic(expected = "deadline must be 1 minute to 30 days")]
fn deadlines_are_bounded() {
    let mut e = escrow();
    ctx("bob.testnet", NearToken::from_near(1), 0);
    e.create_job("agent:alice.testnet/helper".into(), "exam".into(), 0);
}
