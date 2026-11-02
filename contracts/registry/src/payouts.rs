//! Exam-author payouts. An author may charge a fee per first sitting (re-tests
//! are free). The fee is held with the sitting and goes to the author when
//! the sitting ends in a verdict, or when an agent's own endpoint left it
//! incomplete (the endpoint has already seen the questions); an outage, a
//! rejected output or a lost callback refunds it to whoever paid.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, Promise};

use crate::checks::{charge_storage, emit};
use crate::{Registry, RegistryExt, Sitting, SittingOutcome};

/// Gas for the withdrawal callback, which only records the outcome.
const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(5);

/// The most an author may charge for one sitting.
pub const MAX_EXAM_FEE: NearToken = NearToken::from_near(1);

#[near]
impl Registry {
    /// Sets the fee for new sittings of an exam; zero makes it free. Only the
    /// author may set it, and sittings already paid for keep their fee. Attach
    /// enough to store the fee (any excess is refunded).
    #[payable]
    pub fn set_exam_fee(&mut self, exam_id: String, fee: NearToken) {
        let author = env::predecessor_account_id();
        let exam = self.exams.get(&exam_id).unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(author == exam.author, "only the exam author can do this");
        require!(fee <= MAX_EXAM_FEE, format!("fee must be at most {MAX_EXAM_FEE}"));

        let storage_before = env::storage_usage();
        if fee.is_zero() {
            self.exam_fees.remove(&exam_id);
        } else {
            self.exam_fees.insert(exam_id.clone(), fee);
        }
        self.exam_fees.flush();
        charge_storage(storage_before, &author);
        emit("exam_fee_set", json!({ "exam_id": exam_id, "fee": fee }));
    }

    /// Pays the caller everything their exams have earned. Attach exactly one
    /// yoctoNEAR, so only a full-access key can move the money. The balance is
    /// cleared before the transfer and restored if the transfer fails.
    #[payable]
    pub fn withdraw_earnings(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        let author = env::predecessor_account_id();
        let amount = self.author_balances.remove(&author).unwrap_or_else(|| env::panic_str("no earnings to withdraw"));
        Promise::new(author.clone())
            .transfer(amount.saturating_add(NearToken::from_yoctonear(1)))
            .then(Self::ext(env::current_account_id()).with_static_gas(WITHDRAW_CALLBACK_GAS).on_withdrawn(author, amount))
    }

    /// Records a withdrawal's outcome; a failed transfer puts the earnings back.
    #[private]
    pub fn on_withdrawn(&mut self, author: AccountId, amount: NearToken) -> bool {
        require!(env::predecessor_account_id() == env::current_account_id(), "Method on_withdrawn is private");
        if env::promise_result_checked(0, 0).is_ok() {
            emit("earnings_withdrawn", json!({ "author": author, "amount": amount }));
            return true;
        }
        let balance = self.get_author_balance(author.clone()).saturating_add(amount);
        self.author_balances.insert(author.clone(), balance);
        emit("withdrawal_failed", json!({ "author": author, "amount": amount }));
        false
    }

    /// The fee a new sitting of `exam_id` must attach on top of the deposit.
    pub fn get_exam_fee(&self, exam_id: String) -> NearToken {
        self.exam_fee(&exam_id)
    }

    /// What `author` can withdraw now.
    pub fn get_author_balance(&self, author: AccountId) -> NearToken {
        self.author_balances.get(&author).copied().unwrap_or(NearToken::from_yoctonear(0))
    }
}

impl Registry {
    pub(crate) fn exam_fee(&self, exam_id: &str) -> NearToken {
        self.exam_fees.get(exam_id).copied().unwrap_or(NearToken::from_yoctonear(0))
    }

    /// Releases a sitting's held fee: to the author on a verdict or on an
    /// agent sitting its own endpoint left incomplete (the questions were
    /// asked, so failing calls must not make harvesting them free);
    /// otherwise back to the payer.
    pub(crate) fn settle_fee(&mut self, sitting: &Sitting, outcome: &SittingOutcome) {
        let Some(fee) = self.held_fees.remove(&sitting.sitting_id) else { return };
        let author = self.exams.get(&sitting.exam_id).map(|exam| exam.author.clone());
        let agent_left_incomplete = sitting.candidate_endpoint.is_some() && matches!(outcome, SittingOutcome::Incomplete { .. });
        match author {
            Some(author) if outcome.is_verdict() || agent_left_incomplete => {
                let balance = self.get_author_balance(author.clone()).saturating_add(fee);
                self.author_balances.insert(author.clone(), balance);
                emit("earnings_credited", json!({ "author": author, "sitting_id": sitting.sitting_id, "fee": fee }));
            }
            _ => {
                Promise::new(sitting.requested_by.clone()).transfer(fee).detach();
                emit("fee_refunded", json!({ "to": sitting.requested_by, "sitting_id": sitting.sitting_id, "fee": fee }));
            }
        }
    }
}
