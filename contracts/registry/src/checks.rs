//! Input validation and small helpers shared by the contract's modules.

use super::*;

pub(crate) fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Free text such as a title: non-empty and bounded.
pub(crate) fn require_text(value: &str, what: &str, max: usize) {
    require!(!value.trim().is_empty(), format!("{what} must not be empty"));
    require!(value.len() <= max, format!("{what} is longer than {max} bytes"));
}

/// An identifier: bounded, and only `A-Z a-z 0-9 . _ : / @ + -`. Excluding
/// `|` keeps `latest_key` collision-free; excluding spaces and non-ASCII stops
/// look-alike names.
pub(crate) fn require_token(value: &str, what: &str, max: usize) {
    require_text(value, what, max);
    require!(
        value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:/@+-".contains(&b)),
        format!("{what} may only use letters, digits and . _ : / @ + -")
    );
}

/// An OutLayer secrets profile name, by OutLayer's own rule.
pub(crate) fn require_profile(value: &str) {
    require!(
        !value.is_empty()
            && value.len() <= MAX_ID_LEN
            && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "secrets_profile must be 1-64 letters, digits, - or _"
    );
}

/// The exam runner must be pinned to exact code, so the timelock on runner
/// changes cannot be bypassed outside this contract:
/// - `WasmUrl` whose `hash` is `runner_hash` (OutLayer's worker refuses any
///   download that does not hash to it), or
/// - `GitHub` at a full 40-character commit, which OutLayer compiles itself.
///
/// A `Project` source is refused: it runs the project's *active* version,
/// which the project owner can switch at any time.
pub(crate) fn require_runner_source(runner_source: &Value, runner_hash: &str) {
    require!(is_hex64(runner_hash), "runner_hash must be 64 lowercase hex characters");
    if let Some(wasm) = runner_source.get("WasmUrl") {
        let url = wasm.get("url").and_then(Value::as_str).unwrap_or_default();
        require!(url.starts_with("https://"), "WasmUrl url must be https://, the only scheme OutLayer fetches");
        require!(
            wasm.get("hash").and_then(Value::as_str) == Some(runner_hash),
            "WasmUrl hash must equal runner_hash"
        );
    } else if let Some(github) = runner_source.get("GitHub") {
        let commit = github.get("commit").and_then(Value::as_str).unwrap_or_default();
        require!(
            commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
            "GitHub runner source must pin a full 40-character commit"
        );
    } else {
        env::panic_str("runner_source must be a WasmUrl (pinned by hash) or GitHub (pinned by commit) ExecutionSource");
    }
}

/// Safe as a map key because neither part may contain `|`.
pub(crate) fn latest_key(model: &str, exam_id: &str) -> String {
    format!("{model}|{exam_id}")
}

pub(crate) fn truncated(mut text: String) -> String {
    if text.len() > MAX_REASON_LEN {
        let mut end = MAX_REASON_LEN;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

pub(crate) fn response_ids_hash(ids: &[String]) -> String {
    hex_encode(&env::sha256(ids.join("\n").as_bytes()))
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}
