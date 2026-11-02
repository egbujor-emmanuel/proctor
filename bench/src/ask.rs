//! Asks one question the way the exam runner does (exam-runner/src/main.rs):
//! same system instruction, same body, same retry for models that refuse a
//! pinned temperature, and the same rule that anything short of a whole,
//! signed-off answer is a failed call rather than a wrong answer.

use std::time::Duration;

use proctor_core::ANSWER_INSTRUCTION;
use serde::Deserialize;
use serde_json::json;

pub const NEAR_AI_COMPLETIONS: &str = "https://cloud-api.near.ai/v1/chat/completions";
const TIMEOUT: Duration = Duration::from_secs(150);

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

pub struct Asker {
    agent: ureq::Agent,
    api_key: String,
    max_tokens: u32,
}

impl Asker {
    pub fn new(api_key: String, max_tokens: u32) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .http_status_as_error(false)
            .build()
            .into();
        Self { agent, api_key, max_tokens }
    }

    fn send(&self, model: &str, prompt: &str, pin_temperature: bool) -> Result<(u16, String), String> {
        let mut body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": ANSWER_INSTRUCTION },
                { "role": "user", "content": prompt },
            ],
            "max_tokens": self.max_tokens,
        });
        if pin_temperature {
            body["temperature"] = json!(0.0);
        }
        let mut response = self
            .agent
            .post(NEAR_AI_COMPLETIONS)
            .header("Authorization", &format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(|e| format!("request failed: {e}"))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|e| format!("cannot read body: {e}"))?;
        Ok((status, text))
    }

    /// The completion id and the full reply, or why the call failed.
    pub fn ask(&self, model: &str, prompt: &str) -> Result<(String, String), String> {
        let (mut status, mut text) = self.send(model, prompt, true)?;
        if status == 400 && text.to_ascii_lowercase().contains("temperature") {
            (status, text) = self.send(model, prompt, false)?;
        }
        if !(200..300).contains(&status) {
            return Err(format!("NEAR AI returned HTTP {status}"));
        }
        parse_reply(&text)
    }
}

fn parse_reply(text: &str) -> Result<(String, String), String> {
    let reply: ChatResponse = serde_json::from_str(text).map_err(|e| format!("unexpected response shape: {e}"))?;
    let id = reply.id.filter(|id| !id.is_empty()).ok_or("response had no id")?;
    let choice = reply.choices.into_iter().next().ok_or("response had no choices")?;
    if let Some(reason @ ("length" | "content_filter")) = choice.finish_reason.as_deref() {
        return Err(format!("answer was cut off (finish_reason {reason})"));
    }
    let content = choice.message.content.filter(|c| !c.trim().is_empty()).ok_or("response had no answer")?;
    Ok((id, content))
}

#[cfg(test)]
mod tests {
    use super::parse_reply;

    #[test]
    fn reads_a_whole_answer() {
        let body = r#"{"id":"c1","choices":[{"message":{"content":"4\nANSWER: 4"},"finish_reason":"stop"}]}"#;
        assert_eq!(parse_reply(body).unwrap(), ("c1".into(), "4\nANSWER: 4".into()));
    }

    #[test]
    fn a_cut_off_or_empty_answer_is_a_failed_call() {
        let cut = r#"{"id":"c1","choices":[{"message":{"content":"thinking"},"finish_reason":"length"}]}"#;
        assert!(parse_reply(cut).unwrap_err().contains("cut off"));
        let empty = r#"{"id":"c1","choices":[{"message":{"content":"  "},"finish_reason":"stop"}]}"#;
        assert!(parse_reply(empty).is_err());
        assert!(parse_reply(r#"{"choices":[]}"#).is_err());
    }
}
