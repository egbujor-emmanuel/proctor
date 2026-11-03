//! PROCTOR certificate registry.
//!
//! Exam authors register a secret exam by its commitment (SHA-256 of the exam
//! bytes); the exam itself lives only as an OutLayer secret. Anyone can pay
//! for a sitting. The contract asks OutLayer to run the exam runner inside a
//! TEE, and a certificate is written **only** from OutLayer's callback, after
//! the contract re-checks the runner's output against what it registered.
//! Certified candidates can be re-tested. A complete re-test below the pass
//! mark suspends the certificate; a second one in a row revokes it, and a
//! passing re-test restores it. Outages, incomplete runs and rejected outputs
//! never suspend or revoke a NEAR AI model candidate. An agent whose own
//! endpoint leaves 3 re-tests in a row incomplete takes a strike as if it had
//! failed one, and those re-tests keep the hourly gap.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

pub use admin::PendingRunner;
use checks::*;
use verdict::{read_runner_result, RunnerResult};

/// Gas reserved for our own callback. The OutLayer call gets the rest.
const CALLBACK_GAS: Gas = Gas::from_tgas(50);
/// Smallest prepaid gas for a sitting, so OutLayer and the callback can both run.
const MIN_SITTING_GAS: Gas = Gas::from_tgas(150);
/// Kept by the registry from each sitting deposit to pay for the storage the
/// sitting and its outcome or certificate use: a worst-case certificate
/// measures 881 bytes for a model, 1,123 for an agent with a 256-byte
/// endpoint, and 1,248 when that sitting also pays a fee that opens a new
/// author balance (see the storage tests); this covers 1,500. The rest,
/// less any author fee, goes to OutLayer, which refunds unused compute.
const SITTING_STORAGE_FEE: NearToken = NearToken::from_millinear(15);
/// Smallest deposit accepted for a sitting: the storage fee plus a compute
/// floor. OutLayer's `estimate_execution_cost` asks 19.005 mNEAR for the
/// default limits (2026-11-01), so 25 mNEAR of compute leaves headroom. With
/// higher limits a sitter attaches more; an underfunded request is refused by
/// OutLayer and refunded by this contract.
const MIN_SITTING_DEPOSIT: NearToken = NearToken::from_millinear(40);
const BPS_SCALE: u32 = 10_000;
const MAX_ID_LEN: usize = 64;
const MAX_TITLE_LEN: usize = 160;
const MAX_MODEL_LEN: usize = 128;
/// Longest agent name inside an `agent:<owner>/<name>` candidate id.
const MAX_AGENT_NAME_LEN: usize = 48;
const MAX_ENDPOINT_LEN: usize = 256;
/// Most questions an exam may have; also the most response ids a run reports.
const MAX_QUESTIONS: u32 = 64;
const MAX_RESPONSE_ID_LEN: usize = 96;
/// Largest runner output the callback will read.
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_REASON_LEN: usize = 160;
const NS_PER_MINUTE: u64 = 60 * 1_000_000_000;
/// Smallest gap between two re-tests of one certificate.
const RETEST_COOLDOWN_NS: u64 = 60 * NS_PER_MINUTE;
/// After this long without a callback anyone may expire a sitting. OutLayer
/// itself gives up on a request after 10 minutes.
const SITTING_TIMEOUT_NS: u64 = 30 * NS_PER_MINUTE;
/// Floors for OutLayer limits; below these no exam can finish.
const MIN_INSTRUCTIONS: u64 = 1_000_000_000;
const MIN_MEMORY_MB: u32 = 64;
const MIN_EXECUTION_SECONDS: u64 = 30;
/// OutLayer's own caps.
const MAX_INSTRUCTIONS: u64 = 500_000_000_000;
const MAX_MEMORY_MB: u32 = 4096;
const MAX_EXECUTION_SECONDS: u64 = 180;
const EVENT_STANDARD: &str = "proctor";
const EVENT_VERSION: &str = "1.4.0";
/// Re-tests in a row an agent's endpoint may leave incomplete before that
/// counts as one failed re-test: an agent cannot dodge its test by failing calls.
const SILENT_RETESTS_PER_STRIKE: u32 = 3;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Exams,
    Certificates,
    Sittings,
    Outcomes,
    Latest,
    // Appended, so the keys above keep their prefixes across upgrades.
    ExamFees,
    HeldFees,
    AuthorBalances,
    RetestPrev,
    SilentStreaks,
    AgentExams,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Exam {
    pub exam_id: String,
    pub author: AccountId,
    pub title: String,
    /// SHA-256 (hex) of the exact exam bytes stored as the OutLayer secret.
    pub commitment: String,
    pub pass_mark_bps: u32,
    /// Number of questions in the committed exam; every run must report it.
    pub question_count: u32,
    /// OutLayer secrets profile, owned by `author`, holding EXAM_JSON and
    /// NEARAI_API_KEY.
    pub secrets_profile: String,
    pub active: bool,
    pub sittings: u64,
    pub registered_at_ns: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CertStatus {
    Active,
    /// One complete re-test fell below the pass mark. Not certified until a
    /// re-test passes; a second failure revokes.
    Suspended { reason: String, at_ns: u64 },
    Revoked { reason: String, at_ns: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Certificate {
    pub cert_id: u64,
    pub exam_id: String,
    pub exam_commitment: String,
    pub candidate_model: String,
    /// For agents: the endpoint that answered the exam. Re-tests ask the same
    /// endpoint, so an agent cannot move to dodge one. `None` for NEAR AI models.
    pub candidate_endpoint: Option<String>,
    /// SHA-256 of the exam-runner wasm that produced the score.
    pub runner_hash: String,
    pub score_bps: u32,
    pub correct: u32,
    pub total: u32,
    pub issued_at_ns: u64,
    pub last_verified_ns: u64,
    pub retests_passed: u32,
    pub status: CertStatus,
    pub requested_by: AccountId,
    pub sitting_id: u64,
    /// SHA-256 (hex) of the NEAR AI completion ids, newline-joined. The ids
    /// themselves are in the `sitting_resolved` event of `sitting_id`, and
    /// anyone can fetch NEAR AI's signatures for them.
    pub response_ids_hash: String,
    pub response_count: u32,
    /// The re-test sitting currently running, if any.
    pub retest_in_flight: Option<u64>,
    pub last_retest_requested_ns: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SittingKind {
    Initial,
    Retest { cert_id: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Sitting {
    pub sitting_id: u64,
    pub exam_id: String,
    pub candidate_model: String,
    pub candidate_endpoint: Option<String>,
    pub requested_by: AccountId,
    pub kind: SittingKind,
    pub requested_at_ns: u64,
    /// The runner configured when the sitting was paid for.
    pub runner_hash: String,
    /// What was forwarded to OutLayer; refunded if OutLayer refuses the call.
    pub compute_deposit: NearToken,
}

/// What became of a sitting. Every sitting ends in exactly one of these.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SittingOutcome {
    Certified { cert_id: u64, score_bps: u32 },
    Failed { score_bps: u32 },
    /// Also restores a suspended certificate.
    RetestPassed { cert_id: u64, score_bps: u32 },
    Suspended { cert_id: u64, score_bps: u32 },
    Revoked { cert_id: u64, score_bps: u32 },
    /// Some questions could not be asked; nothing is certified or revoked.
    Incomplete { failed_calls: u32 },
    /// OutLayer refused the request or reported a failed run.
    RunnerFailed { reason: String },
    /// The runner output did not match what the registry expected.
    Rejected { reason: String },
    /// No callback arrived in time and someone expired the sitting.
    Expired,
}

/// The fields of the exam runner's output the registry checks.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RunnerOutput {
    pub request_id: String,
    pub exam_id: String,
    pub candidate: RunnerCandidate,
    pub exam_commitment: String,
    pub total: u32,
    pub correct: u32,
    pub score_bps: u32,
    pub complete: bool,
    pub failed_calls: u32,
    #[serde(default)]
    pub response_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct RunnerCandidate {
    pub model: String,
    /// The endpoint the runner actually called.
    #[serde(default)]
    pub endpoint: Option<String>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub outlayer_account: AccountId,
    pub runner_source: Value,
    pub runner_hash: String,
    pub max_instructions: u64,
    pub max_memory_mb: u32,
    pub max_execution_seconds: u64,
    pub exams: u32,
    pub certificates: u32,
    pub next_sitting_id: u64,
    pub pending_runner: Option<PendingRunner>,
    pub pending_owner: Option<AccountId>,
}

impl SittingOutcome {
    /// True when the exam actually judged the candidate. Everything else is
    /// an outage, a bad output or a lost callback, which never counts.
    pub fn is_verdict(&self) -> bool {
        match self {
            Self::Certified { .. } | Self::Failed { .. } | Self::RetestPassed { .. } | Self::Suspended { .. } | Self::Revoked { .. } => true,
            Self::Incomplete { .. } | Self::RunnerFailed { .. } | Self::Rejected { .. } | Self::Expired => false,
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    outlayer_account: AccountId,
    /// OutLayer `ExecutionSource` as JSON (e.g. a Project or WasmUrl source).
    runner_source_json: String,
    runner_hash: String,
    max_instructions: u64,
    max_memory_mb: u32,
    max_execution_seconds: u64,
    exams: IterableMap<String, Exam>,
    certificates: Vector<Certificate>,
    sittings: LookupMap<u64, Sitting>,
    outcomes: LookupMap<u64, SittingOutcome>,
    /// `candidate_model|exam_id` -> latest certificate id.
    latest: LookupMap<String, u64>,
    next_sitting_id: u64,
    pending_runner: Option<PendingRunner>,
    pending_owner: Option<AccountId>,
    /// exam_id -> fee each new sitting pays the author (absent = free).
    exam_fees: LookupMap<String, NearToken>,
    /// sitting_id -> fee held until the sitting ends.
    held_fees: LookupMap<u64, NearToken>,
    /// author -> earnings not yet withdrawn.
    author_balances: LookupMap<AccountId, NearToken>,
    /// sitting_id -> the certificate's previous re-test time, restored if
    /// that re-test ends without a verdict (so a failed run cannot burn the
    /// hourly slot and lock other testers out).
    retest_prev: LookupMap<u64, Option<u64>>,
    /// cert_id -> re-tests in a row an agent's endpoint left incomplete.
    silent_streaks: LookupMap<u64, u32>,
    /// exam_id -> true if the author lets agents sit it through their own
    /// endpoints (which then see its questions).
    agent_exams: LookupMap<String, bool>,
}

#[near]
impl Registry {
    #[init]
    pub fn new(
        owner: AccountId,
        outlayer_account: AccountId,
        runner_source: Value,
        runner_hash: String,
    ) -> Self {
        require_runner_source(&runner_source, &runner_hash);
        Self {
            owner,
            outlayer_account,
            runner_source_json: runner_source.to_string(),
            runner_hash,
            max_instructions: 50_000_000_000,
            max_memory_mb: 256,
            max_execution_seconds: MAX_EXECUTION_SECONDS,
            exams: IterableMap::new(StorageKey::Exams),
            certificates: Vector::new(StorageKey::Certificates),
            sittings: LookupMap::new(StorageKey::Sittings),
            outcomes: LookupMap::new(StorageKey::Outcomes),
            latest: LookupMap::new(StorageKey::Latest),
            next_sitting_id: 0,
            pending_runner: None,
            pending_owner: None,
            exam_fees: LookupMap::new(StorageKey::ExamFees),
            held_fees: LookupMap::new(StorageKey::HeldFees),
            author_balances: LookupMap::new(StorageKey::AuthorBalances),
            retest_prev: LookupMap::new(StorageKey::RetestPrev),
            silent_streaks: LookupMap::new(StorageKey::SilentStreaks),
            agent_exams: LookupMap::new(StorageKey::AgentExams),
        }
    }

    // ---------------------------------------------------------------- exams

    /// Registers a secret exam by its commitment. The caller becomes the
    /// author and must own `secrets_profile` on OutLayer. Attach enough NEAR to
    /// cover the storage this record uses; any excess is refunded.
    #[payable]
    pub fn register_exam(
        &mut self,
        exam_id: String,
        title: String,
        commitment: String,
        pass_mark_bps: u32,
        question_count: u32,
        secrets_profile: String,
    ) {
        require_token(&exam_id, "exam_id", MAX_ID_LEN);
        require_text(&title, "title", MAX_TITLE_LEN);
        require_profile(&secrets_profile);
        require!(is_hex64(&commitment), "commitment must be 64 lowercase hex characters");
        require!(pass_mark_bps <= BPS_SCALE, "pass_mark_bps must be at most 10000");
        require!(
            (1..=MAX_QUESTIONS).contains(&question_count),
            format!("question_count must be between 1 and {MAX_QUESTIONS}")
        );
        require!(!self.exams.contains_key(&exam_id), "exam_id is already registered");

        let storage_before = env::storage_usage();
        let author = env::predecessor_account_id();
        let exam = Exam {
            exam_id: exam_id.clone(),
            author: author.clone(),
            title,
            commitment: commitment.clone(),
            pass_mark_bps,
            question_count,
            secrets_profile,
            active: true,
            sittings: 0,
            registered_at_ns: env::block_timestamp(),
        };
        self.exams.insert(exam_id.clone(), exam);
        self.exams.flush();

        charge_storage(storage_before, &author);
        emit(
            "exam_registered",
            json!({ "exam_id": exam_id, "author": author, "commitment": commitment, "pass_mark_bps": pass_mark_bps, "question_count": question_count }),
        );
    }

    /// Lets agents sit an exam through their own endpoints, or stops them.
    /// Off by default: an endpoint receives every question it is asked, so
    /// the author decides whether that exposure is acceptable. Re-tests of
    /// certificates already issued are unaffected. Attach enough to store
    /// the setting (any excess is refunded).
    #[payable]
    pub fn set_exam_agents(&mut self, exam_id: String, allowed: bool) {
        let author = env::predecessor_account_id();
        let exam = self.exams.get(&exam_id).unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(author == exam.author, "only the exam author can do this");
        let storage_before = env::storage_usage();
        if allowed {
            self.agent_exams.insert(exam_id.clone(), true);
        } else {
            self.agent_exams.remove(&exam_id);
        }
        self.agent_exams.flush();
        charge_storage(storage_before, &author);
        emit("exam_agents", json!({ "exam_id": exam_id, "allowed": allowed }));
    }

    /// Opens or closes an exam to new sittings. Only its author may do this.
    pub fn set_exam_active(&mut self, exam_id: String, active: bool) {
        let caller = env::predecessor_account_id();
        let exam = self.exams.get_mut(&exam_id).unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(caller == exam.author, "only the exam author can do this");
        exam.active = active;
        emit("exam_status", json!({ "exam_id": exam_id, "active": active }));
    }

    // ------------------------------------------------------------- sittings

    /// Pays for a sitting of `exam_id` by `candidate_model`. The deposit, less
    /// a storage fee and the author's fee, is forwarded to OutLayer; OutLayer
    /// refunds unused compute to the caller. `max_fee` refuses the sitting if
    /// the author raised the fee above what the caller expected.
    #[payable]
    pub fn sit_exam(&mut self, exam_id: String, candidate_model: String, max_fee: Option<NearToken>) -> Promise {
        require_token(&candidate_model, "candidate_model", MAX_MODEL_LEN);
        require!(!candidate_model.starts_with("agent:"), "agent: ids are issued only by sit_exam_as_agent");
        let exam = self.exams.get(&exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(exam.active, "exam is not active");
        require!(
            !self.holds_live_certificate(&candidate_model, &exam_id),
            "candidate already holds a certificate for this exam; re-test it instead"
        );
        self.start_sitting(exam, candidate_model, None, SittingKind::Initial, max_fee)
    }

    /// Pays for a sitting by an agent behind its own OpenAI-compatible
    /// endpoint. The candidate id is `agent:<caller>/<name>`, so only the
    /// account that registers an agent can first certify it; anyone can still
    /// pay for its re-tests. The endpoint gets no credentials: the runner sends
    /// PROCTOR's NEAR AI key only to NEAR AI's own gateway.
    #[payable]
    pub fn sit_exam_as_agent(&mut self, exam_id: String, name: String, endpoint: String, max_fee: Option<NearToken>) -> Promise {
        require_token(&name, "name", MAX_AGENT_NAME_LEN);
        require!(!name.contains('/'), "name must not contain /");
        require_endpoint(&endpoint);
        let candidate_model = agent_candidate_id(&env::predecessor_account_id(), &name);
        let exam = self.exams.get(&exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(exam.active, "exam is not active");
        require!(
            self.agent_exams.get(&exam_id).copied().unwrap_or(false),
            "this exam does not accept agent endpoints; its author can allow them with set_exam_agents"
        );
        require!(
            !self.holds_live_certificate(&candidate_model, &exam_id),
            "candidate already holds a certificate for this exam; re-test it instead"
        );
        self.start_sitting(exam, candidate_model, Some(endpoint), SittingKind::Initial, max_fee)
    }

    /// Re-tests the candidate behind an active or suspended certificate with
    /// the same exam. Anyone may pay for a re-test, one at a time per
    /// certificate and at most once an hour. Re-tests carry no author fee, so
    /// an author cannot price surprise re-tests out.
    #[payable]
    pub fn retest(&mut self, cert_id: u64) -> Promise {
        let cert = self.cert(cert_id);
        require!(!matches!(cert.status, CertStatus::Revoked { .. }), "certificate is revoked");
        require!(cert.retest_in_flight.is_none(), "a re-test of this certificate is already running");
        let now = env::block_timestamp();
        require!(
            cert.last_retest_requested_ns.is_none_or(|t| now >= t.saturating_add(RETEST_COOLDOWN_NS)),
            "re-tests of one certificate must be at least an hour apart"
        );
        let exam = self.exams.get(&cert.exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        let sitting_id = self.next_sitting_id;
        let previous = cert.last_retest_requested_ns;
        let promise = self.start_sitting(exam, cert.candidate_model, cert.candidate_endpoint, SittingKind::Retest { cert_id }, None);
        self.retest_prev.insert(sitting_id, previous);
        if let Some(cert) = self.cert_mut(cert_id) {
            cert.retest_in_flight = Some(sitting_id);
            cert.last_retest_requested_ns = Some(now);
        }
        promise
    }

    /// OutLayer's answer for a sitting. The OutLayer result is read and
    /// parsed by hand rather than by the SDK, so past the caller check this
    /// never panics and every outcome is recorded.
    #[private]
    pub fn on_sitting_result(&mut self, sitting_id: u64) -> SittingOutcome {
        // `#[private]` is enforced only in the generated wasm entry point, so
        // the same check lives here where unit tests can exercise it.
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Method on_sitting_result is private"
        );
        let Some(sitting) = self.sittings.remove(&sitting_id) else {
            emit("sitting_rejected", json!({ "sitting_id": sitting_id, "reason": "unknown or already resolved" }));
            return SittingOutcome::Rejected { reason: "unknown sitting".into() };
        };
        let (outcome, response_ids) = match read_runner_result() {
            RunnerResult::Output(output) => {
                let outcome = self.apply_output(&sitting, &output);
                (outcome, output.response_ids)
            }
            RunnerResult::NoOutput => {
                let reason = "OutLayer reported a failed run".into();
                (SittingOutcome::RunnerFailed { reason }, vec![])
            }
            RunnerResult::Malformed(reason) => (SittingOutcome::Rejected { reason }, vec![]),
            RunnerResult::CallFailed => {
                // OutLayer refused the call, so NEAR returned the deposit to
                // this contract; pass it back to whoever paid. (On a run that
                // fails later OutLayer refunds the payer itself.)
                if !sitting.compute_deposit.is_zero() {
                    Promise::new(sitting.requested_by.clone()).transfer(sitting.compute_deposit).detach();
                }
                let reason = "OutLayer refused the request; deposit refunded".into();
                (SittingOutcome::RunnerFailed { reason }, vec![])
            }
        };
        self.finish_sitting(&sitting, outcome, &response_ids)
    }

    /// Closes a sitting whose callback never arrived (for example a receipt
    /// that ran out of gas). Anyone may call it after the timeout. It never
    /// certifies or revokes, and refunds nothing: OutLayer refunds the payer of
    /// a request it gives up on.
    pub fn expire_sitting(&mut self, sitting_id: u64) -> SittingOutcome {
        let sitting = self.sittings.get(&sitting_id).cloned().unwrap_or_else(|| env::panic_str("unknown sitting"));
        require!(
            env::block_timestamp() >= sitting.requested_at_ns.saturating_add(SITTING_TIMEOUT_NS),
            "a sitting can be expired 30 minutes after it was requested"
        );
        self.sittings.remove(&sitting_id);
        self.finish_sitting(&sitting, SittingOutcome::Expired, &[])
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            outlayer_account: self.outlayer_account.clone(),
            runner_source: self.runner_source(),
            runner_hash: self.runner_hash.clone(),
            max_instructions: self.max_instructions,
            max_memory_mb: self.max_memory_mb,
            max_execution_seconds: self.max_execution_seconds,
            exams: self.exams.len(),
            certificates: self.certificates.len(),
            next_sitting_id: self.next_sitting_id,
            pending_runner: self.pending_runner.clone(),
            pending_owner: self.pending_owner.clone(),
        }
    }

    pub fn get_exam(&self, exam_id: String) -> Option<Exam> {
        self.exams.get(&exam_id).cloned()
    }

    pub fn list_exams(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Exam> {
        self.exams
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .cloned()
            .collect()
    }

    pub fn get_certificate(&self, cert_id: u64) -> Option<Certificate> {
        u32::try_from(cert_id).ok().and_then(|i| self.certificates.get(i)).cloned()
    }

    pub fn list_certificates(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Certificate> {
        let start = from_index.unwrap_or(0);
        let end = start.saturating_add(limit.unwrap_or(50).min(100)).min(self.certificates.len());
        (start..end).filter_map(|i| self.certificates.get(i).cloned()).collect()
    }

    /// The candidate's most recent certificate for this exam, if any.
    pub fn latest_certificate(&self, candidate_model: String, exam_id: String) -> Option<Certificate> {
        self.latest
            .get(&latest_key(&candidate_model, &exam_id))
            .and_then(|id| self.get_certificate(*id))
            .filter(|c| c.candidate_model == candidate_model && c.exam_id == exam_id)
    }

    /// True when the candidate's latest certificate for this exam is active.
    pub fn is_certified(&self, candidate_model: String, exam_id: String) -> bool {
        self.latest_certificate(candidate_model, exam_id)
            .is_some_and(|c| c.status == CertStatus::Active)
    }

    pub fn get_sitting(&self, sitting_id: u64) -> Option<Sitting> {
        self.sittings.get(&sitting_id).cloned()
    }

    pub fn get_outcome(&self, sitting_id: u64) -> Option<SittingOutcome> {
        self.outcomes.get(&sitting_id).cloned()
    }

    /// Whether the exam's author lets agents sit it through their own endpoints.
    pub fn exam_accepts_agents(&self, exam_id: String) -> bool {
        self.agent_exams.get(&exam_id).copied().unwrap_or(false)
    }
}

impl Registry {
    fn runner_source(&self) -> Value {
        // Stored only after `require_runner_source`, so it always parses.
        serde_json::from_str(&self.runner_source_json)
            .unwrap_or_else(|_| env::panic_str("stored runner source is not JSON"))
    }

    /// True when the candidate's latest certificate for this exam is active or
    /// suspended. Such a candidate must clear it by re-test, not a fresh sitting.
    fn holds_live_certificate(&self, candidate_model: &str, exam_id: &str) -> bool {
        self.latest_certificate(candidate_model.to_string(), exam_id.to_string())
            .is_some_and(|c| !matches!(c.status, CertStatus::Revoked { .. }))
    }

    fn cert(&self, cert_id: u64) -> Certificate {
        self.get_certificate(cert_id).unwrap_or_else(|| env::panic_str("unknown certificate"))
    }

    fn cert_mut(&mut self, cert_id: u64) -> Option<&mut Certificate> {
        u32::try_from(cert_id).ok().and_then(|i| self.certificates.get_mut(i))
    }

    fn start_sitting(
        &mut self,
        exam: Exam,
        candidate_model: String,
        candidate_endpoint: Option<String>,
        kind: SittingKind,
        max_fee: Option<NearToken>,
    ) -> Promise {
        let deposit = env::attached_deposit();
        // The author's fee (if any) is held on top of the usual deposit; re-tests pay none.
        let fee = if matches!(kind, SittingKind::Retest { .. }) { NearToken::from_yoctonear(0) } else { self.exam_fee(&exam.exam_id) };
        if let Some(max_fee) = max_fee {
            require!(fee <= max_fee, format!("the exam's fee is {fee}, above your max_fee of {max_fee}"));
        }
        let required = MIN_SITTING_DEPOSIT.saturating_add(fee);
        require!(deposit >= required, format!("attach at least {required}"));
        let compute = deposit.saturating_sub(SITTING_STORAGE_FEE).saturating_sub(fee);
        require!(
            env::prepaid_gas() >= MIN_SITTING_GAS,
            "attach at least 150 TGas so OutLayer and the callback can run"
        );

        let sitting_id = self.next_sitting_id;
        self.next_sitting_id += 1;
        let requested_by = env::predecessor_account_id();
        let sitting = Sitting {
            sitting_id,
            exam_id: exam.exam_id.clone(),
            candidate_model: candidate_model.clone(),
            candidate_endpoint: candidate_endpoint.clone(),
            requested_by: requested_by.clone(),
            kind: kind.clone(),
            requested_at_ns: env::block_timestamp(),
            runner_hash: self.runner_hash.clone(),
            compute_deposit: compute,
        };
        self.sittings.insert(sitting_id, sitting);
        if !fee.is_zero() {
            self.held_fees.insert(sitting_id, fee);
        }

        let candidate = match &candidate_endpoint {
            Some(endpoint) => json!({ "model": candidate_model, "endpoint": endpoint }),
            None => json!({ "model": candidate_model }),
        };
        let input = json!({ "request_id": format!("sitting-{sitting_id}"), "candidate": candidate });
        let args = json!({
            "source": self.runner_source(),
            "resource_limits": {
                "max_instructions": self.max_instructions,
                "max_memory_mb": self.max_memory_mb,
                "max_execution_seconds": self.max_execution_seconds,
            },
            "input_data": input.to_string(),
            "secrets_ref": { "profile": exam.secrets_profile, "account_id": exam.author },
            "response_format": "Json",
            "payer_account_id": requested_by,
        });
        emit(
            "sitting_requested",
            json!({ "sitting_id": sitting_id, "exam_id": exam.exam_id, "candidate_model": candidate_model, "kind": kind }),
        );

        Promise::new(self.outlayer_account.clone())
            .function_call_weight(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                compute,
                Gas::from_tgas(0),
                GasWeight(1),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_sitting_result(sitting_id),
            )
    }

}

mod admin;
mod checks;
mod migrate;
mod payouts;
mod verdict;

#[cfg(test)]
mod tests;
