# PROCTOR benchmark

Exam `near-protocol-basics-demo-v1` (commitment `aed0590cdb979c1bea7f5d2c3c0f76151524c618a8f71a37ce9a9a4e44bed51c`), 5 questions, pass mark 60%. Run 2026-11-02 00:38 UTC with `cargo run -p proctor-bench --release -- --exam exams/near-protocol-basics.public.json --runs 10 --models anthropic/claude-sonnet-5-5,openai/gpt-5.4-nano,deepseek-ai/DeepSeek-V4.1-Flash-1017,google/gemini-3.5-flash,openai/gpt-5.5`: 10 sitting(s) per model through NEAR AI Cloud, graded by `proctor-core` exactly as the OutLayer runner grades.

## Scores

| Model | Complete runs | Mean score | Range | Pass rate (95% CI) |
|---|---|---|---|---|
| `anthropic/claude-sonnet-5-5` | 10/10 | 86% | 60–100% | 100% (72%–100%) |
| `openai/gpt-5.4-nano` | 10/10 | 36% | 20–40% | 0% (0%–28%) |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 8/10 | 58% | 40–60% | 88% (53%–98%) |
| `google/gemini-3.5-flash` | 8/10 | 65% | 60–80% | 100% (68%–100%) |
| `openai/gpt-5.5` | 6/10 | 50% | 40–60% | 50% (19%–81%) |

Incomplete runs (a failed or cut-off call) are listed but not scored: the registry neither certifies nor strikes on them.

## What the two-strike rule does with these pass rates

A re-test that fails suspends a certificate; a second failure in a row revokes it; a pass restores it. From each model's measured pass rate:

| Model | Suspended within 2 re-tests | Revoked within 2 | Revoked within 3 | Revoked within 3, across the 95% CI | Revoked within 5 | Expected re-tests to revoke |
|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5-5` | 0% | 0% | 0% | 0%–13% | 0% | never (no fails seen) |
| `openai/gpt-5.4-nano` | 100% | 100% | 100% | 67%–100% | 100% | 2.0 |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 23% | 2% | 3% | 0%–34% | 6% | 72.0 |
| `google/gemini-3.5-flash` | 0% | 0% | 0% | 0%–18% | 0% | never (no fails seen) |
| `openai/gpt-5.5` | 75% | 25% | 38% | 6%–78% | 59% | 6.0 |

Read the strong model's row as the false-alarm rate for an honest agent, and a weak model's row as the chance a quiet swap to it is caught. Rates from 10 runs are estimates; the confidence intervals above bound them.

Raw runs, with every NEAR AI completion id, are in `bench/results.json`.
