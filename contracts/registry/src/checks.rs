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

pub(crate) fn require_runner_source(runner_source: &Value) {
    require!(runner_source.is_object(), "runner_source must be an OutLayer ExecutionSource object");
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
