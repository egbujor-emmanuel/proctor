//! Pure statistics over benchmark runs, and the registry's two-strike rule
//! as a Markov chain, so the published catch rates follow from measured
//! pass rates rather than from a guess.

use serde::Serialize;

/// One sitting of one model, graded like the enclave grades it.
#[derive(Debug, Clone, Serialize)]
pub struct Run {
    pub correct: u32,
    pub total: u32,
    pub failed_calls: u32,
    pub score_bps: u32,
    /// NEAR AI completion ids, one per answered question, for audit.
    pub response_ids: Vec<String>,
}

impl Run {
    /// The registry ignores incomplete runs (no certificate, no strike).
    pub fn complete(&self) -> bool {
        self.failed_calls == 0
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelStats {
    pub model: String,
    pub runs: usize,
    pub complete: usize,
    pub passes: usize,
    pub pass_rate: Option<f64>,
    /// 95% Wilson score interval for the pass rate.
    pub pass_rate_ci95: Option<(f64, f64)>,
    pub mean_score_bps: Option<f64>,
    pub min_score_bps: Option<u32>,
    pub max_score_bps: Option<u32>,
}

pub fn stats(model: &str, runs: &[Run], pass_mark_bps: u32) -> ModelStats {
    let complete: Vec<&Run> = runs.iter().filter(|r| r.complete()).collect();
    let passes = complete.iter().filter(|r| r.score_bps >= pass_mark_bps).count();
    let n = complete.len();
    let scores = complete.iter().map(|r| r.score_bps);
    ModelStats {
        model: model.to_string(),
        runs: runs.len(),
        complete: n,
        passes,
        pass_rate: (n > 0).then(|| passes as f64 / n as f64),
        pass_rate_ci95: (n > 0).then(|| wilson(passes, n)),
        mean_score_bps: (n > 0).then(|| scores.clone().map(f64::from).sum::<f64>() / n as f64),
        min_score_bps: scores.clone().min(),
        max_score_bps: scores.max(),
    }
}

/// 95% Wilson score interval: honest bounds for a rate from few trials.
pub fn wilson(successes: usize, trials: usize) -> (f64, f64) {
    const Z: f64 = 1.959_963_984_540_054;
    let n = trials as f64;
    let p = successes as f64 / n;
    let denom = 1.0 + Z * Z / n;
    let centre = (p + Z * Z / (2.0 * n)) / denom;
    let half = Z * ((p * (1.0 - p) + Z * Z / (4.0 * n)) / n).sqrt() / denom;
    ((centre - half).max(0.0), (centre + half).min(1.0))
}

/// Probability that a live certificate is revoked within `retests` complete
/// re-tests when each passes with probability `pass`. Mirrors the registry:
/// a fail suspends, a second fail in a row revokes, a pass restores.
pub fn revoked_within(pass: f64, retests: u32) -> f64 {
    let fail = 1.0 - pass;
    let (mut active, mut suspended, mut revoked) = (1.0, 0.0, 0.0);
    for _ in 0..retests {
        (active, suspended, revoked) = ((active + suspended) * pass, active * fail, revoked + suspended * fail);
    }
    revoked
}

/// Probability of at least one suspension within `retests` re-tests.
pub fn suspended_within(pass: f64, retests: u32) -> f64 {
    1.0 - pass.powi(retests as i32)
}

/// Expected re-tests until two fails in a row, or None if it never fails.
pub fn expected_retests_to_revoke(pass: f64) -> Option<f64> {
    let fail = 1.0 - pass;
    (fail > 0.0).then(|| (1.0 + fail) / (fail * fail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(correct: u32, failed_calls: u32) -> Run {
        Run { correct, total: 5, failed_calls, score_bps: correct * 2000, response_ids: vec![] }
    }

    #[test]
    fn incomplete_runs_count_for_nothing_like_on_chain() {
        let s = stats("m", &[run(5, 0), run(1, 0), run(0, 2)], 6000);
        assert_eq!((s.runs, s.complete, s.passes), (3, 2, 1));
        assert_eq!(s.pass_rate, Some(0.5));
        assert_eq!(s.min_score_bps, Some(2000));
    }

    #[test]
    fn no_complete_runs_means_no_rate() {
        let s = stats("m", &[run(0, 5)], 6000);
        assert_eq!(s.pass_rate, None);
        assert_eq!(s.mean_score_bps, None);
    }

    #[test]
    fn two_strikes_match_the_contract() {
        // A model that always fails is revoked on its second re-test, never its first.
        assert_eq!(revoked_within(0.0, 1), 0.0);
        assert_eq!(revoked_within(0.0, 2), 1.0);
        // One that always passes is never revoked.
        assert_eq!(revoked_within(1.0, 50), 0.0);
        // Coin flip: two re-tests revoke only on fail, fail.
        assert!((revoked_within(0.5, 2) - 0.25).abs() < 1e-12);
        // Three re-tests: FF? (0.25) or PFF (0.125).
        assert!((revoked_within(0.5, 3) - 0.375).abs() < 1e-12);
    }

    #[test]
    fn expected_time_to_two_fails_in_a_row() {
        assert_eq!(expected_retests_to_revoke(0.0), Some(2.0));
        assert_eq!(expected_retests_to_revoke(1.0), None);
        assert!((expected_retests_to_revoke(0.5).unwrap() - 6.0).abs() < 1e-12);
    }

    #[test]
    fn wilson_bounds_stay_honest_for_small_samples() {
        let (lo, hi) = wilson(10, 10);
        assert!(lo > 0.72 && lo < 0.73 && hi > 0.999_999, "{lo} {hi}");
        let (lo, hi) = wilson(0, 10);
        assert!(lo < 1e-9 && hi > 0.27 && hi < 0.28, "{lo} {hi}");
    }

    #[test]
    fn suspension_odds() {
        assert!((suspended_within(0.9, 2) - 0.19).abs() < 1e-12);
    }
}
