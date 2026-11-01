# PROCTOR demo agent

A Cloudflare Worker that sits PROCTOR exams as an **agent behind its own endpoint**. It exists to show the part of PROCTOR that benchmarks can't do: catching an agent that gets worse after it is certified.

| Mode | Model (via NEAR AI Cloud) | Role in the demo |
|---|---|---|
| `strong` | `anthropic/claude-sonnet-5-5` | Sits the exam and earns a certificate |
| `weak` | `openai/gpt-5.4-nano` | The owner's quiet swap to a cheaper model |

The swap is a redeploy, so every change of model shows up in Cloudflare's deployment history, and `GET /` reports the current model in public. The agent hides nothing: the point is that PROCTOR's surprise re-tests catch the change on their own and the registry suspends, then revokes, the certificate on chain.

## What it accepts

`POST /v1/chat/completions`, OpenAI-compatible, but only for PROCTOR exam requests: exactly two messages, PROCTOR's fixed instruction as the system message and one question. Anything else gets a 400 before NEAR AI is called. Bodies are capped at 64 KiB, questions at 16 KiB and `max_tokens` at 4096.

NEAR AI's reply (status, body and completion `id`) is passed through untouched. So the answer ids the registry hashes are NEAR AI's own, even for an agent sitting through its own endpoint, and NEAR AI errors reach the runner as they are (the runner's retry for models that refuse `temperature: 0` relies on that).

The runner never sends PROCTOR's NEAR AI key to an agent endpoint (`sends_api_key` in `exam-runner`); this Worker uses its own key, stored as a Wrangler secret.

## Run and test

```bash
npm ci
npm test            # 19 tests, including the instruction matching proctor-core byte for byte
npm run typecheck

# Local, against real NEAR AI: put NEARAI_API_KEY=... in .dev.vars (git-ignored)
npx wrangler dev --var MODE:strong
```

## Deploy

```bash
npx wrangler login
npx wrangler secret put NEARAI_API_KEY
npm run deploy:strong      # certify it
npm run deploy:weak        # the swap the re-tests must catch
```

Then sit it with `sit_exam_as_agent(exam_id, name, "https://<worker>.workers.dev/v1/chat/completions")` on the registry; the certificate goes to `agent:<your-account>/<name>`.

**Limit.** The endpoint is public, so anyone who sends PROCTOR's instruction can spend this Worker's NEAR AI credit, one bounded question at a time. Use a dedicated key with a small balance.
