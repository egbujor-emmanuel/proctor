//! PROCTOR certificate registry.
//!
//! Exam authors register a secret exam by its commitment (SHA-256 of the exam
//! bytes); the exam itself lives only as an OutLayer secret. Anyone can pay
//! for a sitting. The contract asks OutLayer to run the exam runner inside a
//! TEE, and a certificate is written **only** from OutLayer's callback, after
//! the contract re-checks the runner's output against what it registered.
//! Certified candidates can be re-tested; a complete re-test that scores below
//! the pass mark revokes the certificate. Outages, incomplete runs and
//! rejected outputs never revoke.

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, GasWeight, NearToken, PanicOnDefault,
    Promise, PromiseError,
};

/// Gas reserved for our own callback. The OutLayer call gets the rest.
const CALLBACK_GAS: Gas = Gas::from_tgas(50);
/// Smallest prepaid gas for a sitting, so OutLayer and the callback can both run.
const MIN_SITTING_GAS: Gas = Gas::from_tgas(150);
/// Kept by the registry from each sitting deposit to pay for the storage the
/// sitting and its outcome or certificate use: a worst-case certificate
/// measures 880 bytes (see the storage test), this covers 1,500. The
/// rest goes to OutLayer, which refunds unused compute to the payer.
const SITTING_STORAGE_FEE: NearToken = NearToken::from_millinear(15);
/// Smallest deposit accepted for a sitting (storage fee plus a compute floor).
const MIN_SITTING_DEPOSIT: NearToken = NearToken::from_millinear(25);
const BPS_SCALE: u32 = 10_000;
const MAX_ID_LEN: usize = 64;
const MAX_TITLE_LEN: usize = 160;
const MAX_MODEL_LEN: usize = 128;
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
const EVENT_VERSION: &str = "1.1.0";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Exams,
    Certificates,
    Sittings,
    Outcomes,
    Latest,
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
    Revoked { reason: String, at_ns: u64 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Certificate {
    pub cert_id: u64,
    pub exam_id: String,
    pub exam_commitment: String,
    pub candidate_model: String,
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
    RetestPassed { cert_id: u64, score_bps: u32 },
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
}

/// What OutLayer handed the callback.
enum RunnerResult {
    Output(RunnerOutput),
    /// The run produced nothing (`null`); OutLayer settled the deposit itself.
    NoOutput,
    /// Bytes that are not a runner output.
    Malformed(String),
    /// The OutLayer call failed, so NEAR returned the deposit to this contract.
    CallFailed,
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
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Free text such as a title: non-empty and bounded.
fn require_text(value: &str, what: &str, max: usize) {
    require!(!value.trim().is_empty(), format!("{what} must not be empty"));
    require!(value.len() <= max, format!("{what} is longer than {max} bytes"));
}

/// An identifier: bounded, and only `A-Z a-z 0-9 . _ : / @ + -`. Excluding
/// `|` keeps `latest_key` collision-free; excluding spaces and non-ASCII stops
/// look-alike names.
fn require_token(value: &str, what: &str, max: usize) {
    require_text(value, what, max);
    require!(
        value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:/@+-".contains(&b)),
        format!("{what} may only use letters, digits and . _ : / @ + -")
    );
}

/// An OutLayer secrets profile name, by OutLayer's own rule.
fn require_profile(value: &str) {
    require!(
        !value.is_empty()
            && value.len() <= MAX_ID_LEN
            && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "secrets_profile must be 1-64 letters, digits, - or _"
    );
}

fn require_runner_source(runner_source: &Value) {
    require!(runner_source.is_object(), "runner_source must be an OutLayer ExecutionSource object");
}

/// Safe as a map key because neither part may contain `|`.
fn latest_key(model: &str, exam_id: &str) -> String {
    format!("{model}|{exam_id}")
}

fn truncated(mut text: String) -> String {
    if text.len() > MAX_REASON_LEN {
        let mut end = MAX_REASON_LEN;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

fn response_ids_hash(ids: &[String]) -> String {
    hex_encode(&env::sha256(ids.join("\n").as_bytes()))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Reads OutLayer's result without panicking, whatever it contains.
fn read_runner_result() -> RunnerResult {
    if env::promise_results_count() != 1 {
        return RunnerResult::Malformed("expected exactly one promise result".into());
    }
    match env::promise_result_checked(0, MAX_OUTPUT_BYTES) {
        Err(PromiseError::Failed) => RunnerResult::CallFailed,
        Err(PromiseError::TooLong(len)) => {
            RunnerResult::Malformed(format!("runner output is {len} bytes; the limit is {MAX_OUTPUT_BYTES}"))
        }
        Ok(bytes) => match serde_json::from_slice::<Option<RunnerOutput>>(&bytes) {
            Ok(Some(output)) => RunnerResult::Output(output),
            Ok(None) => RunnerResult::NoOutput,
            Err(e) => RunnerResult::Malformed(truncated(format!("malformed runner output: {e}"))),
        },
        // `PromiseError` is non-exhaustive.
        #[allow(unreachable_patterns)]
        Err(_) => RunnerResult::Malformed("unreadable promise result".into()),
    }
}

fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
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
        require_runner_source(&runner_source);
        require!(is_hex64(&runner_hash), "runner_hash must be 64 lowercase hex characters");
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
        }
    }

    // ---------------------------------------------------------------- admin

    /// Points future sittings at a new runner build. Sittings already paid
    /// for, and the certificates they produce, keep the runner they started with.
    pub fn set_runner(&mut self, runner_source: Value, runner_hash: String) {
        self.assert_owner();
        require_runner_source(&runner_source);
        require!(is_hex64(&runner_hash), "runner_hash must be 64 lowercase hex characters");
        self.runner_source_json = runner_source.to_string();
        self.runner_hash = runner_hash.clone();
        emit("runner_updated", json!({ "runner_hash": runner_hash }));
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

        let used = env::storage_usage().saturating_sub(storage_before);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {cost} to cover storage"));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            Promise::new(author.clone()).transfer(refund).detach();
        }
        emit(
            "exam_registered",
            json!({ "exam_id": exam_id, "author": author, "commitment": commitment, "pass_mark_bps": pass_mark_bps, "question_count": question_count }),
        );
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
    /// a storage fee, is forwarded to OutLayer; OutLayer refunds unused
    /// compute to the caller.
    #[payable]
    pub fn sit_exam(&mut self, exam_id: String, candidate_model: String) -> Promise {
        require_token(&candidate_model, "candidate_model", MAX_MODEL_LEN);
        let exam = self.exams.get(&exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        require!(exam.active, "exam is not active");
        require!(
            !self.is_certified(candidate_model.clone(), exam_id),
            "candidate already holds an active certificate for this exam; re-test it instead"
        );
        self.start_sitting(exam, candidate_model, SittingKind::Initial)
    }

    /// Re-tests the candidate behind an active certificate with the same
    /// exam. Anyone may pay for a re-test, one at a time per certificate and
    /// at most once an hour; a complete re-test below the pass mark revokes.
    #[payable]
    pub fn retest(&mut self, cert_id: u64) -> Promise {
        let cert = self.cert(cert_id);
        require!(cert.status == CertStatus::Active, "certificate is not active");
        require!(cert.retest_in_flight.is_none(), "a re-test of this certificate is already running");
        let now = env::block_timestamp();
        require!(
            cert.last_retest_requested_ns.is_none_or(|t| now >= t.saturating_add(RETEST_COOLDOWN_NS)),
            "re-tests of one certificate must be at least an hour apart"
        );
        let exam = self.exams.get(&cert.exam_id).cloned().unwrap_or_else(|| env::panic_str("unknown exam"));
        let sitting_id = self.next_sitting_id;
        let promise = self.start_sitting(exam, cert.candidate_model, SittingKind::Retest { cert_id });
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
}

impl Registry {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner can do this");
    }

    fn runner_source(&self) -> Value {
        // Stored only after `require_runner_source`, so it always parses.
        serde_json::from_str(&self.runner_source_json)
            .unwrap_or_else(|_| env::panic_str("stored runner source is not JSON"))
    }

    fn cert(&self, cert_id: u64) -> Certificate {
        self.get_certificate(cert_id).unwrap_or_else(|| env::panic_str("unknown certificate"))
    }

    fn cert_mut(&mut self, cert_id: u64) -> Option<&mut Certificate> {
        u32::try_from(cert_id).ok().and_then(|i| self.certificates.get_mut(i))
    }

    fn start_sitting(&mut self, exam: Exam, candidate_model: String, kind: SittingKind) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_SITTING_DEPOSIT, format!("attach at least {MIN_SITTING_DEPOSIT}"));
        let compute = deposit.saturating_sub(SITTING_STORAGE_FEE);
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
            requested_by: requested_by.clone(),
            kind: kind.clone(),
            requested_at_ns: env::block_timestamp(),
            runner_hash: self.runner_hash.clone(),
            compute_deposit: compute,
        };
        self.sittings.insert(sitting_id, sitting);

        let input = json!({
            "request_id": format!("sitting-{sitting_id}"),
            "candidate": { "model": candidate_model },
        });
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

    /// Records an outcome, frees the certificate for its next re-test, and
    /// emits the result (with the completion ids, which are not stored).
    fn finish_sitting(&mut self, sitting: &Sitting, outcome: SittingOutcome, response_ids: &[String]) -> SittingOutcome {
        if let SittingKind::Retest { cert_id } = sitting.kind {
            if let Some(cert) = self.cert_mut(cert_id) {
                if cert.retest_in_flight == Some(sitting.sitting_id) {
                    cert.retest_in_flight = None;
                }
            }
        }
        if let Some(exam) = self.exams.get_mut(&sitting.exam_id) {
            exam.sittings = exam.sittings.saturating_add(1);
        }
        self.outcomes.insert(sitting.sitting_id, outcome.clone());
        let ids: &[String] = if matches!(outcome, SittingOutcome::Rejected { .. }) { &[] } else { response_ids };
        emit(
            "sitting_resolved",
            json!({
                "sitting_id": sitting.sitting_id,
                "exam_id": sitting.exam_id,
                "candidate_model": sitting.candidate_model,
                "outcome": outcome,
                "response_ids": ids,
            }),
        );
        outcome
    }

    /// Checks a runner output against the sitting and the registered exam.
    fn check_output(&self, sitting: &Sitting, exam: &Exam, output: &RunnerOutput) -> Result<(), String> {
        if output.exam_commitment != exam.commitment {
            return Err(truncated(format!("exam commitment mismatch: got {}", output.exam_commitment)));
        }
        if output.exam_id != exam.exam_id {
            return Err("exam id mismatch".into());
        }
        if output.candidate.model != sitting.candidate_model {
            return Err("candidate mismatch".into());
        }
        if output.request_id != format!("sitting-{}", sitting.sitting_id) {
            return Err("request id mismatch".into());
        }
        if output.total != exam.question_count {
            return Err(format!("runner asked {} questions; the exam has {}", output.total, exam.question_count));
        }
        if u64::from(output.correct) + u64::from(output.failed_calls) > u64::from(output.total) {
            return Err("correct answers plus failed calls exceed the question count".into());
        }
        if output.complete != (output.failed_calls == 0) {
            return Err("complete flag disagrees with failed_calls".into());
        }
        let expected_bps = ((u64::from(output.correct) * u64::from(BPS_SCALE)) / u64::from(output.total)) as u32;
        if output.score_bps != expected_bps {
            return Err(format!("score {} bps does not match {}/{}", output.score_bps, output.correct, output.total));
        }
        let answered = output.total - output.failed_calls;
        if output.response_ids.len() != answered as usize {
            return Err(format!("{} response ids for {answered} answered questions", output.response_ids.len()));
        }
        if output.response_ids.iter().any(|id| id.is_empty() || id.len() > MAX_RESPONSE_ID_LEN) {
            return Err(format!("response ids must be 1-{MAX_RESPONSE_ID_LEN} bytes"));
        }
        Ok(())
    }

    /// Certifies, fails, re-verifies or revokes, once the output checks out.
    fn apply_output(&mut self, sitting: &Sitting, output: &RunnerOutput) -> SittingOutcome {
        let Some(exam) = self.exams.get(&sitting.exam_id).cloned() else {
            return SittingOutcome::Rejected { reason: "exam no longer registered".into() };
        };
        if let Err(reason) = self.check_output(sitting, &exam, output) {
            return SittingOutcome::Rejected { reason };
        }
        if !output.complete {
            return SittingOutcome::Incomplete { failed_calls: output.failed_calls };
        }

        let passed = output.score_bps >= exam.pass_mark_bps;
        let now = env::block_timestamp();
        match &sitting.kind {
            SittingKind::Initial if passed => {
                // Two initial sittings can be in flight at once; only the first
                // pass may certify.
                if self.is_certified(sitting.candidate_model.clone(), exam.exam_id.clone()) {
                    return SittingOutcome::Rejected { reason: "candidate is already certified".into() };
                }
                let cert_id = u64::from(self.certificates.len());
                self.certificates.push(Certificate {
                    cert_id,
                    exam_id: exam.exam_id.clone(),
                    exam_commitment: exam.commitment.clone(),
                    candidate_model: sitting.candidate_model.clone(),
                    runner_hash: sitting.runner_hash.clone(),
                    score_bps: output.score_bps,
                    correct: output.correct,
                    total: output.total,
                    issued_at_ns: now,
                    last_verified_ns: now,
                    retests_passed: 0,
                    status: CertStatus::Active,
                    requested_by: sitting.requested_by.clone(),
                    sitting_id: sitting.sitting_id,
                    response_ids_hash: response_ids_hash(&output.response_ids),
                    response_count: output.response_ids.len() as u32,
                    retest_in_flight: None,
                    last_retest_requested_ns: None,
                });
                self.latest.insert(latest_key(&sitting.candidate_model, &exam.exam_id), cert_id);
                SittingOutcome::Certified { cert_id, score_bps: output.score_bps }
            }
            SittingKind::Initial => SittingOutcome::Failed { score_bps: output.score_bps },
            SittingKind::Retest { cert_id } => {
                let cert_id = *cert_id;
                let Some(cert) = self.cert_mut(cert_id) else {
                    return SittingOutcome::Rejected { reason: "unknown certificate".into() };
                };
                if cert.status != CertStatus::Active {
                    return SittingOutcome::Rejected { reason: "certificate already revoked".into() };
                }
                if passed {
                    cert.retests_passed = cert.retests_passed.saturating_add(1);
                    cert.last_verified_ns = now;
                    SittingOutcome::RetestPassed { cert_id, score_bps: output.score_bps }
                } else {
                    cert.status = CertStatus::Revoked {
                        reason: format!(
                            "re-test scored {} bps, below the pass mark of {} bps",
                            output.score_bps, exam.pass_mark_bps
                        ),
                        at_ns: now,
                    };
                    SittingOutcome::Revoked { cert_id, score_bps: output.score_bps }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
