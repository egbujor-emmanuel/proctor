# Threat model: how a candidate, an operator or a buyer could try to beat PROCTOR

PROCTOR is worth something only if a certificate means what it says: this model or agent passed a secret exam, and still passes it today. This document lists the ways someone could try to make a certificate lie, or to take money they are not owed. For each attack it gives what the attacker would gain, what stops it in the code, the test that exercises that rule, and a transaction that shows it on NEAR testnet where one exists.

Test paths are relative to the repository root; `R` is `contracts/registry/src/tests`. Every suite runs with `bash scripts/test-all.sh`, and every transaction here is re-checked against the chain by `node scripts/evidence.mjs`.

## 1. Cheating the exam

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A1 | Read the questions in advance, from the repository, the chain or PROCTOR's operator | Train on the exam and pass without the skill | The exam exists only as an OutLayer secret. It is decrypted inside the Intel TDX enclave for one runner build (pinned by SHA-256, `--wasm-hash`) and only on calls through the registry (`--via`). The chain holds only the exam's SHA-256 commitment. See `scripts/register-exam.sh` | Secret binding is OutLayer's access condition, set by `register-exam.sh`; the commitment check is `R/verification.rs`: `rejects_output_for_a_different_exam` | Pool exam registered with commitment `0e426660…` |
| A2 | Harvest the questions by sitting as an agent and logging what its endpoint is asked | Collect the secret exam one sitting at a time | An agent's endpoint sees the questions it answers, so agent sittings are refused unless the exam's author allows them (`set_exam_agents`). The secret pool exam does not allow them | `R/hardening.rs`: `agents_need_the_authors_permission`, `only_the_author_decides_about_agents` | — |
| A3 | Recognise that a request is a test, and switch to a stronger model only then | Pass with a model it does not serve to buyers | Runner v0.4.0: each sitting draws a fresh random 10 of 28 questions, a TEE-hosted NEAR AI model rewords each one (a rewording that drops a number is discarded), and the framing (system message, answer marker) changes every time (`proctor-core/src/sitting.rs`) | `proctor-core`: `plan_asks_the_sample_size_and_varies_between_sittings`, `framings_vary_and_name_their_marker`, `rewording_keeps_every_number_or_is_rejected` | First v0.4.0 certificate [`7fHjeDpb…`](https://testnet.near.rocks/tx/7fHjeDpb6ViT2gQkP4PoKLvwPfDyGb4NWo8Jyk16T68z) |
| A4 | Report a score instead of earning one | A certificate without sitting the exam | Certificates are written only in the registry's own callback for OutLayer's result (`on_sitting_result`); no caller can write one | `R/sittings.rs`: `passing_sitting_issues_certificate`; `R/verification.rs`: `malformed_output_is_rejected` | Certificate 0 [`4ewFE77F…`](https://testnet.near.rocks/tx/4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1) |
| A5 | Inflate the score in the runner's output, or grade fewer questions than registered | Pass with fewer right answers | The registry re-checks the exam, commitment, candidate, sitting, question count and arithmetic, then applies its own pass mark (`verdict.rs`) | `R/verification.rs`: `rejects_tampered_score`, `rejects_a_run_over_fewer_questions_than_registered`; `R/sittings.rs`: `pass_mark_is_decided_by_registry_not_runner` | — |
| A6 | Replay a passing result from another sitting | Reuse one good run for a new certificate | Each output names its sitting; one from another sitting is refused | `R/verification.rs`: `rejects_output_replayed_from_another_sitting` | — |
| A7 | Claim answers came from NEAR AI when they did not | Pass with answers from anywhere | Each answer id must carry NEAR AI's signature from a key in NEAR AI's attestation report, and the verifier checks the hardware under that key: the Intel TDX quote against Intel's PCS (up-to-date TCB, no debug mode, the key and a fresh nonce bound in the quote) and NVIDIA's evidence for every GPU | `mcp/test/verify.test.ts`: `recovers a different key if the signed text was altered`; `mcp/test/attest.test.ts`: `fails a quote made for another nonce (a replayed report)`, `fails GPU tokens not signed by NVIDIA`, `fails a debuggable enclave` | `npm --prefix mcp run verify -- --tx 4ewFE77F… --sender attrito.testnet`: 12 checks |

## 2. Keeping a certificate it no longer deserves

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A8 | Pass, then quietly swap to a cheaper model behind the same endpoint | Keep earning on a certificate the new model would fail | Surprise re-tests from the sentinel at random hours, and from anyone through the website. One failure suspends; a second in a row revokes | `R/retests.rs`: `first_failed_retest_suspends_the_certificate`, `second_failed_retest_in_a_row_revokes` | Demo agent suspended [`BrcXSNwX…`](https://testnet.near.rocks/tx/BrcXSNwX1qy7APxoTDNL5heFN22eB5FqoBT4teiQPUYX) and revoked [`3SGvHzEY…`](https://testnet.near.rocks/tx/3SGvHzEY7c2Bo91eehtnapZbXE2eVk5mv4y1DDPWBLm4); certificate 3 suspended [`HzFpgdpJ…`](https://testnet.near.rocks/tx/HzFpgdpJEwGzhQTaSE8Euc2N6M2MT1Gz9yVH2X5Ccy7F) and revoked [`DU8puirp…`](https://testnet.near.rocks/tx/DU8puirp7PK8wDuqDMzddUC3zG2BH1X8KRfi1BQkKJFC) |
| A9 | Answer re-tests from a different, stronger endpoint than the one buyers use | Pass re-tests without the served model passing | The endpoint is stored on the certificate, every re-test calls that endpoint, and an answer naming another endpoint is refused | `R/agents.rs`: `an_answer_from_another_endpoint_is_rejected` | — |
| A10 | Go silent whenever a re-test arrives | Dodge every re-test | An agent whose own endpoint leaves three re-tests in a row incomplete takes a strike as if it had failed one, and those strikes stay at least an hour apart | `R/hardening.rs`: `an_agent_that_goes_silent_on_its_re_tests_is_suspended_then_revoked`, `an_agents_silent_re_test_keeps_the_hourly_gap` | — |
| A11 | Escape a suspension by starting a fresh first sitting | Wipe the strike | A suspended candidate cannot start over; only a passing re-test restores it | `R/retests.rs`: `suspended_candidate_cannot_start_over_with_a_fresh_sitting`, `passing_retest_restores_a_suspended_certificate` | Certificate 0: suspended, restored, revoked, all by random re-tests |
| A12 | Race two passing sittings for one candidate | Two certificates, or a second to fall back on | Only the first of two concurrent passes certifies | `R/sittings.rs`: `only_the_first_of_two_concurrent_passes_certifies` | — |

## 3. Abusing the re-test system

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A13 | Block a rival's re-tests by triggering failed runs that use up the hourly slot | Keep a weak certificate safe from re-tests | A re-test that judged nothing (an outage or a failed run) gives the hourly slot back | `R/hardening.rs`: `a_re_test_that_judged_nothing_does_not_use_up_the_hourly_slot`, `an_outage_also_gives_the_slot_back` | Slot given back [`5bspuwmb…`](https://testnet.near.rocks/tx/5bspuwmbcfgoUN4rUyGTZN6o746szJEF3uQTEDBWajUG) |
| A14 | Get an honest model struck during a NEAR AI outage | Knock a competitor off the Index | An outage is a failed call, not a wrong answer. An incomplete run never certifies, suspends or revokes a NEAR AI model | `R/hardening.rs`: `a_model_candidate_is_never_struck_for_outages`; `R/retests.rs`: `outages_while_suspended_neither_restore_nor_revoke` | 8 Index sittings recorded `Incomplete`, none failed |
| A15 | Re-test one certificate over and over | Fish for an unlucky failure | Re-tests are at most hourly per certificate and one at a time | `R/retests.rs`: `retests_are_rate_limited`, `only_one_retest_runs_at_a_time` | — |
| A16 | Spam the website's free re-test button | Drain the sentinel's account | The registry's hourly limit per certificate, plus a daily cap of 48 website re-tests; a refused request sends nothing | `sentinel/test/ondemand.test.ts`: `stops at the daily cap so nobody can drain the sentinel's account`, `refuses a certificate that was re-tested less than an hour ago, without sending anything` | Re-tests ordered from the site: GPT-5.4 mini suspended [`Eokg4Rja…`](https://testnet.near.rocks/tx/Eokg4Rja1MzFuHDKo998LNrtJNuqSRk21H9qF22PkK4U), then revoked [`GsSvi1Rn…`](https://testnet.near.rocks/tx/GsSvi1Rn5axL1rSD3q1o4fZVga5ECrJD73dwVa7BMRkp) |

## 4. Impersonation and keys

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A17 | Certify an agent under someone else's account, or with a name that fakes an owner | Borrow a reputation | Agents are certified as `agent:<owner>/<name>`, and only `<owner>` can first certify that name | `R/agents.rs`: `nobody_can_certify_an_agent_under_someone_elses_account`, `an_agent_name_cannot_fake_an_owner` | Demo agent certified by its owner [`9Jwx3jXp…`](https://testnet.near.rocks/tx/9Jwx3jXp8We4a77VVBNv7qGLKpL48UC3zF8uf7CX9yT5) |
| A18 | Point an agent's endpoint at a private or disguised host | Make the enclave call internal services | Endpoints must be public `https` host names: no IP literals, ports, userinfo, local names or encoded hosts | `R/hardening.rs`: `endpoints_must_be_public_https_hosts` | — |
| A19 | Have the runner send PROCTOR's NEAR AI key to an agent's endpoint | Use PROCTOR's credits, or impersonate it | The runner sends the key only to `https://cloud-api.near.ai/`; look-alike hosts and userinfo tricks are refused | `exam-runner`: `only_near_ai_receives_the_api_key` | — |

## 5. The operator

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A20 | Swap the grader for a friendlier one overnight | Pass or fail candidates at will | A new runner build is proposed on chain and can take effect only 24 hours later; it must be a pinned URL plus SHA-256, never a mutable source | `R/admin.rs`: `runner_change_cannot_be_applied_early`, `a_new_proposal_restarts_the_clock`, `a_wasm_url_must_carry_the_registered_hash`, `a_project_source_is_refused_because_its_active_version_can_change` | v0.4.0 proposed [`2KDazh4w…`](https://testnet.near.rocks/tx/2KDazh4wsFc564HaQjhS8MVqmSMPHBGqirPuWHczkJni), applied a day later [`HQx9am4Q…`](https://testnet.near.rocks/tx/HQx9am4QrjSEbptjvsJpfLkB87iB8U5Z491J25jVqgte) |
| A21 | Deploy code that is not what the repository shows | Hide a rule change | The registry, escrow and runner are built reproducibly in CI and pinned in `RELEASE.sha256`; the website checks on every visit that the deployed code hashes match | CI jobs "Registry contract release build (hash-checked)", "Escrow contract release build (hash-checked)", "Exam runner release build"; `web/src/lib/__tests__/live-checks.test.ts` | [proctor.attrito.workers.dev/#verify](https://proctor.attrito.workers.dev/#verify): 5 of 5 passed |

## 6. Money

| # | The attack | What it would gain | What stops it | Test | On chain |
|---|---|---|---|---|---|
| A22 | Collect an escrow payment for an agent you do not own, twice, or after its certificate lapsed | Take a buyer's money without a certified agent | Only the account in the agent id may deliver; a job is marked `Checking` before the registry call so it cannot be delivered twice; the owner is paid only if `is_certified` says yes at delivery, else the buyer is refunded; a failed registry call reopens the job instead of locking funds | `contracts/escrow/src/tests.rs`: `nobody_but_the_agents_owner_can_deliver`, `a_job_cannot_be_delivered_twice`, `a_certificate_that_is_no_longer_live_refunds_the_buyer`, `a_failed_registry_call_reopens_the_job_instead_of_locking_funds` | Paid [`AuzUsAoZ…`](https://testnet.near.rocks/tx/AuzUsAoZrXw9Hvz6VEe8UYXenAWxDHz1F1vqiE67ek7y), refunded for a revoked agent [`ypHUGxQg…`](https://testnet.near.rocks/tx/ypHUGxQgLae18JAXigcJo2hGYwY2grKBAZHZJSH8NJK) |
| A23 | Take over the registry by proposing yourself as owner | Control exams and the grader | Ownership moves only when the proposed owner accepts | `R/admin.rs`: `ownership_moves_only_when_the_new_owner_accepts` | — |

## Checks anyone can run before trusting a certificate

1. Open [proctor.attrito.workers.dev/#verify](https://proctor.attrito.workers.dev/#verify): the deployed code, the pinned runner, the timelock and the sentinel, read from the chain on load.
2. Ask the MCP server or the site's buyer check for the candidate: `hire` only for a live certificate on an exam by a trusted author.
3. Order a surprise re-test from the certificate on the site, and watch the verdict land.
4. `npm --prefix mcp run verify -- --tx <sitting tx> --sender <account>`: every answer's NEAR AI signature and the hardware under it.
5. `node scripts/evidence.mjs`: every transaction this repository cites, read back from the chain.
