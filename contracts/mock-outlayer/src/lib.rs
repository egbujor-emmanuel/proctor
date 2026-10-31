//! A stand-in for the OutLayer contract, used only in sandbox tests.
//!
//! It takes the same `request_execution` arguments as `outlayer.testnet` and
//! answers in whichever way a test asks: a runner output that passes or fails
//! the exam, `null` (a failed run), bytes that are not JSON, or a refusal at
//! the door (a panic, which sends the deposit back to the caller). It answers
//! synchronously; the real OutLayer uses yield/resume, which the registry
//! cannot tell apart from the caller's side.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, PanicOnDefault};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    /// A complete run that answers every question correctly.
    Pass,
    /// A complete run that answers every question wrongly.
    Fail,
    /// A run in which every model call failed.
    Outage,
    /// OutLayer reports a failed run: the result is `null`.
    Null,
    /// The result is bytes that are not JSON.
    Garbage,
    /// OutLayer refuses the request before it starts.
    Refuse,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutLayer {
    mode: Mode,
    exam_id: String,
    exam_commitment: String,
    total: u32,
    /// The arguments of the most recent request, as JSON text.
    last_request: Option<String>,
    requests: u32,
}

#[near]
impl MockOutLayer {
    #[init]
    pub fn new(exam_id: String, exam_commitment: String, total: u32) -> Self {
        Self { mode: Mode::Pass, exam_id, exam_commitment, total, last_request: None, requests: 0 }
    }

    pub fn set_mode(&mut self, mode: Mode) {
        self.mode = mode;
    }

    #[payable]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Value,
        input_data: String,
        secrets_ref: Value,
        response_format: String,
        payer_account_id: AccountId,
    ) {
        if self.mode == Mode::Refuse {
            env::panic_str("mock OutLayer refused the request");
        }
        self.requests += 1;
        self.last_request = Some(
            json!({
                "source": source,
                "resource_limits": resource_limits,
                "input_data": input_data,
                "secrets_ref": secrets_ref,
                "response_format": response_format,
                "payer_account_id": payer_account_id,
                "attached_deposit": env::attached_deposit(),
            })
            .to_string(),
        );
        let result = match self.mode {
            Mode::Pass => self.output(&input_data, self.total, 0).to_string(),
            Mode::Fail => self.output(&input_data, 0, 0).to_string(),
            Mode::Outage => self.output(&input_data, 0, self.total).to_string(),
            Mode::Null => "null".to_string(),
            Mode::Garbage => "<html>502 Bad Gateway</html>".to_string(),
            Mode::Refuse => unreachable!("refused above"),
        };
        env::value_return(result.as_bytes());
    }

    pub fn last_request(&self) -> Option<Value> {
        self.last_request.as_deref().map(|r| serde_json::from_str(r).unwrap_or(Value::Null))
    }

    pub fn requests(&self) -> u32 {
        self.requests
    }
}

impl MockOutLayer {
    /// The JSON the PROCTOR exam runner prints, for the sitting named in the
    /// public input.
    fn output(&self, input_data: &str, correct: u32, failed_calls: u32) -> Value {
        let input: Value = serde_json::from_str(input_data).unwrap_or_else(|_| env::panic_str("input_data is not JSON"));
        let answered = self.total - failed_calls;
        let response_ids: Vec<String> = (0..answered).map(|i| format!("chatcmpl-mock-{}-{i}", self.requests)).collect();
        json!({
            "proctor_version": "mock",
            "request_id": input["request_id"],
            "exam_id": self.exam_id,
            "candidate": input["candidate"],
            "exam_commitment": self.exam_commitment,
            "total": self.total,
            "correct": correct,
            "score_bps": u64::from(correct) * 10_000 / u64::from(self.total),
            "passed": correct == self.total,
            "complete": failed_calls == 0,
            "failed_calls": failed_calls,
            "response_ids": response_ids,
        })
    }
}
