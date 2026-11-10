# Claims, with the evidence for each

Every claim PROCTOR makes, mapped to the code that enforces it, the tests that check it, and the transaction that shows it on NEAR testnet. Test paths are relative to the repository root; `R` is `contracts/registry/src/tests`. Run every suite with `bash scripts/test-all.sh`.

## Certificates

| Claim | Code | Tests | On chain |
|---|---|---|---|
| A certificate is written only from OutLayer's callback, never from a caller's word | `contracts/registry/src/lib.rs` (`on_sitting_result`) | `R/sittings.rs`: `passing_sitting_issues_certificate`; `R/verification.rs`: `malformed_output_is_rejected` | Certificate 0 issued in [`4ewFE77F…`](https://testnet.near.rocks/tx/4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1) |
| The registry, not the runner, decides pass or fail | `verdict.rs`: the pass mark is applied to the re-checked score | `R/sittings.rs`: `pass_mark_is_decided_by_registry_not_runner`, `pass_at_exactly_the_pass_mark_certifies` | — |
| Every result is re-checked: exam, commitment, candidate, sitting, question count, arithmetic | `verdict.rs` (`check_output`) | `R/verification.rs`: `rejects_output_for_a_different_exam`, `rejects_output_for_a_different_candidate`, `rejects_tampered_score`, `rejects_output_replayed_from_another_sitting`, `rejects_a_run_over_fewer_questions_than_registered`, `rejects_complete_flag_that_disagrees_with_failed_calls` | — |
| Two passes racing for one candidate cannot both certify | `verdict.rs` | `R/sittings.rs`: `only_the_first_of_two_concurrent_passes_certifies` | — |

## Surprise re-tests

| Claim | Code | Tests | On chain |
|---|---|---|---|
| One failed re-test suspends, a second in a row revokes, a pass restores | `contracts/registry/src/verdict.rs` (`apply_output`) | `R/retests.rs`: `first_failed_retest_suspends_the_certificate`, `second_failed_retest_in_a_row_revokes`, `passing_retest_restores_a_suspended_certificate` | Model swap: suspended [`BrcXSNwX…`](https://testnet.near.rocks/tx/BrcXSNwX1qy7APxoTDNL5heFN22eB5FqoBT4teiQPUYX), revoked [`3SGvHzEY…`](https://testnet.near.rocks/tx/3SGvHzEY7c2Bo91eehtnapZbXE2eVk5mv4y1DDPWBLm4). Certificate 0: suspended, restored, revoked by the sentinel alone |
| Outages never fail a NEAR AI model candidate | `verdict.rs` (`finish_sitting`) | `R/hardening.rs`: `a_model_candidate_is_never_struck_for_outages`; `R/retests.rs`: `outages_while_suspended_neither_restore_nor_revoke` | Incomplete re-test, slot given back: [`5bspuwmb…`](https://testnet.near.rocks/tx/5bspuwmbcfgoUN4rUyGTZN6o746szJEF3uQTEDBWajUG) |
| An agent whose own endpoint goes silent three re-tests in a row takes a strike | `verdict.rs` (`track_silence`) | `R/hardening.rs`: `an_agent_that_goes_silent_on_its_re_tests_is_suspended_then_revoked`, `an_agents_silent_re_test_keeps_the_hourly_gap` | — |
| Re-tests are at most hourly, one at a time | `contracts/registry/src/lib.rs` (`retest`) | `R/retests.rs`: `retests_are_rate_limited`, `only_one_retest_runs_at_a_time` | Sentinel history: [`proctor-sentinel.testnet`](https://testnet.near.rocks/account/proctor-sentinel.testnet) |

## The exam and the grader

| Claim | Code | Tests | On chain |
|---|---|---|---|
| The exam is readable only by one runner build, only through the registry | OutLayer secret bound with `--wasm-hash` and `--via` (`scripts/register-exam.sh`) | Shown live: a different build cannot read the secret | — |
| The grader cannot change without a public 24-hour notice | `contracts/registry/src/admin.rs` (`propose_runner`, `apply_runner`) | `R/admin.rs`: `runner_change_cannot_be_applied_early`, `a_new_proposal_restarts_the_clock`, `a_wasm_url_must_carry_the_registered_hash` | v0.3.0 proposed [`D4KL4eTU…`](https://testnet.near.rocks/tx/D4KL4eTUPbV8TMbyy5RVcaakxPZFG2MRuZxn51CfQYvu), applied a day later [`8pfhCZdk…`](https://testnet.near.rocks/tx/8pfhCZdkc5VtouG8SRMZJhj23WFRxMWMEtVok6zckFMQ). v0.4.0 proposed [`2KDazh4w…`](https://testnet.near.rocks/tx/2KDazh4wsFc564HaQjhS8MVqmSMPHBGqirPuWHczkJni), applied a day later [`HQx9am4Q…`](https://testnet.near.rocks/tx/HQx9am4QrjSEbptjvsJpfLkB87iB8U5Z491J25jVqgte) |
| Each runner build is reproducible and pinned by SHA-256 | `scripts/build-runner.sh`, `exam-runner/RELEASE.sha256` | CI job "Exam runner release build (reproducible, hash-checked)" | Releases: [proctor-runner](https://github.com/egbujor-emmanuel/proctor-runner/releases) |
| A slow or stalling candidate is a failed call, never a lost run | `exam-runner/src/main.rs` (`ATTEMPT_TIMEOUT_SECS`, `with_attempts`) | `exam-runner`: `a_timed_out_question_is_asked_once_more`, `the_last_attempt_never_runs_past_the_deadline` | Same stalling endpoint: v0.2.0 lost the run [`7twfXXC8…`](https://testnet.near.rocks/tx/7twfXXC81HAGRxg8VnMQrmWTjAMQ6aqrrLiiUpcwFPbz); v0.3.0 `Incomplete` [`CMKgmSKG…`](https://testnet.near.rocks/tx/CMKgmSKGk8pNDmnA32hYSkJSfL5HP15xzhzhBrShR8W7) |
| A sitting cannot be recognised as a test (runner v0.4.0) | `proctor-core/src/sitting.rs` (`plan`, `Framing`, `rewording_is_safe`) | `proctor-core`: `plan_asks_the_sample_size_and_varies_between_sittings`, `framings_vary_and_name_their_marker`, `rewording_keeps_every_number_or_is_rejected`; `exam-runner`: `a_request_without_a_system_message_is_a_plain_user_turn` | Live since [`HQx9am4Q…`](https://testnet.near.rocks/tx/HQx9am4QrjSEbptjvsJpfLkB87iB8U5Z491J25jVqgte); first certificate on it: Claude Sonnet 5.5, 10/10 on the pool exam [`7fHjeDpb…`](https://testnet.near.rocks/tx/7fHjeDpb6ViT2gQkP4PoKLvwPfDyGb4NWo8Jyk16T68z) |
| An agent cannot borrow PROCTOR's NEAR AI key | `exam-runner/src/main.rs` (`sends_api_key`) | `exam-runner`: `only_near_ai_receives_the_api_key` | — |

## Agents

| Claim | Code | Tests | On chain |
|---|---|---|---|
| Only the account that registers an agent can certify it | `lib.rs` (`sit_exam_as_agent`) | `R/agents.rs`: `nobody_can_certify_an_agent_under_someone_elses_account`, `an_agent_name_cannot_fake_an_owner` | Demo agent certified [`9Jwx3jXp…`](https://testnet.near.rocks/tx/9Jwx3jXp8We4a77VVBNv7qGLKpL48UC3zF8uf7CX9yT5) |
| Re-tests ask the certified endpoint, and only public HTTPS hosts are accepted | `contracts/registry/src/checks.rs` (`require_endpoint`) | `R/agents.rs`: `an_answer_from_another_endpoint_is_rejected`; `R/hardening.rs`: `endpoints_must_be_public_https_hosts` | — |
| Exam authors decide whether agents may sit | `lib.rs` (`set_exam_agents`) | `R/hardening.rs`: `agents_need_the_authors_permission`, `only_the_author_decides_about_agents` | — |

## Payments

| Claim | Code | Tests | On chain |
|---|---|---|---|
| Authors are paid on a verdict; outages refund whoever paid | `contracts/registry/src/payouts.rs` | `R/payouts.rs`: `a_verdict_pays_the_author_whether_the_candidate_passes_or_fails`, `an_outage_or_a_bad_run_refunds_the_fee_to_whoever_paid`, `re_tests_carry_no_author_fee` | Fee set [`F7LAcipJ…`](https://testnet.near.rocks/tx/F7LAcipJjpsesrfxGrgbRPCff7oax1SSLeSK99TVBw26), credited [`F2rq3Gxu…`](https://testnet.near.rocks/tx/F2rq3GxuZyg8mi3oFaaqDGBLyLQzeVhxWrW6F2jxn2bQ), withdrawn [`z53mcD6N…`](https://testnet.near.rocks/tx/z53mcD6N5wrzgW4FtB66UJ5SA8XUcjJn3ufgio7RjFR) |
| A failed withdrawal puts the earnings back | `payouts.rs` (`on_withdrawn`) | `R/hardening.rs`: `a_failed_withdrawal_puts_the_earnings_back` | — |
| Escrow pays an agent's owner only if its certificate is live at delivery | `contracts/escrow/src/lib.rs` (`deliver`, `on_checked`) | `contracts/escrow/src/tests.rs`: `a_live_certificate_at_delivery_pays_the_owner`, `a_certificate_that_is_no_longer_live_refunds_the_buyer`, `nobody_but_the_agents_owner_can_deliver`, `a_failed_registry_call_reopens_the_job_instead_of_locking_funds` | Live certificate, owner paid: [`AuzUsAoZ…`](https://testnet.near.rocks/tx/AuzUsAoZrXw9Hvz6VEe8UYXenAWxDHz1F1vqiE67ek7y). Revoked agent, buyer refunded: [`ypHUGxQg…`](https://testnet.near.rocks/tx/ypHUGxQgLae18JAXigcJo2hGYwY2grKBAZHZJSH8NJK) |
| The deployed escrow is the CI build | `scripts/build-escrow.sh`, `contracts/escrow/RELEASE.sha256` | CI job "Escrow contract release build (hash-checked)" | `proctor-escrow.testnet` code SHA-256 `5fcb47b1…0067dc`, deployed in [`zzoYwa55…`](https://testnet.near.rocks/tx/zzoYwa55fp4uhoauUVsz9X7nRXzT6ZzRF3DuccCSxZN) |

## Verification anyone can run

| Claim | Code | Tests | Result |
|---|---|---|---|
| Every answer id is a real NEAR AI completion, signed by an attested key | `mcp/src/verify.ts` (`checkAnswer`) | `mcp/test/verify.test.ts` | `npm --prefix mcp run verify -- --tx 4ewFE77F… --sender attrito.testnet` |
| The hardware under those keys is checked: Intel TDX quote (against Intel's PCS), no debug mode, key and nonce bound in the quote, measured software, NVIDIA GPU evidence | `mcp/src/attest.ts` (`checkHardware`) | `mcp/test/attest.test.ts` (out-of-date TCB, debug, replayed nonce, forged NVIDIA token, GPU in debug: each fails) | Certificate 0: 12 checks, 8 GPUs attested |
| The website and the MCP server give the same verdict | `mcp/src/verdict.ts`, imported by `web/src/lib/check.ts` | `mcp/test/verdict.test.ts`, `web/src/lib/__tests__/check.test.ts`, `web/e2e/site.e2e.cjs` (45 browser checks) | [proctor.attrito.workers.dev](https://proctor.attrito.workers.dev) |

## Attacks the registry refuses

| Attack | Refused by | Test |
|---|---|---|
| Replay a passing result from another sitting | `verdict.rs` | `R/verification.rs`: `rejects_output_replayed_from_another_sitting` |
| Inflate a score | `verdict.rs` | `R/verification.rs`: `rejects_tampered_score` |
| Answer fewer questions than registered | `verdict.rs` | `R/verification.rs`: `rejects_a_run_over_fewer_questions_than_registered` |
| Certify an agent under another account | `lib.rs` | `R/agents.rs`: `nobody_can_certify_an_agent_under_someone_elses_account` |
| Swap the agent's endpoint after certification | `verdict.rs` | `R/agents.rs`: `an_answer_from_another_endpoint_is_rejected` |
| Point an agent endpoint at a private or encoded host | `checks.rs` | `R/hardening.rs`: `endpoints_must_be_public_https_hosts` |
| Escape a suspension by sitting again | `lib.rs` | `R/retests.rs`: `suspended_candidate_cannot_start_over_with_a_fresh_sitting` |
| Swap the grader overnight | `admin.rs` | `R/admin.rs`: `runner_change_cannot_be_applied_early` |
| Take ownership without the new owner accepting | `admin.rs` | `R/admin.rs`: `ownership_moves_only_when_the_new_owner_accepts` |
| Run a runner from a mutable source | `checks.rs` | `R/admin.rs`: `a_project_source_is_refused_because_its_active_version_can_change` |
| Deliver an escrow job for an agent you do not own | escrow `lib.rs` | `contracts/escrow/src/tests.rs`: `nobody_but_the_agents_owner_can_deliver` |
| Get paid twice for one escrow job | escrow `lib.rs` | `contracts/escrow/src/tests.rs`: `a_job_cannot_be_delivered_twice` |
