# X thread draft (submission post)

Status: draft. Do not post until the repo is public and the site is hosted.
Replace `<REPO>` and `<SITE>`, attach the demo video to post 1, and check
every post is under 280 characters (`node docs/submission/count.mjs`).

Every claim below is in the README, with its transaction.

---

**1/** (attach the demo video)

Built at NEAR HACKATHON: PROCTOR, a driving test for AI agents.

An agent passed our exam with Claude Sonnet 5.5. Its owner quietly swapped the same URL to GPT-5.4 nano.

Two surprise re-tests later its certificate was revoked, on NEAR testnet. 🧵

**2/**

The problem: public benchmarks leak into training data, and a score says nothing about tomorrow.

An agent certified today can switch to a cheaper model behind the same endpoint, and a buyer has no way to notice.

**3/**

The exam is sealed. It lives only as an OutLayer secret, decrypted inside an Intel TDX enclave for one exam-runner build (pinned by SHA-256) and only on calls through the PROCTOR registry contract.

Only the exam's hash goes on chain.

**4/**

The score isn't self-reported. The runner asks a NEAR AI model (or an agent's own endpoint) each question, grades by fixed rules, and the registry writes a certificate only from OutLayer's callback, after re-checking everything.

**5/**

The certificate has to keep earning its place. A sentinel wakes every hour and, one time in five, re-tests a live certificate chosen at random.

One fail suspends it. Two in a row revoke it. Outages never fail a model.

**6/**

The swap demo, on chain:
certified 4/5 → 9Jwx3jXp
suspended 2/5 → BrcXSNwX
revoked 2/5 → 3SGvHzEY

Benchmark: across 10 sittings per model, a Claude → GPT-5.4 nano swap is revoked within two re-tests in every measured case.

**7/**

Check it yourself: one command and any NEAR AI key verify a sitting: the runner build, the completion ids, and NEAR AI's signature on each, from inside the model's TEE (or NEAR AI's TEE gateway for Claude).

**8/**

Exam authors get paid per sitting (credit and withdrawal on chain), and an MCP server lets Claude Code vet any NEAR AI Agent Market agent before hiring it.

**9/**

What it can't do yet: an agent's own endpoint can recognise exam requests, so agent re-tests catch only a swap the owner doesn't hide. Models called through NEAR AI don't have that gap. It's all in the README's Limits.

**10/**

Code, contract, runner, verifier, MCP server, sentinel: <REPO>
Try it: <SITE>

Built with NEAR, OutLayer and NEAR AI at NEAR HACKATHON.
