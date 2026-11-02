//! The published benchmark page (bench/RESULTS.md), built from the results.

use std::fmt::Write;

use crate::analysis::{expected_retests_to_revoke, revoked_within, suspended_within, ModelStats};
use crate::Results;

fn pct(x: f64) -> String {
    format!("{:.0}%", x * 100.0)
}

fn rate(s: &ModelStats) -> String {
    match (s.pass_rate, s.pass_rate_ci95) {
        (Some(p), Some((lo, hi))) => format!("{} ({}–{})", pct(p), pct(lo), pct(hi)),
        _ => "n/a".into(),
    }
}

fn score(bps: Option<f64>) -> String {
    bps.map_or("n/a".into(), |b| format!("{:.0}%", b / 100.0))
}

pub fn markdown(results: &Results) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "# PROCTOR benchmark\n");
    let _ = writeln!(
        out,
        "Exam `{}` (commitment `{}`), {} questions, pass mark {}%. Run {} with `{}`: {} sitting(s) per model through NEAR AI Cloud, graded by `proctor-core` exactly as the OutLayer runner grades.\n",
        results.exam_id,
        results.exam_commitment,
        results.question_count,
        results.pass_mark_bps / 100,
        results.started_utc,
        results.command,
        results.runs_per_model,
    );
    let _ = writeln!(out, "## Scores\n");
    let _ = writeln!(out, "| Model | Complete runs | Mean score | Range | Pass rate (95% CI) |");
    let _ = writeln!(out, "|---|---|---|---|---|");
    for s in &results.models {
        let range = match (s.min_score_bps, s.max_score_bps) {
            (Some(lo), Some(hi)) => format!("{}–{}%", lo / 100, hi / 100),
            _ => "n/a".into(),
        };
        let _ = writeln!(out, "| `{}` | {}/{} | {} | {} | {} |", s.model, s.complete, s.runs, score(s.mean_score_bps), range, rate(s));
    }
    let _ = writeln!(
        out,
        "\nIncomplete runs (a failed or cut-off call) are listed but not scored: the registry neither certifies nor strikes on them.\n"
    );
    let _ = writeln!(out, "## What the two-strike rule does with these pass rates\n");
    let _ = writeln!(
        out,
        "A re-test that fails suspends a certificate; a second failure in a row revokes it; a pass restores it. From each model's measured pass rate:\n"
    );
    let _ = writeln!(out, "| Model | Suspended within 2 re-tests | Revoked within 2 | Revoked within 3 | Revoked within 3, across the 95% CI | Revoked within 5 | Expected re-tests to revoke |");
    let _ = writeln!(out, "|---|---|---|---|---|---|---|");
    for s in &results.models {
        let Some(p) = s.pass_rate else { continue };
        let expected = expected_retests_to_revoke(p).map_or("never (no fails seen)".into(), |e| format!("{e:.1}"));
        // A higher pass rate means fewer revocations, so the CI's top end gives the low bound.
        let ci = s.pass_rate_ci95.map_or("n/a".into(), |(lo, hi)| format!("{}–{}", pct(revoked_within(hi, 3)), pct(revoked_within(lo, 3))));
        let _ = writeln!(
            out,
            "| `{}` | {} | {} | {} | {} | {} | {} |",
            s.model,
            pct(suspended_within(p, 2)),
            pct(revoked_within(p, 2)),
            pct(revoked_within(p, 3)),
            ci,
            pct(revoked_within(p, 5)),
            expected
        );
    }
    let _ = writeln!(
        out,
        "\nRead the strong model's row as the false-alarm rate for an honest agent, and a weak model's row as the chance a quiet swap to it is caught. Rates from {} runs are estimates; the confidence intervals above bound them.",
        results.runs_per_model
    );
    let _ = writeln!(out, "\nRaw runs, with every NEAR AI completion id, are in `bench/results.json`.");
    out
}
