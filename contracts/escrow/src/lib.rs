//! Certified-only escrow for agent work.
//!
//! A buyer locks NEAR for a job given to an agent (`agent:<owner>/<name>`) on a
//! named PROCTOR exam. When the owner delivers, this contract asks the PROCTOR
//! registry, on chain, whether that agent's certificate is live right now. If
//! it is, the owner is paid; if it was suspended or revoked since the job was
//! made, the buyer is refunded. Only the agent's owner can deliver, so nobody
//! can collect on a certificate they do not hold. A buyer can take back an
//! undelivered job after its deadline.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// Gas for the registry's `is_certified` view and for the callback that pays.
const CHECK_GAS: Gas = Gas::from_tgas(10);
const CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// A job pays out at most this long after it is made (30 days).
const MAX_DEADLINE_MINUTES: u32 = 30 * 24 * 60;
/// The smallest job worth locking; below this the payout costs more than it carries.
const MIN_AMOUNT: NearToken = NearToken::from_millinear(10);
const MAX_ID_LEN: usize = 128;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    /// Funded, waiting for the agent's owner to deliver.
    Open,
    /// Delivered; the registry is being asked whether the certificate is live.
    Checking,
    /// The certificate was live at delivery; the owner was paid.
    Paid,
    /// The certificate was not live at delivery; the buyer was refunded.
    Refunded,
    /// Not delivered by the deadline; the buyer took the funds back.
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Job {
    pub job_id: U64,
    pub buyer: AccountId,
    /// The PROCTOR candidate id, `agent:<owner>/<name>`.
    pub agent: String,
    /// The agent's owner: the only account that can deliver and be paid.
    pub payee: AccountId,
    pub exam_id: String,
    pub amount: NearToken,
    pub deadline_ns: U64,
    pub state: JobState,
}

#[ext_contract(ext_registry)]
pub trait Registry {
    fn is_certified(&self, candidate_model: String, exam_id: String) -> bool;
}

#[ext_contract(ext_self)]
pub trait EscrowCallbacks {
    fn on_checked(&mut self, job_id: U64) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    registry: AccountId,
    jobs: LookupMap<u64, Job>,
    next_job_id: u64,
}

/// NEP-297 event, standard "proctor-escrow".
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "proctor-escrow", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

/// The owner account in `agent:<owner>/<name>`, as the registry issues agent ids.
fn agent_owner(agent: &str) -> AccountId {
    require!(agent.len() <= MAX_ID_LEN, "agent id is too long");
    let rest = agent.strip_prefix("agent:").unwrap_or_else(|| env::panic_str("agent must be agent:<owner>/<name>"));
    let (owner, name) = rest.split_once('/').unwrap_or_else(|| env::panic_str("agent must be agent:<owner>/<name>"));
    require!(!name.is_empty() && !name.contains('/'), "agent must be agent:<owner>/<name>");
    owner.parse().unwrap_or_else(|_| env::panic_str("agent owner is not a valid account"))
}

#[near]
impl Escrow {
    #[init]
    pub fn new(registry: AccountId) -> Self {
        Self { registry, jobs: LookupMap::new(b"j"), next_job_id: 0 }
    }

    /// Locks the attached NEAR for a job given to `agent` on `exam_id`.
    #[payable]
    pub fn create_job(&mut self, agent: String, exam_id: String, deadline_minutes: u32) -> U64 {
        let amount = env::attached_deposit();
        require!(amount >= MIN_AMOUNT, "attach at least 0.01 NEAR");
        require!(!exam_id.is_empty() && exam_id.len() <= MAX_ID_LEN, "exam_id must be 1 to 128 bytes");
        require!((1..=MAX_DEADLINE_MINUTES).contains(&deadline_minutes), "deadline must be 1 minute to 30 days");
        let payee = agent_owner(&agent);
        let job_id = self.next_job_id;
        self.next_job_id += 1;
        let deadline_ns = env::block_timestamp() + u64::from(deadline_minutes) * 60_000_000_000;
        let job = Job {
            job_id: U64(job_id),
            buyer: env::predecessor_account_id(),
            agent,
            payee,
            exam_id,
            amount,
            deadline_ns: U64(deadline_ns),
            state: JobState::Open,
        };
        emit("job_created", json!({ "job_id": U64(job_id), "buyer": job.buyer, "agent": job.agent, "exam_id": job.exam_id, "amount": job.amount, "deadline_ns": job.deadline_ns }));
        self.jobs.insert(job_id, job);
        U64(job_id)
    }

    /// The agent's owner delivers; payment then depends on the certificate.
    pub fn deliver(&mut self, job_id: U64) -> Promise {
        let mut job = self.job(job_id.0);
        require!(env::predecessor_account_id() == job.payee, "only the agent's owner can deliver");
        require!(job.state == JobState::Open, "this job is not open");
        require!(env::block_timestamp() <= job.deadline_ns.0, "the deadline has passed");
        // Set before the cross-contract call, so the job cannot be delivered twice.
        job.state = JobState::Checking;
        let (agent, exam_id) = (job.agent.clone(), job.exam_id.clone());
        self.jobs.insert(job_id.0, job);
        emit("delivered", json!({ "job_id": job_id }));
        ext_registry::ext(self.registry.clone())
            .with_static_gas(CHECK_GAS)
            .is_certified(agent, exam_id)
            .then(ext_self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_checked(job_id))
    }

    /// Pays the owner if the certificate was live, refunds the buyer if not.
    /// If the registry could not be asked, the job is open again.
    #[private]
    pub fn on_checked(&mut self, job_id: U64, #[callback_result] certified: Result<bool, PromiseError>) -> bool {
        let mut job = self.job(job_id.0);
        require!(job.state == JobState::Checking, "this job is not being checked");
        match certified {
            Ok(true) => {
                job.state = JobState::Paid;
                emit("paid", json!({ "job_id": job_id, "payee": job.payee, "amount": job.amount }));
                // Scheduled when dropped; the callback's return value is the verdict.
                let _ = Promise::new(job.payee.clone()).transfer(job.amount);
            }
            Ok(false) => {
                job.state = JobState::Refunded;
                emit("refunded", json!({ "job_id": job_id, "buyer": job.buyer, "amount": job.amount, "reason": "the agent's certificate was not live at delivery" }));
                // Scheduled when dropped; the callback's return value is the verdict.
                let _ = Promise::new(job.buyer.clone()).transfer(job.amount);
            }
            Err(_) => {
                job.state = JobState::Open;
                emit("check_failed", json!({ "job_id": job_id }));
            }
        }
        let paid = job.state == JobState::Paid;
        self.jobs.insert(job_id.0, job);
        paid
    }

    /// After the deadline, the buyer takes back an undelivered job.
    pub fn cancel(&mut self, job_id: U64) -> Promise {
        let mut job = self.job(job_id.0);
        require!(env::predecessor_account_id() == job.buyer, "only the buyer can cancel");
        require!(job.state == JobState::Open, "this job is not open");
        require!(env::block_timestamp() > job.deadline_ns.0, "the deadline has not passed");
        job.state = JobState::Cancelled;
        let (buyer, amount) = (job.buyer.clone(), job.amount);
        self.jobs.insert(job_id.0, job);
        emit("cancelled", json!({ "job_id": job_id, "buyer": buyer, "amount": amount }));
        Promise::new(buyer).transfer(amount)
    }

    pub fn get_job(&self, job_id: U64) -> Option<Job> {
        self.jobs.get(&job_id.0).cloned()
    }

    pub fn get_registry(&self) -> AccountId {
        self.registry.clone()
    }

    pub fn jobs_created(&self) -> U64 {
        U64(self.next_job_id)
    }

    fn job(&self, job_id: u64) -> Job {
        self.jobs.get(&job_id).cloned().unwrap_or_else(|| env::panic_str("unknown job"))
    }
}

#[cfg(test)]
mod tests;
