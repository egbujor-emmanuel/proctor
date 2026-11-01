# PROCTOR build plan and toolchain map

Every skill, agent, MCP server and library installed for this build has an assigned job below. A step is not done until its listed checks pass.

## Status (2026-10-30)

| Step | State |
|---|---|
| 1. Exam runner (`proctor-core` + `exam-runner`, wasm32-wasip2) | 26 tests pass (18 core, 8 runner). Asks questions concurrently (8 at a time) under a 165 s hard deadline. Live run 2026-11-01: DeepSeek V4.1 Flash (TEE) scored 3/5 on the demo exam in 50 s, complete, 5 completion ids. `proctor-seal` prepares exams byte-exactly |
| 2. Certificate registry contract | 74 tests pass. Reviews done and CRITICAL/HIGH findings fixed; 24 h runner timelock, two-step ownership and two-strike revocation added (2026-10-31). Deployed to `registry.attrito.testnet` (runner pinned by hash) |
| NEAR AI key | Working with credits (2026-11-01) |
| 3. OutLayer deploy + live sitting | Done 2026-11-01: runner released at egbujor-emmanuel/proctor-runner v0.1.0 (FastFS testnet was down); exam secrets locked to the runner hash and to calls via the registry; first certificate (cert 0) issued on testnet, tx JAtLV29Xd6DDnomfUURN11R7iqvk6ya8F71baC6ww1Jp |
| 7. MCP server + buyer skill | Done: 4 read-only tools, 29 tests; verified against the live registry |
| 8. Website | Built 2026-11-01 (web/): live registry reads, buyer check, GSAP/Lenis/React Bits, Glif share card. Lighthouse 100 x4 categories desktop+mobile; LCP 1.75 s on Slow 4G + 4x CPU, CLS 0; react, typescript, a11y and performance reviews done and fixed. Not yet deployed (needs a host; set NEXT_PUBLIC_SITE_URL) |
| OutLayer CLI | Installed: `outlayer 0.2.1` (official release binary, SHA-256 checked against GitHub's asset digest) |

## Step-by-step, with the tools each step uses

| # | Step | Skills / agents | MCPs | Libraries / sponsor tools | Done when |
|---|---|---|---|---|---|
| 0 | Plan and decisions | `blueprint`, `product-lens`, `council`, `search-first`; agents `planner`, `architect` | firecrawl, perplexity | `hackathon-recon` skill | Plan reviewed |
| 1 | Exam runner | `rust-patterns`, `rust-testing`, `tdd-workflow`; agent `rust-reviewer` | — | OutLayer ai-example pattern, NEAR AI Cloud (OpenAI-compatible) | Tests pass + wasmtime run + review clean |
| 2 | Registry contract | `rust-patterns`, `rust-testing`, `security-review`, `defi-amm-security` (checklist parts); agents `rust-reviewer`, `security-reviewer`, `silent-failure-hunter` | — | `near-smart-contracts` + `near-contract-audit` skills (read from research/raw), cargo-near | Tests pass + audit checklist + reviews |
| 3 | OutLayer deploy + secrets | `deployment-patterns`, `agent-security-hardening` | — | OutLayer CLI/dashboard, OutLayer docs + agent-custody skill (reference) | Real TEE run on outlayer.testnet returns a signed result |
| 4 | Live exams + benchmark (contamination gap, model-swap catch) | `eval-harness`, `ai-regression-testing`, `verification-loop` | — | NEAR AI Cloud TEE models, `near-ai-cloud` skill (reference), `@nearai/inference-sdk` | Reproducible one-command benchmark with published numbers |
| 5 | Surprise re-tests | `autonomous-loops`, `error-handling` | — | OutLayer VRF, GitHub Actions cron | A revocation happens on testnet from a real failed re-test |
| 6 | Exam-author payouts | `contract-first`, `api-design` | — | NEAR Intents 1Click (dry quotes) + testnet escrow, `near-intents` / `near-intents-agent-api` skills (reference) | Testnet payout per sitting; mainnet behind a config switch |
| 7 | Buyer checks + PROCTOR MCP server | `mcp-server-patterns`, `api-design` | — | NEAR AI Agent Market API + MCP + A2A/x402 (market `skill/SKILL.md` as reference) | Claude Code (via the market MCP) refuses an uncertified agent |
| 8 | Website | `frontend-design-direction`, `make-interfaces-feel-better`, `design-system`, `motion-foundations` (principles only), `react-patterns`, `react-performance`, `nextjs-turbopack`, `accessibility`, `frontend-a11y`; `/gan-design` loop; agents `react-reviewer`, `typescript-reviewer`, `a11y-architect`, `performance-optimizer`, `seo-specialist` | glif (hero art, visuals) | **GSAP + @gsap/react, Lenis (synced to the GSAP ticker), React Bits**, Next.js, `near-dapp` / `near-kit` skills (reference) | Lighthouse + axe pass, reduced-motion respected |
| 9 | Verification gate | `verification-loop`, `browser-qa`, `click-path-audit`, `e2e-testing`, `production-audit`; agents `e2e-runner`, `code-reviewer`, `gan-evaluator` | playwright, chrome-devtools | — | SHIP verdict from browser-qa |
| 10 | Submission package | `ui-demo`, `remotion-video-creation`, `frontend-slides`, `investor-materials`, `content-engine`, `article-writing`; agent `marketing-agent` | glif, playwright | ffmpeg | Video, deck, README opening with "Test it in 5 minutes" (no-setup registry links + read-only call; faucet account + sit an exam; MCP config + refusal prompt; one command for all tests + CI badge), verifier script, X thread draft. Every command re-run from a clean machine |
| 11 | Pre-submit judging | `santa-method` (two independent reviewers); agent `gan-evaluator` | — | HACKATHON.md checklist | Both reviewers pass against the criteria and the winning bar |

## Environment notes
- Rust uses the `stable-x86_64-pc-windows-gnu` toolchain (no MSVC build tools on this machine).
- Contract unit tests need a full MinGW-w64 toolchain (winget `BrechtSanders.WinLibs.POSIX.UCRT`) because some test-only dependencies need `dlltool` + `as`.
- MCP status: firecrawl connected; playwright and chrome-devtools failed to connect this session (retry with `/mcp` before steps 8–10); perplexity and glif need sign-in.
- NEAR agent skills (8 from `near/agent-skills` + `near-intents-agent-api`) were reviewed and installed into `~/.claude/skills` on 2026-10-31 via `near-hackathon/tools/install-near-skills.sh`. Use them directly at the steps listed above.
