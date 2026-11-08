//! How one sitting is put together so that it cannot be recognised as a test:
//! a random sample of the exam's questions, a random phrasing of each, and a
//! request framed like ordinary traffic, with no fixed instruction to spot.
//! Pure logic: the enclave supplies the random seed.

use crate::{Exam, Question};

/// A small, fast PRNG (SplitMix64). The seed comes from the enclave's OS
/// randomness; nothing outside the enclave sees it.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (n > 0), without modulo bias.
    pub fn below(&mut self, n: usize) -> usize {
        let n = n as u64;
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let x = self.next_u64();
            if x < zone {
                return (x % n) as usize;
            }
        }
    }

    /// `k` distinct indices from `0..n`, in random order (partial Fisher-Yates).
    pub fn sample(&mut self, n: usize, k: usize) -> Vec<usize> {
        let mut pool: Vec<usize> = (0..n).collect();
        let k = k.min(n);
        for i in 0..k {
            let j = i + self.below(n - i);
            pool.swap(i, j);
        }
        pool.truncate(k);
        pool
    }
}

/// How a request is framed: an optional everyday system message, and a closing
/// line asking for the answer after a marker. Varied per question, so no two
/// sittings share a signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Framing {
    pub system: Option<&'static str>,
    pub closing: &'static str,
    pub marker: &'static str,
}

/// Ordinary assistant personas; most requests carry none at all.
const SYSTEMS: &[&str] = &[
    "You are a helpful assistant.",
    "You are a concise, accurate assistant.",
    "Answer clearly and correctly.",
];

/// (closing line, marker). Every closing names its marker exactly.
const CLOSINGS: &[(&str, &str)] = &[
    ("Work it out, then give the final answer on its own last line as \"Final answer: <answer>\".", "Final answer:"),
    ("Please end with a line of the form \"Answer: <answer>\".", "Answer:"),
    ("Think it through and finish with \"Result: <answer>\" on the last line.", "Result:"),
    ("Show your reasoning briefly, then write \"So the answer is: <answer>\" on the final line.", "So the answer is:"),
    ("Reply with your reasoning and put \"ANSWER: <answer>\" on the last line.", "ANSWER:"),
    ("When you're done, state it as \"My answer: <answer>\".", "My answer:"),
];

impl Framing {
    pub fn random(rng: &mut Rng) -> Self {
        // About half the requests have no system message at all, like most traffic.
        let system = (rng.below(2) == 0).then(|| SYSTEMS[rng.below(SYSTEMS.len())]);
        let (closing, marker) = CLOSINGS[rng.below(CLOSINGS.len())];
        Self { system, closing, marker }
    }

    /// The user message: the question, then the closing line.
    pub fn user_message(&self, question_text: &str) -> String {
        format!("{}\n\n{}", question_text.trim(), self.closing)
    }
}

/// One question as it will be asked in this sitting.
#[derive(Debug, Clone)]
pub struct PlannedQuestion<'a> {
    pub question: &'a Question,
    /// The author's prompt or one of their variants, chosen at random.
    pub text: String,
    pub framing: Framing,
}

/// The questions this sitting asks: a random sample of the exam's pool (all
/// of them when the exam sets no sample), each with a random phrasing.
pub fn plan<'a>(exam: &'a Exam, rng: &mut Rng) -> Vec<PlannedQuestion<'a>> {
    let asked = crate::asked_count(exam) as usize;
    rng.sample(exam.questions.len(), asked)
        .into_iter()
        .map(|i| {
            let question = &exam.questions[i];
            let choices = 1 + question.variants.len();
            let pick = rng.below(choices);
            let text = if pick == 0 { question.prompt.clone() } else { question.variants[pick - 1].clone() };
            PlannedQuestion { question, text, framing: Framing::random(rng) }
        })
        .collect()
}

/// Every number in the original (digit runs, e.g. "64", "1.5", "10") must
/// survive a rewording, and the length must stay sensible. A rewording that
/// fails this is discarded and the author's text is asked instead, so a bad
/// paraphrase can never change a question's answer.
pub fn rewording_is_safe(original: &str, reworded: &str) -> bool {
    let reworded = reworded.trim();
    let (len_o, len_r) = (original.trim().chars().count(), reworded.chars().count());
    if len_r == 0 || len_r * 2 < len_o || len_r > len_o * 3 + 40 {
        return false;
    }
    // A rewording must not smuggle in an answer marker or a closing instruction.
    let lower = reworded.to_lowercase();
    if CLOSINGS.iter().any(|(_, m)| lower.contains(&m.to_lowercase())) {
        return false;
    }
    numbers(original).iter().all(|n| numbers(reworded).contains(n))
}

/// Digit runs, keeping a decimal point between digits ("1.5", "10", "2024").
fn numbers(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let decimal_point = c == '.' && !current.is_empty() && chars.get(i + 1).is_some_and(char::is_ascii_digit);
        if c.is_ascii_digit() || decimal_point {
            current.push(c);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Instruction for the model that rewords a question inside NEAR AI's TEE.
pub const REWORD_INSTRUCTION: &str = "Rewrite the user's question in different words so it reads naturally, as a person \
would ask it. Keep its meaning, every number, name and unit, and any answer options exactly. Do not answer it, do not \
add hints, and reply with the rewritten question only.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_exam;

    fn pool_exam(sample: Option<u32>) -> Exam {
        let questions: Vec<String> = (0..12)
            .map(|i| format!(r#"{{"id":"q{i}","prompt":"What is {i} plus 1?","variants":["Add 1 to {i}.","{i} + 1 = ?"],"grader":{{"type":"number","value":{},"tolerance":0}}}}"#, i + 1))
            .collect();
        let sample = sample.map(|s| format!(r#","sample":{s}"#)).unwrap_or_default();
        let json = format!(r#"{{"exam_id":"p","title":"P","pass_mark_bps":6000{sample},"questions":[{}]}}"#, questions.join(","));
        parse_exam(json.as_bytes()).unwrap()
    }

    #[test]
    fn rng_is_deterministic_per_seed_and_stays_in_range() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        assert_eq!(a.next_u64(), b.next_u64());
        let mut r = Rng::new(42);
        assert!((0..1000).all(|_| r.below(5) < 5));
    }

    #[test]
    fn sample_is_distinct_and_sized() {
        let mut r = Rng::new(1);
        let s = r.sample(40, 10);
        assert_eq!(s.len(), 10);
        let mut sorted = s.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), 10);
        assert!(s.iter().all(|&i| i < 40));
        assert_eq!(r.sample(3, 10).len(), 3);
    }

    #[test]
    fn plan_asks_the_sample_size_and_varies_between_sittings() {
        let exam = pool_exam(Some(5));
        let a = plan(&exam, &mut Rng::new(1));
        let b = plan(&exam, &mut Rng::new(2));
        assert_eq!(a.len(), 5);
        let ids = |p: &Vec<PlannedQuestion>| p.iter().map(|q| q.question.id.clone()).collect::<Vec<_>>();
        assert_ne!(ids(&a), ids(&b), "different seeds draw different questions");
        // Every phrasing is the prompt or one of its variants.
        for q in &a {
            assert!(q.text == q.question.prompt || q.question.variants.contains(&q.text));
        }
    }

    #[test]
    fn plan_without_a_sample_asks_every_question() {
        let exam = pool_exam(None);
        assert_eq!(plan(&exam, &mut Rng::new(3)).len(), 12);
    }

    #[test]
    fn framings_vary_and_name_their_marker() {
        let mut r = Rng::new(9);
        let framings: Vec<Framing> = (0..200).map(|_| Framing::random(&mut r)).collect();
        assert!(framings.iter().any(|f| f.system.is_none()));
        assert!(framings.iter().any(|f| f.system.is_some()));
        let markers: std::collections::HashSet<_> = framings.iter().map(|f| f.marker).collect();
        assert!(markers.len() >= 4, "markers vary: {markers:?}");
        for f in &framings {
            assert!(f.closing.contains(f.marker));
            assert!(f.user_message("Q?").starts_with("Q?\n\n"));
        }
    }

    #[test]
    fn rewording_keeps_every_number_or_is_rejected() {
        let original = "A train travels 120 km in 1.5 hours. What is its average speed in km/h?";
        assert!(rewording_is_safe(original, "If a train covers 120 km over 1.5 hours, how fast does it go on average, in km/h?"));
        assert!(!rewording_is_safe(original, "If a train covers 100 km over 1.5 hours, how fast does it go, in km/h?"));
        assert!(!rewording_is_safe(original, "Speed?"));
        assert!(!rewording_is_safe(original, "A train covers 120 km in 1.5 hours. Final answer: 80"));
        assert!(!rewording_is_safe(original, ""));
    }
}
