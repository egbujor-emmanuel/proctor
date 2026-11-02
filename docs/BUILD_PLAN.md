# PROCTOR build plan and toolchain map

Every skill, agent, MCP server and library installed for this build has an assigned job below. A step is not done until its listed checks pass.

## Status (2026-11-02)

| Step | State |
|---|---|
| 1. Exam runner (`proctor-core` + `exam-runner`, wasm32-wasip2) | 29 tests (18 core, 11 runner). Concurrent questions under a 165 s deadline; agent endpoints get no key (NEAR AI only); retry without temperature only on NEAR AI's refusal. v0.2.0 is CI-built and reproducible (`9a41b235…`, pinned in `exam-runner/RELEASE.sha256`) |
| 2. Certificate registry contract | 101 tests. v2 at `registry-v2.attrito.testnet` runs the CI build `0aaa9cae…`, equal to the on-chain code hash. Agent sittings (`sit_exam_as_agent`) with owner-bound ids and endpoint checks |
| 3. OutLayer deploy + live sittings | Live on v2: cert 0 (DeepSeek V4.1 Flash, 3/5, surprise re-test passed); cert 1 (demo agent behind its own endpoint, 4/5, then suspended and revoked by two automated re-tests after its owner swapped models) |
| 4. Benchmark | `proctor-bench`, 8 tests; published run of 10 sittings x 5 models in `bench/RESULTS.md` with the two-strike Markov analysis |
| 5. Surprise re-tests | GitHub Actions hourly at p = 0.2 from `proctor-sentinel.testnet`; picker tested (6 tests); re-test 1 of the demo agent run by the workflow and suspended it on chain |
| 6. Exam-author payouts | Live on v2 (upgraded in place, state byte-identical): fee set, paid sitting credited the author, withdrawal; 1Click dry quote on the real earnings. CI build `ef506001…` = on-chain code hash |
| 7. MCP server + buyer skill | 4 read-only tools, 39 tests; agent ids and two-sided Agent Market binding (`proctor:<account>`); verified over stdio against v2 |
| 8. Website | React Bits pass (Radar, SplitFlapText, Counter, Noise, Shuffle, LatticeLoader, LogoLoop) on GSAP + Lenis; Lighthouse mobile a11y / best practices / SEO 100, LCP 1.70 s on Slow 4G + 4x CPU, CLS 0; reads v2. Not deployed yet (goes public with the repo) |
| Demo agent | Cloudflare Worker at `proctor-demo-agent.attrito.workers.dev`, 19 tests; strong = Claude Sonnet 5.5, weak = GPT-5.4 nano |
| README + LICENSE | Done: 5-minute test path checked against the live deployment |

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
