//! In-place upgrade from the state layout before author payouts. Every
//! existing collection keeps its storage prefix, so exams, certificates,
//! sittings and outcomes are not touched; only the root record gains the
//! payout ledgers.

use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId};

use crate::admin::PendingRunner;
use crate::{Certificate, Exam, Registry, RegistryExt, Sitting, SittingOutcome, StorageKey};

/// The root record as the previous version stored it.
#[near(serializers = [borsh])]
pub(crate) struct RegistryBeforePayouts {
    pub(crate) owner: AccountId,
    pub(crate) outlayer_account: AccountId,
    pub(crate) runner_source_json: String,
    pub(crate) runner_hash: String,
    pub(crate) max_instructions: u64,
    pub(crate) max_memory_mb: u32,
    pub(crate) max_execution_seconds: u64,
    pub(crate) exams: IterableMap<String, Exam>,
    pub(crate) certificates: Vector<Certificate>,
    pub(crate) sittings: LookupMap<u64, Sitting>,
    pub(crate) outcomes: LookupMap<u64, SittingOutcome>,
    pub(crate) latest: LookupMap<String, u64>,
    pub(crate) next_sitting_id: u64,
    pub(crate) pending_runner: Option<PendingRunner>,
    pub(crate) pending_owner: Option<AccountId>,
}

#[near]
impl Registry {
    /// Run once, as the init call of the deploy that ships this version.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        // `#[private]` is enforced only in the wasm entry point; checked here too.
        require!(env::predecessor_account_id() == env::current_account_id(), "Method migrate is private");
        let old: RegistryBeforePayouts =
            env::state_read().unwrap_or_else(|| env::panic_str("no state from the previous version to migrate"));
        Self {
            owner: old.owner,
            outlayer_account: old.outlayer_account,
            runner_source_json: old.runner_source_json,
            runner_hash: old.runner_hash,
            max_instructions: old.max_instructions,
            max_memory_mb: old.max_memory_mb,
            max_execution_seconds: old.max_execution_seconds,
            exams: old.exams,
            certificates: old.certificates,
            sittings: old.sittings,
            outcomes: old.outcomes,
            latest: old.latest,
            next_sitting_id: old.next_sitting_id,
            pending_runner: old.pending_runner,
            pending_owner: old.pending_owner,
            exam_fees: LookupMap::new(StorageKey::ExamFees),
            held_fees: LookupMap::new(StorageKey::HeldFees),
            author_balances: LookupMap::new(StorageKey::AuthorBalances),
        }
    }
}
