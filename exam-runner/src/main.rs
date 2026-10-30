//! PROCTOR exam runner.
//!
//! Runs inside an OutLayer TEE job. The secret exam (`EXAM_JSON`) and the
//! NEAR AI API key (`NEARAI_API_KEY`) arrive as decrypted environment
//! variables that exist only inside the enclave. The public input on stdin
//! names the candidate model. The runner asks every question, grades each
//! answer deterministically, and prints a JSON result that contains the exam
//! commitment and the score but no question text and no answers.

use std::io::{self, Read, Write};

use proctor_core::{grade, parse_exam, result, ANSWER_INSTRUCTION};
use serde::{Deserialize, Serialize};

const RUNNER_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ENDPOINT: &str = "https://cloud-api.near.ai/v1/chat/completions";
const DEFAULT_MAX_TOKENS: u32 = 1024;

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
    if let Err(message) = run() {
        // Errors never include exam content.
        eprintln!("exam-runner error: {message}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
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

    let mut correct = 0u32;
    let mut failed_calls = 0u32;
    let mut response_ids = Vec::with_capacity(exam.questions.len());

    for question in &exam.questions {
        match ask(&input.candidate, &api_key, &question.prompt, input.max_tokens) {
            Ok((id, answer)) => {
                if grade(&question.grader, &answer) {
                    correct += 1;
                }
                if let Some(id) = id {
                    response_ids.push(id);
                }
            }
            // A failed call is not graded; it marks the sitting incomplete.
            Err(_) => failed_calls += 1,
        }
    }

    let output = Output {
        proctor_version: RUNNER_VERSION,
        request_id: &input.request_id,
        exam_id: &exam.exam_id,
        candidate: &input.candidate,
        result: result(&exam, &exam_bytes, correct),
        complete: failed_calls == 0,
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

fn parse_reply(body: &[u8]) -> Result<(Option<String>, String), String> {
    let reply: ChatResponse =
        serde_json::from_slice(body).map_err(|e| format!("unexpected response shape: {e}"))?;
    let content = reply
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .ok_or("response had no answer")?;
    Ok((reply.id, content))
}

#[cfg(target_os = "wasi")]
fn ask(
    candidate: &Candidate,
    api_key: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<(Option<String>, String), String> {
    use std::time::Duration;
    let body = build_request_body(candidate, prompt, max_tokens)?;
    let response = wasi_http_client::Client::new()
        .post(&candidate.endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .connect_timeout(Duration::from_secs(30))
        .body(body.as_bytes())
        .send()
        .map_err(|e| format!("request failed: {e:?}"))?;
    let status = response.status();
    let bytes = response.body().map_err(|e| format!("cannot read body: {e:?}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("model endpoint returned HTTP {status}"));
    }
    parse_reply(&bytes)
}

#[cfg(not(target_os = "wasi"))]
fn ask(
    candidate: &Candidate,
    _api_key: &str,
    prompt: &str,
    max_tokens: u32,
) -> Result<(Option<String>, String), String> {
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
        assert_eq!(id.as_deref(), Some("chatcmpl-1"));
        assert_eq!(content, "ANSWER: 4");
    }

    #[test]
    fn rejects_reply_without_content() {
        let body = br#"{"id":"x","choices":[]}"#;
        assert!(parse_reply(body).is_err());
    }

    #[test]
    fn input_defaults_endpoint_and_tokens() {
        let input: Input =
            serde_json::from_str(r#"{"request_id":"r1","candidate":{"model":"m"}}"#).unwrap();
        assert_eq!(input.candidate.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(input.max_tokens, DEFAULT_MAX_TOKENS);
    }
}
