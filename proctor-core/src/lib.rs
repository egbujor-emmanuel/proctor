//! PROCTOR core: the exam format, deterministic graders and the exam
//! commitment. Pure logic with no I/O, so it is tested natively and reused
//! unchanged inside the enclave runner.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Instruction given to every candidate so answers can be graded mechanically.
pub const ANSWER_INSTRUCTION: &str = "You are taking a test. Think as needed, then put your \
final answer alone on the last line in the form: ANSWER: <answer>";

/// Basis points in one whole (100%).
pub const BPS_SCALE: u32 = 10_000;

/// A secret exam. Only its commitment (hash) is ever published.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Exam {
    pub exam_id: String,
    pub title: String,
    /// Passing score in basis points (7000 = 70%).
    pub pass_mark_bps: u32,
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub prompt: String,
    pub grader: Grader,
}

/// How a response is checked. All graders are deterministic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Grader {
    /// Case- and whitespace-insensitive equality with one of the accepted answers.
    Exact { accepted: Vec<String> },
    /// Multiple choice: the answer letter (A, B, C, ...).
    Choice { answer: String },
    /// A number within an absolute tolerance.
    Number { value: f64, tolerance: f64 },
    /// Every term must appear (case-insensitive).
    ContainsAll { terms: Vec<String> },
}

/// Public result of one sitting. Contains no question text and no answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamResult {
    pub exam_commitment: String,
    pub total: u32,
    pub correct: u32,
    pub score_bps: u32,
    pub passed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExamError {
    Parse(String),
    Empty,
    InvalidPassMark(u32),
}

impl std::fmt::Display for ExamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(msg) => write!(f, "exam is not valid JSON: {msg}"),
            Self::Empty => write!(f, "exam has no questions"),
            Self::InvalidPassMark(bps) => write!(f, "pass mark {bps} bps is above {BPS_SCALE}"),
        }
    }
}

impl std::error::Error for ExamError {}

/// Parses and validates an exam from its exact bytes.
pub fn parse_exam(bytes: &[u8]) -> Result<Exam, ExamError> {
    let exam: Exam =
        serde_json::from_slice(bytes).map_err(|e| ExamError::Parse(e.to_string()))?;
    if exam.questions.is_empty() {
        return Err(ExamError::Empty);
    }
    if exam.pass_mark_bps > BPS_SCALE {
        return Err(ExamError::InvalidPassMark(exam.pass_mark_bps));
    }
    Ok(exam)
}

/// SHA-256 of the exam's exact bytes, hex encoded. Publishing this binds a
/// certificate to one exam without revealing it.
pub fn commitment(exam_bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(exam_bytes))
}

/// The candidate's final answer: the text after the last `ANSWER:` marker, or
/// the last non-empty line when no marker is present.
pub fn extract_final_answer(response: &str) -> &str {
    let marker = "ANSWER:";
    let upper = response.to_ascii_uppercase();
    if let Some(pos) = upper.rfind(marker) {
        let rest = &response[pos + marker.len()..];
        return rest.lines().next().unwrap_or("").trim();
    }
    response
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

fn normalize(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| c == '.' || c == '"' || c == '\'' || c == '`')
        .to_lowercase()
}

/// Grades one full model response against a grader.
pub fn grade(grader: &Grader, response: &str) -> bool {
    let answer = extract_final_answer(response);
    match grader {
        Grader::Exact { accepted } => {
            let got = normalize(answer);
            accepted.iter().any(|a| normalize(a) == got)
        }
        Grader::Choice { answer: expected } => {
            let got = normalize(answer);
            let letter = got
                .trim_start_matches('(')
                .chars()
                .next()
                .map(|c| c.to_ascii_lowercase());
            letter.is_some() && letter == expected.trim().chars().next().map(|c| c.to_ascii_lowercase())
        }
        Grader::Number { value, tolerance } => parse_number(answer)
            .map(|n| (n - value).abs() <= *tolerance)
            .unwrap_or(false),
        Grader::ContainsAll { terms } => {
            let haystack = response.to_lowercase();
            terms.iter().all(|t| haystack.contains(&t.to_lowercase()))
        }
    }
}

/// First number in the text, ignoring thousands separators.
fn parse_number(text: &str) -> Option<f64> {
    let cleaned: String = text.chars().filter(|c| *c != ',').collect();
    let start = cleaned.find(|c: char| c.is_ascii_digit() || c == '-')?;
    let tail = &cleaned[start..];
    let end = tail
        .char_indices()
        .skip(1)
        .find(|(_, c)| !(c.is_ascii_digit() || *c == '.'))
        .map(|(i, _)| i)
        .unwrap_or(tail.len());
    tail[..end].parse().ok()
}

/// Score in basis points, rounded down.
pub fn score_bps(correct: u32, total: u32) -> u32 {
    if total == 0 {
        return 0;
    }
    ((u64::from(correct) * u64::from(BPS_SCALE)) / u64::from(total)) as u32
}

/// Builds the public result for a sitting.
pub fn result(exam: &Exam, exam_bytes: &[u8], correct: u32) -> ExamResult {
    let total = exam.questions.len() as u32;
    let score = score_bps(correct, total);
    ExamResult {
        exam_commitment: commitment(exam_bytes),
        total,
        correct,
        score_bps: score,
        passed: score >= exam.pass_mark_bps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_bytes() -> Vec<u8> {
        br#"{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[
            {"id":"q1","prompt":"2+2?","grader":{"type":"number","value":4,"tolerance":0}},
            {"id":"q2","prompt":"Capital of France?","grader":{"type":"exact","accepted":["Paris"]}}
        ]}"#
        .to_vec()
    }

    #[test]
    fn parses_valid_exam() {
        let exam = parse_exam(&sample_bytes()).unwrap();
        assert_eq!(exam.questions.len(), 2);
    }

    #[test]
    fn rejects_empty_exam() {
        let bytes = br#"{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[]}"#;
        assert_eq!(parse_exam(bytes).unwrap_err(), ExamError::Empty);
    }

    #[test]
    fn rejects_pass_mark_above_100_percent() {
        let bytes = br#"{"exam_id":"t","title":"T","pass_mark_bps":10001,"questions":[
            {"id":"q","prompt":"p","grader":{"type":"choice","answer":"A"}}]}"#;
        assert_eq!(parse_exam(bytes).unwrap_err(), ExamError::InvalidPassMark(10001));
    }

    #[test]
    fn commitment_is_stable_and_byte_exact() {
        let a = commitment(b"exam");
        assert_eq!(a, commitment(b"exam"));
        assert_ne!(a, commitment(b"exam "));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn extracts_answer_after_last_marker() {
        let r = "Reasoning... ANSWER: wrong\nmore thinking\nANSWER: Paris\n";
        assert_eq!(extract_final_answer(r), "Paris");
    }

    #[test]
    fn falls_back_to_last_non_empty_line() {
        assert_eq!(extract_final_answer("thinking\n\n  42  \n\n"), "42");
    }

    #[test]
    fn exact_grader_ignores_case_whitespace_and_trailing_period() {
        let g = Grader::Exact { accepted: vec!["New York".into()] };
        assert!(grade(&g, "ANSWER:   new   york."));
        assert!(!grade(&g, "ANSWER: York"));
    }

    #[test]
    fn choice_grader_reads_letter() {
        let g = Grader::Choice { answer: "B".into() };
        assert!(grade(&g, "ANSWER: (B) the second one"));
        assert!(grade(&g, "ANSWER: b"));
        assert!(!grade(&g, "ANSWER: C"));
    }

    #[test]
    fn number_grader_respects_tolerance_and_separators() {
        let g = Grader::Number { value: 1000.0, tolerance: 0.5 };
        assert!(grade(&g, "ANSWER: 1,000"));
        assert!(grade(&g, "ANSWER: about 1000.4 units"));
        assert!(!grade(&g, "ANSWER: 1001"));
        assert!(!grade(&g, "ANSWER: none"));
    }

    #[test]
    fn contains_all_requires_every_term() {
        let g = Grader::ContainsAll { terms: vec!["shard".into(), "receipt".into()] };
        assert!(grade(&g, "A receipt is routed to the right Shard."));
        assert!(!grade(&g, "Only shards mentioned."));
    }

    #[test]
    fn score_and_pass_are_computed_in_bps() {
        assert_eq!(score_bps(2, 3), 6666);
        assert_eq!(score_bps(0, 0), 0);
        let bytes = sample_bytes();
        let exam = parse_exam(&bytes).unwrap();
        let r = result(&exam, &bytes, 1);
        assert_eq!(r.score_bps, 5000);
        assert!(r.passed);
        assert_eq!(r.exam_commitment, commitment(&bytes));
    }
}
