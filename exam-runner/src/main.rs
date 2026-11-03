//! PROCTOR exam runner.
//!
//! Runs inside an OutLayer TEE job. The secret exam (`EXAM_JSON`) and the
//! NEAR AI API key (`NEARAI_API_KEY`) arrive as decrypted environment
//! variables that exist only inside the enclave. The public input on stdin
//! names the candidate model. The runner asks every question, grades each
//! answer deterministically, and prints a JSON result that contains the exam
//! commitment and the score but no question text and no answers.

use std::io::{self, Read, Write};
use std::time::{Duration, Instant};

use futures::stream::{self, StreamExt};
use proctor_core::{grade, parse_exam, result, ANSWER_INSTRUCTION};
use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "wasi"))]
use futures::executor::block_on;
#[cfg(target_os = "wasi")]
use wstd::runtime::block_on;

const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ENDPOINT: &str = "https://cloud-api.near.ai/v1/chat/completions";
/// The only origin that receives PROCTOR's NEAR AI key. Agents sitting
/// through their own endpoint get no credentials.
const NEAR_AI_ORIGIN: &str = "https://cloud-api.near.ai/";
/// Room for reasoning models to think before they answer.
const DEFAULT_MAX_TOKENS: u32 = 4096;
/// Questions in flight at once. A reasoning model can take a minute per
/// question, so asking one at a time would not fit OutLayer's 180 s cap.
const CONCURRENCY: usize = 8;
/// No model call may still be running after this long. OutLayer kills a run
/// at 180 s; stopping first still prints an honest, incomplete result.
const RUN_DEADLINE_SECS: u64 = 165;
#[cfg(target_os = "wasi")]
const CONNECT_TIMEOUT_SECS: u64 = 30;
/// OutLayer ends the whole run, and charges it in full, when any one HTTP
/// request takes over 30 s. Each attempt is cut at 25 s instead, so a slow
/// answer costs one question, not the sitting.
const ATTEMPT_TIMEOUT_SECS: u64 = 25;
/// A question whose attempt timed out is asked once more if the run
/// deadline allows: answer times vary run to run, so a retry usually lands.
const ATTEMPTS: u32 = 2;
/// The error an attempt that ran out of time returns; only this is retried.
const ATTEMPT_TIMED_OUT: &str = "no answer within the time allowed";
/// The registry's limit on a completion id (MAX_RESPONSE_ID_LEN in the
/// contract). An id it would refuse is a failed call here, so an agent's
/// endpoint cannot turn its own sitting into a rejected (strike-free) run.
const MAX_RESPONSE_ID_LEN: usize = 96;
/// A chat reply larger than this is a failed call: no honest answer needs
/// it, and an endless body must not exhaust the enclave's memory.
#[cfg_attr(not(target_os = "wasi"), allow(dead_code))] // read only by the WASI HTTP path
const MAX_REPLY_BYTES: usize = 256 * 1024;

/// Public request: who sits the exam. Never contains exam content.
#[derive(Debug, Deserialize)]
struct Input {
    request_id: String,
    candidate: Candidate,
    #[serde(default = "default_max_tokens")]
    max_tokens: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct Candidate {
    model: String,
    #[serde(default = "default_endpoint")]
    endpoint: String,
}

fn default_endpoint() -> String {
    DEFAULT_ENDPOINT.to_string()
}

fn default_max_tokens() -> u32 {
    DEFAULT_MAX_TOKENS
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: [ChatMessage<'a>; 2],
    max_tokens: u32,
    /// 0 for repeatable grading. Left out only for models that reject any
    /// value but their default (see `rejects_temperature`).
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ChatResponse {
    id: Option<String>,
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatReply,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct ChatReply {
    content: Option<String>,
}

/// Public output. `response_ids` are the gateway completion ids, which let
/// anyone fetch NEAR AI's signatures for those completions.
#[derive(Serialize)]
struct Output<'a> {
    proctor_version: &'a str,
    request_id: &'a str,
    exam_id: &'a str,
    candidate: &'a Candidate,
    #[serde(flatten)]
    result: proctor_core::ExamResult,
    /// False when any question could not be asked. An incomplete sitting
    /// must never be turned into a certificate.
    complete: bool,
    failed_calls: u32,
    response_ids: Vec<String>,
}

fn main() {
    if let Err(message) = block_on(run()) {
        // Errors never include exam content.
        eprintln!("exam-runner error: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut raw_input = String::new();
    io::stdin()
        .read_to_string(&mut raw_input)
        .map_err(|e| format!("cannot read stdin: {e}"))?;
    let input: Input =
        serde_json::from_str(&raw_input).map_err(|e| format!("invalid input JSON: {e}"))?;

    let exam_bytes = std::env::var("EXAM_JSON")
        .map_err(|_| "EXAM_JSON secret is not set".to_string())?
        .into_bytes();
    let api_key =
        std::env::var("NEARAI_API_KEY").map_err(|_| "NEARAI_API_KEY secret is not set")?;
    let exam = parse_exam(&exam_bytes).map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(RUN_DEADLINE_SECS);
    // `buffered` keeps answers in question order while CONCURRENCY run at once.
    let answers: Vec<Result<(String, String), String>> = stream::iter(&exam.questions)
        .map(|question| ask_before(&input.candidate, &api_key, &question.prompt, input.max_tokens, deadline))
        .buffered(CONCURRENCY)
        .collect()
        .await;

    let answers = drop_repeated_ids(answers);
    let mut correct = 0u32;
    let mut failed_calls = 0u32;
    let mut response_ids = Vec::with_capacity(exam.questions.len());
    for (index, (question, answer)) in exam.questions.iter().zip(answers).enumerate() {
        match answer {
            Ok((id, answer)) => {
                if grade(&question.grader, &answer) {
                    correct += 1;
                }
                response_ids.push(id);
            }
            // A failed call is not graded; it marks the sitting incomplete.
            // The log names the question by position only, never its text.
            Err(e) => {
                eprintln!("question {index}: {e}");
                failed_calls += 1;
            }
        }
    }

    let complete = failed_calls == 0;
    let mut exam_result = result(&exam, &exam_bytes, correct);
    // An incomplete sitting never reads as a pass, whatever its score.
    exam_result.passed &= complete;
    let output = Output {
        proctor_version: RUNNER_VERSION,
        request_id: &input.request_id,
        exam_id: &exam.exam_id,
        candidate: &input.candidate,
        result: exam_result,
        complete,
        failed_calls,
        response_ids,
    };
    let json = serde_json::to_string(&output).map_err(|e| e.to_string())?;
    let mut stdout = io::stdout();
    stdout
        .write_all(json.as_bytes())
        .and_then(|_| stdout.flush())
        .map_err(|e| format!("cannot write output: {e}"))
}

/// True only for NEAR AI's own gateway. The prefix includes the path's first
/// slash, so look-alike hosts such as `cloud-api.near.ai.evil.example` and
/// userinfo tricks such as `cloud-api.near.ai@evil.example` never match.
fn sends_api_key(endpoint: &str) -> bool {
    endpoint.starts_with(NEAR_AI_ORIGIN)
}

fn build_request_body(candidate: &Candidate, prompt: &str, max_tokens: u32, pin_temperature: bool) -> Result<String, String> {
    let request = ChatRequest {
        model: &candidate.model,
        messages: [
            ChatMessage { role: "system", content: ANSWER_INSTRUCTION },
            ChatMessage { role: "user", content: prompt },
        ],
        max_tokens,
        temperature: pin_temperature.then_some(0.0),
    };
    serde_json::to_string(&request).map_err(|e| e.to_string())
}

/// True when an HTTP 400 says the model refuses a pinned temperature (some
/// reasoning models accept only their default). Only then is the question
/// asked again without it; every other error stays a failed call.
fn rejects_temperature(status: u16, body: &[u8]) -> bool {
    status == 400 && String::from_utf8_lossy(body).to_ascii_lowercase().contains("temperature")
}

/// Reads one completion. Anything that is not a whole, signed-off answer is
/// an error, so it counts as a failed call rather than as a wrong answer: an
/// outage or a cut-off reply must never fail (or revoke) a candidate.
fn parse_reply(body: &[u8]) -> Result<(String, String), String> {
    let reply: ChatResponse =
        serde_json::from_slice(body).map_err(|e| format!("unexpected response shape: {e}"))?;
    let id = reply.id.filter(|id| !id.is_empty()).ok_or("response had no id")?;
    if id.len() > MAX_RESPONSE_ID_LEN || !id.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("response id is not a valid completion id".into());
    }
    let choice = reply.choices.into_iter().next().ok_or("response had no choices")?;
    if let Some(reason @ ("length" | "content_filter")) = choice.finish_reason.as_deref() {
        return Err(format!("answer was cut off (finish_reason {reason})"));
    }
    let content = choice
        .message
        .content
        .filter(|c| !c.trim().is_empty())
        .ok_or("response had no answer")?;
    Ok((id, content))
}

/// A completion id may back only one answer. An endpoint that repeats one
/// (to replay a single real NEAR AI completion as evidence for several
/// answers) gets every repeat counted as a failed call.
fn drop_repeated_ids(answers: Vec<Result<(String, String), String>>) -> Vec<Result<(String, String), String>> {
    let mut seen = std::collections::HashSet::new();
    answers
        .into_iter()
        .map(|answer| match answer {
            Ok((id, _)) if !seen.insert(id.clone()) => Err("response id repeats an earlier answer's".to_string()),
            other => other,
        })
        .collect()
}

/// Asks one question, but only in the time left before the run deadline.
async fn ask_before(
    candidate: &Candidate,
    api_key: &str,
    prompt: &str,
    max_tokens: u32,
    deadline: Instant,
) -> Result<(String, String), String> {
    with_attempts(deadline, |limit| ask(candidate, api_key, prompt, max_tokens, limit)).await
}

/// Runs `attempt` with a per-attempt time limit of at most
/// ATTEMPT_TIMEOUT_SECS and never past `deadline`, trying again only after a
/// timeout. Any other error (a refusal, a cut-off answer) is final.
async fn with_attempts<F, Fut>(deadline: Instant, attempt: F) -> Result<(String, String), String>
where
    F: Fn(Duration) -> Fut,
    Fut: std::future::Future<Output = Result<(String, String), String>>,
{
    let mut last = Err("skipped, time budget used up".to_string());
    for _ in 0..ATTEMPTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return last;
        }
        last = attempt(remaining.min(Duration::from_secs(ATTEMPT_TIMEOUT_SECS))).await;
        match &last {
            Err(e) if e == ATTEMPT_TIMED_OUT => continue,
            _ => return last,
        }
    }
    last
}

#[cfg(target_os = "wasi")]
async fn ask(
    candidate: &Candidate,
    api_key: &str,
    prompt: &str,
    max_tokens: u32,
    limit: Duration,
) -> Result<(String, String), String> {
    use http_body_util::{BodyExt as _, Limited};
    use wstd::future::FutureExt as _;
    use wstd::http::{Body, Client, Request};

    let mut client = Client::new();
    client.set_connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS));
    let send = |pin_temperature: bool| {
        let client = client.clone();
        async move {
            let body = build_request_body(candidate, prompt, max_tokens, pin_temperature)?;
            let mut builder = Request::post(&candidate.endpoint).header("Content-Type", "application/json");
            if sends_api_key(&candidate.endpoint) {
                builder = builder.header("Authorization", format!("Bearer {api_key}"));
            }
            let request = builder
                .body(Body::from(body.into_bytes()))
                .map_err(|e| format!("cannot build request: {e}"))?;
            let response = client.send(request).await.map_err(|e| format!("request failed: {e}"))?;
            let status = response.status();
            let body = response.into_body();
            if body.content_length().is_some_and(|n| n > MAX_REPLY_BYTES as u64) {
                return Err("reply is larger than allowed".to_string());
            }
            let bytes = Limited::new(body.into_boxed_body(), MAX_REPLY_BYTES)
                .collect()
                .await
                .map_err(|_| "reply is larger than allowed or unreadable".to_string())?
                .to_bytes()
                .to_vec();
            Ok::<_, String>((status, bytes))
        }
    };
    let call = async {
        let (mut status, mut bytes) = send(true).await?;
        if rejects_temperature(status.as_u16(), &bytes) {
            (status, bytes) = send(false).await?;
        }
        if !status.is_success() {
            return Err(format!("model endpoint returned HTTP {status}"));
        }
        parse_reply(&bytes)
    };
    call.timeout(wstd::time::Duration::from(limit))
        .await
        .map_err(|_| ATTEMPT_TIMED_OUT.to_string())?
}

#[cfg(not(target_os = "wasi"))]
async fn ask(
    candidate: &Candidate,
    _api_key: &str,
    prompt: &str,
    max_tokens: u32,
    _limit: Duration,
) -> Result<(String, String), String> {
    // Native builds exist only for tests; the runner itself targets wasm32-wasip2.
    let _ = build_request_body(candidate, prompt, max_tokens, true)?;
    Err("HTTP is only available in the wasm32-wasip2 build".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> Candidate {
        Candidate { model: "Qwen/Qwen3.8-27B".into(), endpoint: DEFAULT_ENDPOINT.into() }
    }

    #[test]
    fn request_body_pins_temperature_and_instruction() {
        let body = build_request_body(&candidate(), "What is 2+2?", 64, true).unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["temperature"], 0.0);
        assert_eq!(v["messages"][0]["content"], ANSWER_INSTRUCTION);
        assert_eq!(v["messages"][1]["content"], "What is 2+2?");
        assert_eq!(v["max_tokens"], 64);
    }

    #[test]
    fn parses_openai_compatible_reply() {
        let body = br#"{"id":"chatcmpl-1","choices":[{"message":{"role":"assistant","content":"ANSWER: 4"}}]}"#;
        let (id, content) = parse_reply(body).unwrap();
        assert_eq!(id, "chatcmpl-1");
        assert_eq!(content, "ANSWER: 4");
    }

    #[test]
    fn rejects_reply_without_content() {
        let body = br#"{"id":"x","choices":[]}"#;
        assert!(parse_reply(body).is_err());
    }

    #[test]
    fn empty_or_blank_answers_are_failed_calls() {
        for content in [r#""""#, r#""   
 ""#, "null"] {
            let body = format!(r#"{{"id":"x","choices":[{{"message":{{"content":{content}}}}}]}}"#);
            assert!(parse_reply(body.as_bytes()).is_err(), "{content}");
        }
    }

    #[test]
    fn cut_off_answers_are_failed_calls() {
        for reason in ["length", "content_filter"] {
            let body = format!(
                r#"{{"id":"x","choices":[{{"message":{{"content":"thinking about"}},"finish_reason":"{reason}"}}]}}"#
            );
            assert!(parse_reply(body.as_bytes()).is_err(), "{reason}");
        }
        let done = br#"{"id":"x","choices":[{"message":{"content":"ANSWER: 4"},"finish_reason":"stop"}]}"#;
        assert!(parse_reply(done).is_ok());
    }

    #[test]
    fn answers_without_an_id_are_failed_calls() {
        let body = br#"{"choices":[{"message":{"content":"ANSWER: 4"}}]}"#;
        assert!(parse_reply(body).is_err());
    }

    #[test]
    fn questions_after_the_deadline_are_failed_calls() {
        let past = Instant::now() - Duration::from_secs(1);
        let answer = block_on(ask_before(&candidate(), "key", "2+2?", 64, past));
        assert_eq!(answer, Err("skipped, time budget used up".to_string()));
    }

    #[test]
    fn temperature_is_left_out_only_for_models_that_refuse_it() {
        let unpinned: serde_json::Value =
            serde_json::from_str(&build_request_body(&candidate(), "2+2?", 64, false).unwrap()).unwrap();
        assert!(unpinned.get("temperature").is_none());
        let refusal = br#"{"error":{"message":"Unsupported value: 'temperature' does not support 0.0 with this model."}}"#;
        assert!(rejects_temperature(400, refusal));
        assert!(!rejects_temperature(400, br#"{"error":{"message":"unknown model"}}"#));
        assert!(!rejects_temperature(500, refusal));
    }

    fn far_deadline() -> Instant {
        Instant::now() + Duration::from_secs(RUN_DEADLINE_SECS)
    }

    #[test]
    fn a_timed_out_question_is_asked_once_more() {
        let calls = std::cell::Cell::new(0);
        let answer = futures::executor::block_on(with_attempts(far_deadline(), |limit| {
            calls.set(calls.get() + 1);
            assert_eq!(limit, Duration::from_secs(ATTEMPT_TIMEOUT_SECS), "each attempt stays under OutLayer's 30 s cap");
            let n = calls.get();
            async move { if n == 1 { Err(ATTEMPT_TIMED_OUT.to_string()) } else { Ok(("id".to_string(), "ANSWER: 4".to_string())) } }
        }));
        assert_eq!(answer, Ok(("id".to_string(), "ANSWER: 4".to_string())));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn retries_stop_after_two_attempts() {
        let calls = std::cell::Cell::new(0);
        let answer = futures::executor::block_on(with_attempts(far_deadline(), |_| {
            calls.set(calls.get() + 1);
            async { Err(ATTEMPT_TIMED_OUT.to_string()) }
        }));
        assert_eq!(answer, Err(ATTEMPT_TIMED_OUT.to_string()));
        assert_eq!(calls.get(), ATTEMPTS);
    }

    #[test]
    fn other_errors_are_never_retried() {
        let calls = std::cell::Cell::new(0);
        let answer = futures::executor::block_on(with_attempts(far_deadline(), |_| {
            calls.set(calls.get() + 1);
            async { Err("answer was cut off (finish_reason length)".to_string()) }
        }));
        assert!(answer.unwrap_err().contains("cut off"));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn nothing_is_asked_after_the_run_deadline() {
        let answer = futures::executor::block_on(with_attempts(Instant::now(), |_| async { Ok(("id".into(), "x".into())) }));
        assert_eq!(answer, Err("skipped, time budget used up".to_string()));
    }

    #[test]
    fn the_last_attempt_never_runs_past_the_deadline() {
        let deadline = Instant::now() + Duration::from_secs(10);
        let answer = futures::executor::block_on(with_attempts(deadline, |limit| {
            assert!(limit <= Duration::from_secs(10));
            async { Ok(("id".to_string(), "ANSWER: 1".to_string())) }
        }));
        assert!(answer.is_ok());
    }

    #[test]
    fn ids_the_registry_would_refuse_are_failed_calls() {
        for bad in ["a b", "line
break", &"x".repeat(MAX_RESPONSE_ID_LEN + 1)] {
            let body = format!(r#"{{"id":{},"choices":[{{"message":{{"content":"ANSWER: 4"}},"finish_reason":"stop"}}]}}"#, serde_json::to_string(bad).unwrap());
            assert_eq!(parse_reply(body.as_bytes()).unwrap_err(), "response id is not a valid completion id", "{bad:?}");
        }
        let longest = "x".repeat(MAX_RESPONSE_ID_LEN);
        let body = format!(r#"{{"id":"{longest}","choices":[{{"message":{{"content":"ANSWER: 4"}},"finish_reason":"stop"}}]}}"#);
        assert!(parse_reply(body.as_bytes()).is_ok());
    }

    #[test]
    fn a_repeated_completion_id_counts_as_a_failed_call() {
        let ok = |id: &str| Ok((id.to_string(), "ANSWER: 1".to_string()));
        let out = drop_repeated_ids(vec![ok("a"), ok("b"), ok("a"), Err("timed out".to_string()), ok("c")]);
        assert_eq!(out[0], ok("a"));
        assert_eq!(out[2], Err("response id repeats an earlier answer's".to_string()));
        assert_eq!(out[3], Err("timed out".to_string()));
        assert_eq!(out[4], ok("c"));
    }

    #[test]
    fn only_near_ai_receives_the_api_key() {
        assert!(sends_api_key(DEFAULT_ENDPOINT));
        for agent in [
            "https://agent.example.org/v1/chat/completions",
            "https://cloud-api.near.ai.evil.example/v1/chat/completions",
            "https://cloud-api.near.ai@evil.example/v1/chat/completions",
            "http://cloud-api.near.ai/v1/chat/completions",
            "https://evil.example/https://cloud-api.near.ai/",
        ] {
            assert!(!sends_api_key(agent), "{agent} must not get the key");
        }
    }

    #[test]
    fn the_output_echoes_the_endpoint_that_was_asked() {
        let input: Input = serde_json::from_str(
            r#"{"request_id":"r","candidate":{"model":"agent:alice.testnet/bot","endpoint":"https://agent.example.org/v1/chat/completions"}}"#,
        )
        .unwrap();
        let echoed = serde_json::to_value(&input.candidate).unwrap();
        assert_eq!(echoed["endpoint"], "https://agent.example.org/v1/chat/completions");
    }

    #[test]
    fn input_defaults_endpoint_and_tokens() {
        let input: Input =
            serde_json::from_str(r#"{"request_id":"r1","candidate":{"model":"m"}}"#).unwrap();
        assert_eq!(input.candidate.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(input.max_tokens, DEFAULT_MAX_TOKENS);
    }
}
