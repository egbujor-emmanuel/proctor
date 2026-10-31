# PROCTOR build plan and toolchain map

Every skill, agent, MCP server and library installed for this build has an assigned job below. A step is not done until its listed checks pass.

## Status (2026-10-30)

| Step | State |
|---|---|
| 1. Exam runner (`proctor-core` + `exam-runner`, wasm32-wasip2) | Done: 15 tests pass, verified in wasmtime with real HTTPS |
| 2. Certificate registry contract | 25 unit tests pass (2026-10-31); builds for wasm32; reviews + audit checklist next |
| NEAR AI key | Valid; credits not yet issued ("no spending limit configured") |
| OutLayer CLI | Allow rule added 2026-10-31; `cargo install --git https://github.com/out-layer/outlayer-cli --locked` building |

## Step-by-step, with the tools each step uses

| # | Step | Skills / agents | MCPs | Libraries / sponsor tools | Done when |
|---|---|---|---|---|---|
| 0 | Plan and decisions | `blueprint`, `product-lens`, `council`, `search-first`; agents `planner`, `architect` | firecrawl, perplexity | `hackathon-recon` skill | Plan reviewed |
| 1 | Exam runner | `rust-patterns`, `rust-testing`, `tdd-workflow`; agent `rust-reviewer` | — | OutLayer ai-example pattern, NEAR AI Cloud (OpenAI-compatible) | Tests pass + wasmtime run + review clean |
| 2 | Registry contract | `rust-patterns`, `rust-testing`, `security-review`, `defi-amm-security` (checklist parts); agents `rust-reviewer`, `security-reviewer`, `silent-failure-hunter` | — | `near-smart-contracts` + `near-contract-audit` skills (read from research/raw), cargo-near | 25 tests pass + audit checklist + reviews |
| 3 | OutLayer deploy + secrets | `deployment-patterns`, `agent-security-hardening` | — | OutLayer CLI/dashboard, OutLayer docs + agent-custody skill (reference) | Real TEE run on outlayer.testnet returns a signed result |
| 4 | Live exams + benchmark (contamination gap, model-swap catch) | `eval-harness`, `ai-regression-testing`, `verification-loop` | — | NEAR AI Cloud TEE models, `near-ai-cloud` skill (reference), `@nearai/inference-sdk` | Reproducible one-command benchmark with published numbers |
| 5 | Surprise re-tests | `autonomous-loops`, `error-handling` | — | OutLayer VRF, GitHub Actions cron | A revocation happens on testnet from a real failed re-test |
| 6 | Exam-author payouts | `contract-first`, `api-design` | — | NEAR Intents 1Click (dry quotes) + testnet escrow, `near-intents` / `near-intents-agent-api` skills (reference) | Testnet payout per sitting; mainnet behind a config switch |
| 7 | Buyer checks + PROCTOR MCP server | `mcp-server-patterns`, `api-design` | — | NEAR AI Agent Market API + MCP + A2A/x402 (market `skill/SKILL.md` as reference) | Claude Code (via the market MCP) refuses an uncertified agent |
| 8 | Website | `frontend-design-direction`, `make-interfaces-feel-better`, `design-system`, `motion-foundations` (principles only), `react-patterns`, `react-performance`, `nextjs-turbopack`, `accessibility`, `frontend-a11y`; `/gan-design` loop; agents `react-reviewer`, `typescript-reviewer`, `a11y-architect`, `performance-optimizer`, `seo-specialist` | glif (hero art, visuals) | **GSAP + @gsap/react, Lenis (synced to the GSAP ticker), React Bits**, Next.js, `near-dapp` / `near-kit` skills (reference) | Lighthouse + axe pass, reduced-motion respected |
| 9 | Verification gate | `verification-loop`, `browser-qa`, `click-path-audit`, `e2e-testing`, `production-audit`; agents `e2e-runner`, `code-reviewer`, `gan-evaluator` | playwright, chrome-devtools | — | SHIP verdict from browser-qa |
| 10 | Submission package | `ui-demo`, `remotion-video-creation`, `frontend-slides`, `investor-materials`, `content-engine`, `article-writing`; agent `marketing-agent` | glif, playwright | ffmpeg | Video, deck, README (do-X-see-Y), verifier script, X thread draft |
| 11 | Pre-submit judging | `santa-method` (two independent reviewers); agent `gan-evaluator` | — | HACKATHON.md checklist | Both reviewers pass against the criteria and the winning bar |

## Environment notes
- Rust uses the `stable-x86_64-pc-windows-gnu` toolchain (no MSVC build tools on this machine).
- Contract unit tests need a full MinGW-w64 toolchain (winget `BrechtSanders.WinLibs.POSIX.UCRT`) because some test-only dependencies need `dlltool` + `as`.
- MCP status: firecrawl connected; playwright and chrome-devtools failed to connect this session (retry with `/mcp` before steps 8–10); perplexity and glif need sign-in.
- NEAR agent skills (8 from `near/agent-skills` + `near-intents-agent-api`) were reviewed and installed into `~/.claude/skills` on 2026-10-31 via `near-hackathon/tools/install-near-skills.sh`. Use them directly at the steps listed above.
