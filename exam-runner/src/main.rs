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
    temperature: f32,
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

fn build_request_body(candidate: &Candidate, prompt: &str, max_tokens: u32) -> Result<String, String> {
    let request = ChatRequest {
        model: &candidate.model,
        messages: [
            ChatMessage { role: "system", content: ANSWER_INSTRUCTION },
            ChatMessage { role: "user", content: prompt },
        ],
        max_tokens,
        temperature: 0.0,
    };
    serde_json::to_string(&request).map_err(|e| e.to_string())
}

/// Reads one completion. Anything that is not a whole, signed-off answer is
/// an error, so it counts as a failed call rather than as a wrong answer: an
/// outage or a cut-off reply must never fail (or revoke) a candidate.
fn parse_reply(body: &[u8]) -> Result<(String, String), String> {
    let reply: ChatResponse =
        serde_json::from_slice(body).map_err(|e| format!("unexpected response shape: {e}"))?;
    let id = reply.id.filter(|id| !id.is_empty()).ok_or("response had no id")?;
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

/// Asks one question, but only in the time left before the run deadline.
async fn ask_before(
    candidate: &Candidate,
    api_key: &str,
    prompt: &str,
    max_tokens: u32,
    deadline: Instant,
) -> Result<(String, String), String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("skipped, time budget used up".into());
    }
    ask(candidate, api_key, prompt, max_tokens, remaining).await
}

#[cfg(target_os = "wasi")]
async fn ask(
    candidate: &Candidate,
    api_key: &str,
    prompt: &str,
    max_tokens: u32,
    limit: Duration,
) -> Result<(String, String), String> {
    use wstd::future::FutureExt as _;
    use wstd::http::{Body, Client, Request};

    let body = build_request_body(candidate, prompt, max_tokens)?;
    let mut builder = Request::post(&candidate.endpoint).header("Content-Type", "application/json");
    if sends_api_key(&candidate.endpoint) {
        builder = builder.header("Authorization", format!("Bearer {api_key}"));
    }
    let request = builder
        .body(Body::from(body.into_bytes()))
        .map_err(|e| format!("cannot build request: {e}"))?;
    let mut client = Client::new();
    client.set_connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS));
    let call = async {
        let response = client.send(request).await.map_err(|e| format!("request failed: {e}"))?;
        let status = response.status();
        let mut body = response.into_body();
        let bytes = body.contents().await.map_err(|e| format!("cannot read body: {e}"))?.to_vec();
        if !status.is_success() {
            return Err(format!("model endpoint returned HTTP {status}"));
        }
        parse_reply(&bytes)
    };
    call.timeout(wstd::time::Duration::from(limit))
        .await
        .map_err(|_| "no answer before the run deadline".to_string())?
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
    let _ = build_request_body(candidate, prompt, max_tokens)?;
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
        let body = build_request_body(&candidate(), "What is 2+2?", 64).unwrap();
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
