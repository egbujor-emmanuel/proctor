//! Exam-author payouts. An author may charge a fee per sitting. The fee is
//! held with the sitting and goes to the author only when the sitting ends in
//! a verdict; an outage, an incomplete run or a rejected output refunds it to
//! whoever paid, just as such runs never fail a candidate.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::checks::emit;
use crate::{Registry, RegistryExt, Sitting, SittingOutcome};

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
        let used = env::storage_usage().saturating_sub(storage_before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {cost} to cover storage"));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(author).transfer(refund).detach();
        }
        emit("exam_fee_set", json!({ "exam_id": exam_id, "fee": fee }));
    }

    /// Pays the caller everything their exams have earned. Attach exactly one
    /// yoctoNEAR, so only a full-access key can move the money.
    #[payable]
    pub fn withdraw_earnings(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        let author = env::predecessor_account_id();
        // The balance is cleared before the transfer is scheduled.
        let amount = self.author_balances.remove(&author).unwrap_or_else(|| env::panic_str("no earnings to withdraw"));
        emit("earnings_withdrawn", json!({ "author": author, "amount": amount }));
        Promise::new(author).transfer(amount.saturating_add(NearToken::from_yoctonear(1)))
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

    /// Releases a sitting's held fee: to the author on a verdict, otherwise
    /// back to the payer.
    pub(crate) fn settle_fee(&mut self, sitting: &Sitting, outcome: &SittingOutcome) {
        let Some(fee) = self.held_fees.remove(&sitting.sitting_id) else { return };
        let author = self.exams.get(&sitting.exam_id).map(|exam| exam.author.clone());
        let is_verdict = matches!(
            outcome,
            SittingOutcome::Certified { .. }
                | SittingOutcome::Failed { .. }
                | SittingOutcome::RetestPassed { .. }
                | SittingOutcome::Suspended { .. }
                | SittingOutcome::Revoked { .. }
        );
        match author {
            Some(author) if is_verdict => {
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
