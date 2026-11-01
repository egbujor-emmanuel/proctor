//! Owner powers: OutLayer limits, the exam-runner build, and ownership.
//!
//! The runner build decides every score, so the owner cannot swap it
//! silently: a new build is announced on chain and takes effect only after
//! `RUNNER_CHANGE_DELAY_NS`, giving certificate holders and exam authors a
//! day to see it coming. Ownership moves in two steps so a typo cannot lose it.

use super::*;

/// How long a proposed runner build waits before anyone may apply it.
pub(crate) const RUNNER_CHANGE_DELAY_NS: u64 = 24 * 60 * NS_PER_MINUTE;

/// A runner build announced by the owner and not yet in effect.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingRunner {
    /// OutLayer `ExecutionSource`, as JSON text.
    pub runner_source: String,
    pub runner_hash: String,
    pub proposed_at_ns: u64,
    pub effective_at_ns: u64,
}

#[near]
impl Registry {
    /// Announces a new runner build. It can be applied by anyone once
    /// `RUNNER_CHANGE_DELAY_NS` has passed; a new proposal restarts the clock.
    pub fn propose_runner(&mut self, runner_source: Value, runner_hash: String) {
        self.assert_owner();
        require_runner_source(&runner_source, &runner_hash);
        let now = env::block_timestamp();
        let effective_at_ns = now.saturating_add(RUNNER_CHANGE_DELAY_NS);
        self.pending_runner = Some(PendingRunner {
            runner_source: runner_source.to_string(),
            runner_hash: runner_hash.clone(),
            proposed_at_ns: now,
            effective_at_ns,
        });
        emit("runner_proposed", json!({ "runner_hash": runner_hash, "effective_at_ns": effective_at_ns }));
    }

    /// Withdraws a proposed runner build before it takes effect.
    pub fn cancel_runner(&mut self) {
        self.assert_owner();
        let pending = self.pending_runner.take().unwrap_or_else(|| env::panic_str("no runner change is pending"));
        emit("runner_cancelled", json!({ "runner_hash": pending.runner_hash }));
    }

    /// Puts a proposed runner build into effect once its delay has passed.
    /// Anyone may call it. Sittings already paid for, and the certificates
    /// they produce, keep the runner they started with.
    pub fn apply_runner(&mut self) {
        let pending = self.pending_runner.clone().unwrap_or_else(|| env::panic_str("no runner change is pending"));
        require!(
            env::block_timestamp() >= pending.effective_at_ns,
            "the runner change is not in effect yet; it waits 24 hours after it is proposed"
        );
        self.pending_runner = None;
        self.runner_source_json = pending.runner_source;
        self.runner_hash = pending.runner_hash.clone();
        emit("runner_updated", json!({ "runner_hash": pending.runner_hash }));
    }

    /// First step of handing over the contract: names the next owner.
    pub fn propose_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.pending_owner = Some(new_owner.clone());
        emit("owner_proposed", json!({ "owner": self.owner, "proposed": new_owner }));
    }

    /// Second step: the proposed owner accepts, and only then becomes owner.
    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "only the proposed owner can accept");
        let previous = std::mem::replace(&mut self.owner, caller.clone());
        self.pending_owner = None;
        emit("owner_changed", json!({ "previous": previous, "owner": caller }));
    }

    /// Sets the OutLayer resource limits for future sittings, within floors
    /// that let an exam finish and OutLayer's own caps.
    pub fn set_limits(&mut self, max_instructions: u64, max_memory_mb: u32, max_execution_seconds: u64) {
        self.assert_owner();
        require!(
            (MIN_INSTRUCTIONS..=MAX_INSTRUCTIONS).contains(&max_instructions),
            format!("max_instructions must be between {MIN_INSTRUCTIONS} and {MAX_INSTRUCTIONS}")
        );
        require!(
            (MIN_MEMORY_MB..=MAX_MEMORY_MB).contains(&max_memory_mb),
            format!("max_memory_mb must be between {MIN_MEMORY_MB} and {MAX_MEMORY_MB}")
        );
        require!(max_execution_seconds <= MAX_EXECUTION_SECONDS, "OutLayer caps a run at 180 seconds");
        require!(
            max_execution_seconds >= MIN_EXECUTION_SECONDS,
            format!("max_execution_seconds must be at least {MIN_EXECUTION_SECONDS}")
        );
        self.max_instructions = max_instructions;
        self.max_memory_mb = max_memory_mb;
        self.max_execution_seconds = max_execution_seconds;
        emit(
            "limits_updated",
            json!({ "max_instructions": max_instructions, "max_memory_mb": max_memory_mb, "max_execution_seconds": max_execution_seconds }),
        );
    }
}

impl Registry {
    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }
}
