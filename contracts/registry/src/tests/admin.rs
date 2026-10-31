//! Owner powers: limits, the runner timelock, and ownership transfer.

use super::*;

const DAY_NS: u64 = RUNNER_CHANGE_DELAY_NS;

fn propose(r: &mut Registry, hash: &str, at_ns: u64) {
    set_at("owner.testnet", NearToken::from_yoctonear(0), at_ns);
    r.propose_runner(runner_source(), hash.into());
}

fn apply_at(r: &mut Registry, at_ns: u64) {
    set_at("anyone.testnet", NearToken::from_yoctonear(0), at_ns);
    r.apply_runner();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_owner_can_propose_a_runner() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_runner(runner_source(), OTHER_HASH.into());
}

#[test]
#[should_panic(expected = "runner_source must be an OutLayer ExecutionSource object")]
fn runner_source_must_be_an_object() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_runner(Value::Null, OTHER_HASH.into());
}

#[test]
fn proposed_runner_is_public_and_not_yet_in_effect() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, HOUR_NS);
    let config = r.get_config();
    assert_eq!(config.runner_hash, RUNNER_HASH);
    let pending = config.pending_runner.unwrap();
    assert_eq!(pending.runner_hash, OTHER_HASH);
    assert_eq!(pending.effective_at_ns, HOUR_NS + DAY_NS);
    assert!(get_logs().iter().any(|l| l.contains("runner_proposed")));
}

#[test]
#[should_panic(expected = "the runner change is not in effect yet")]
fn runner_change_cannot_be_applied_early() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, 0);
    apply_at(&mut r, DAY_NS - 1);
}

#[test]
fn anyone_can_apply_a_runner_change_after_a_day() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, 0);
    apply_at(&mut r, DAY_NS);
    let config = r.get_config();
    assert_eq!(config.runner_hash, OTHER_HASH);
    assert!(config.pending_runner.is_none());
    assert!(get_logs().iter().any(|l| l.contains("runner_updated")));
    // New sittings use the new build.
    let id = sit(&mut r);
    assert_eq!(r.get_sitting(id).unwrap().runner_hash, OTHER_HASH);
}

#[test]
fn a_new_proposal_restarts_the_clock() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, 0);
    propose(&mut r, RUNNER_HASH, HOUR_NS);
    assert_eq!(r.get_config().pending_runner.unwrap().effective_at_ns, HOUR_NS + DAY_NS);
}

#[test]
#[should_panic(expected = "no runner change is pending")]
fn a_cancelled_runner_change_cannot_be_applied() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, 0);
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.cancel_runner();
    assert!(r.get_config().pending_runner.is_none());
    apply_at(&mut r, DAY_NS);
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_owner_can_cancel_a_runner_change() {
    let mut r = setup();
    propose(&mut r, OTHER_HASH, 0);
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.cancel_runner();
}

#[test]
fn certificate_records_the_runner_the_sitting_started_with() {
    let mut r = setup();
    let id = sit(&mut r);
    propose(&mut r, OTHER_HASH, 0);
    apply_at(&mut r, DAY_NS);
    resolve(&mut r, id, Ok(Some(output(id, 5))));
    assert_eq!(r.get_certificate(0).unwrap().runner_hash, RUNNER_HASH);
}

#[test]
fn ownership_moves_only_when_the_new_owner_accepts() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_owner(acc("next.testnet"));
    assert_eq!(r.get_config().owner, acc("owner.testnet"), "proposing does not hand over");
    assert_eq!(r.get_config().pending_owner, Some(acc("next.testnet")));

    set("next.testnet", NearToken::from_yoctonear(0), 300);
    r.accept_owner();
    let config = r.get_config();
    assert_eq!(config.owner, acc("next.testnet"));
    assert!(config.pending_owner.is_none());
    // The new owner holds the owner powers; the old one no longer does.
    r.propose_runner(runner_source(), OTHER_HASH.into());
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn previous_owner_loses_owner_powers() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_owner(acc("next.testnet"));
    set("next.testnet", NearToken::from_yoctonear(0), 300);
    r.accept_owner();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_runner(runner_source(), OTHER_HASH.into());
}

#[test]
#[should_panic(expected = "only the proposed owner can accept")]
fn nobody_else_can_accept_ownership() {
    let mut r = setup();
    set("owner.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_owner(acc("next.testnet"));
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.accept_owner();
}

#[test]
#[should_panic(expected = "only the owner can do this")]
fn only_owner_can_propose_a_new_owner() {
    let mut r = setup();
    set("mallory.testnet", NearToken::from_yoctonear(0), 300);
    r.propose_owner(acc("mallory.testnet"));
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
