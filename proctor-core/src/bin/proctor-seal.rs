//! `proctor-seal <exam.json> [secret-out.json]`
//!
//! Prepares a secret exam for PROCTOR. It validates the exam, prints the
//! values to register on chain (commitment, question count, pass mark), and
//! writes the OutLayer secret payload, `{"EXAM_JSON": "<exam>"}`, from the
//! very same bytes it hashed.
//!
//! The commitment covers the exact bytes the exam runner receives, so a single
//! changed byte (a stripped trailing newline is the usual culprit) makes every
//! sitting fail with "exam commitment mismatch". Store the payload this tool
//! writes rather than re-typing or re-reading the exam.

use std::process::ExitCode;

use proctor_core::{commitment, parse_exam};
use serde_json::json;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(exam_path) = args.first() else {
        eprintln!("usage: proctor-seal <exam.json> [secret-out.json]");
        return ExitCode::from(2);
    };
    match seal(exam_path, args.get(1)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("proctor-seal: {message}");
            ExitCode::FAILURE
        }
    }
}

fn seal(exam_path: &str, secret_out: Option<&String>) -> Result<(), String> {
    let bytes = std::fs::read(exam_path).map_err(|e| format!("cannot read {exam_path}: {e}"))?;
    let exam = parse_exam(&bytes).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes.clone()).map_err(|_| "exam is not UTF-8".to_string())?;

    let summary = json!({
        "exam_id": exam.exam_id,
        "commitment": commitment(&bytes),
        "question_count": proctor_core::asked_count(&exam),
        "pass_mark_bps": exam.pass_mark_bps,
        "bytes": bytes.len(),
    });
    println!("{}", serde_json::to_string_pretty(&summary).map_err(|e| e.to_string())?);

    if let Some(out) = secret_out {
        let payload = json!({ "EXAM_JSON": text }).to_string();
        std::fs::write(out, payload).map_err(|e| format!("cannot write {out}: {e}"))?;
        eprintln!("wrote the OutLayer secret payload to {out}; keep it out of git");
    }
    Ok(())
}
