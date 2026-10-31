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

/// Most questions one exam may have. Matches the registry's cap on response ids.
pub const MAX_QUESTIONS: usize = 64;

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
    TooManyQuestions(usize),
    InvalidQuestion { index: usize, reason: &'static str },
}

impl std::fmt::Display for ExamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Parse(msg) => write!(f, "exam is not valid JSON: {msg}"),
            Self::Empty => write!(f, "exam has no questions"),
            Self::InvalidPassMark(bps) => write!(f, "pass mark {bps} bps is above {BPS_SCALE}"),
            Self::TooManyQuestions(n) => write!(f, "exam has {n} questions; the limit is {MAX_QUESTIONS}"),
            Self::InvalidQuestion { index, reason } => write!(f, "question {index}: {reason}"),
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
    if exam.questions.len() > MAX_QUESTIONS {
        return Err(ExamError::TooManyQuestions(exam.questions.len()));
    }
    let mut seen = std::collections::HashSet::new();
    for (index, question) in exam.questions.iter().enumerate() {
        let invalid = |reason| ExamError::InvalidQuestion { index, reason };
        if question.id.trim().is_empty() {
            return Err(invalid("id is empty"));
        }
        if !seen.insert(question.id.as_str()) {
            return Err(invalid("id is used twice"));
        }
        if question.prompt.trim().is_empty() {
            return Err(invalid("prompt is empty"));
        }
        validate_grader(&question.grader).map_err(invalid)?;
    }
    Ok(exam)
}

/// Rejects graders that could never pass, or that would pass any answer.
fn validate_grader(grader: &Grader) -> Result<(), &'static str> {
    match grader {
        Grader::Exact { accepted } => {
            if accepted.is_empty() || accepted.iter().any(|a| normalize(a).is_empty()) {
                return Err("exact grader needs non-empty accepted answers");
            }
        }
        Grader::Choice { answer } => {
            let answer = answer.trim();
            if answer.len() != 1 || !answer.chars().all(|c| c.is_ascii_alphabetic()) {
                return Err("choice answer must be a single letter");
            }
        }
        Grader::Number { value, tolerance } => {
            if !value.is_finite() || !tolerance.is_finite() || *tolerance < 0.0 {
                return Err("number grader needs a finite value and a tolerance of at least 0");
            }
        }
        Grader::ContainsAll { terms } => {
            if terms.is_empty() || terms.iter().any(|t| t.trim().is_empty()) {
                return Err("contains_all grader needs non-empty terms");
            }
        }
    }
    Ok(())
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
        // The answer may sit on the marker's line or on the next non-empty one.
        return rest.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
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
            let expected = expected.trim().to_ascii_lowercase();
            choice_letter(answer).is_some_and(|got| got.to_string() == expected)
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

/// The letter of a multiple-choice answer: "B", "(B)", "B)", "B." or "B: text".
/// A word that merely starts with the letter ("Because", "Both") is not one.
fn choice_letter(answer: &str) -> Option<char> {
    let got = normalize(answer);
    let got = got.strip_prefix('(').unwrap_or(&got);
    let mut chars = got.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    match chars.next() {
        None | Some(')' | '.' | ':' | ' ') => Some(letter.to_ascii_lowercase()),
        _ => None,
    }
}

/// First whitespace-separated token that reads as a finite number, ignoring
/// thousands separators and surrounding symbols such as "$", "%" or brackets.
fn parse_number(text: &str) -> Option<f64> {
    text.split_whitespace()
        .map(|token| {
            token
                .replace(',', "")
                .trim_matches(|c: char| !(c.is_ascii_digit() || c == '-' || c == '.'))
                .trim_end_matches('.')
                .to_string()
        })
        .filter(|token| token.chars().any(|c| c.is_ascii_digit()))
        .find_map(|token| token.parse::<f64>().ok().filter(|n| n.is_finite()))
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
    fn choice_grader_rejects_words_that_start_with_the_letter() {
        let g = Grader::Choice { answer: "B".into() };
        assert!(!grade(&g, "ANSWER: Because the second one is right"));
        assert!(!grade(&g, "ANSWER: Both"));
        assert!(grade(&g, "ANSWER: B) Ethereum-style address"));
        assert!(grade(&g, "ANSWER: B."));
        assert!(grade(&g, "ANSWER: B: the second"));
    }

    #[test]
    fn number_grader_skips_words_before_the_number() {
        let g = Grader::Number { value: 5.0, tolerance: 0.0 };
        assert!(grade(&g, "ANSWER: well-known 5"));
        assert!(grade(&g, "ANSWER: $5."));
        assert!(!grade(&g, "ANSWER: 1.2.3"));
        let thousand = Grader::Number { value: 1000.0, tolerance: 0.0 };
        assert!(grade(&thousand, "ANSWER: 1e3"));
    }

    #[test]
    fn answer_on_the_line_after_the_marker_is_read() {
        assert_eq!(extract_final_answer("thinking
ANSWER:

  Paris  
"), "Paris");
    }

    fn exam_with(grader: &str) -> Vec<u8> {
        format!(
            r#"{{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[
                {{"id":"q1","prompt":"p","grader":{grader}}}]}}"#
        )
        .into_bytes()
    }

    #[test]
    fn rejects_graders_that_pass_anything_or_nothing() {
        for grader in [
            r#"{"type":"exact","accepted":[]}"#,
            r#"{"type":"exact","accepted":[""]}"#,
            r#"{"type":"contains_all","terms":[]}"#,
            r#"{"type":"contains_all","terms":[" "]}"#,
            r#"{"type":"number","value":1,"tolerance":-1}"#,
            r#"{"type":"choice","answer":""}"#,
            r#"{"type":"choice","answer":"AB"}"#,
        ] {
            let err = parse_exam(&exam_with(grader)).unwrap_err();
            assert!(matches!(err, ExamError::InvalidQuestion { index: 0, .. }), "{grader}: {err:?}");
        }
    }

    #[test]
    fn rejects_duplicate_or_empty_question_ids() {
        let dup = br#"{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[
            {"id":"q","prompt":"p","grader":{"type":"choice","answer":"A"}},
            {"id":"q","prompt":"p","grader":{"type":"choice","answer":"A"}}]}"#;
        assert_eq!(
            parse_exam(dup).unwrap_err(),
            ExamError::InvalidQuestion { index: 1, reason: "id is used twice" }
        );
        let empty = br#"{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[
            {"id":" ","prompt":"p","grader":{"type":"choice","answer":"A"}}]}"#;
        assert!(matches!(parse_exam(empty).unwrap_err(), ExamError::InvalidQuestion { index: 0, .. }));
    }

    #[test]
    fn rejects_exams_over_the_question_cap() {
        let questions: Vec<String> = (0..=MAX_QUESTIONS)
            .map(|i| format!(r#"{{"id":"q{i}","prompt":"p","grader":{{"type":"choice","answer":"A"}}}}"#))
            .collect();
        let bytes = format!(
            r#"{{"exam_id":"t","title":"T","pass_mark_bps":5000,"questions":[{}]}}"#,
            questions.join(",")
        );
        assert_eq!(
            parse_exam(bytes.as_bytes()).unwrap_err(),
            ExamError::TooManyQuestions(MAX_QUESTIONS + 1)
        );
    }

    #[test]
    fn demo_exam_is_valid() {
        let bytes = include_bytes!("../../exams/near-protocol-basics.public.json");
        assert_eq!(parse_exam(bytes).unwrap().questions.len(), 5);
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
