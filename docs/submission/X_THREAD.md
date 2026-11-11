# X thread draft (submission post)

Status: ready to post. Attach the full-quality demo video to post 1 (1:59, under X's 2:20 limit), and check every post is under 280 characters (`node docs/submission/count.mjs`).

Every claim below is in the README, with its transaction.

---

**1/** (attach the demo video)

Built at NEAR HACKATHON: PROCTOR, a driving test for AI agents.

An agent passed our secret exam with Claude Sonnet 5.5, then its owner quietly swapped the same URL to GPT-5.4 nano.

Two surprise re-tests later its certificate was revoked, on NEAR. 🧵

**2/**

The problem: public benchmarks leak into training data, and a score says nothing about tomorrow.

An agent certified today can switch to a cheaper model behind the same endpoint, and a buyer has no way to notice.

**3/**

The exam is sealed. It lives only as an OutLayer secret, decrypted inside an Intel TDX enclave for one runner build (pinned by SHA-256) and only on calls through the PROCTOR registry contract.

Only the exam's hash goes on chain.

**4/**

And an agent can't tell it is being tested. Each sitting draws 10 of 28 hidden questions, a TEE-hosted model rewords each one, and the framing changes every time.

That runner went live after a public 24-hour timelock.

**5/**

The certificate has to keep earning its place. A sentinel re-tests a live certificate at random hours, and anyone can order one from the site, free.

One fail suspends it. Two in a row revoke it. Outages never fail a model.

**6/**

The swap demo, on chain:
certified 4/5 → 9Jwx3jXp
suspended 2/5 → BrcXSNwX
revoked 2/5 → 3SGvHzEY

Re-tests ordered from the site caught GPT-5.4 mini, which had passed at exactly the pass mark: suspended, then revoked.

**7/**

The PROCTOR Index: 22 NEAR AI models sat the secret exam on NEAR.

12 certified (Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 at 10/10), 2 failed, and the ones that were down or too slow got no verdict instead of a fail.

**8/**

Money can follow the certificate. Our escrow contract pays an agent's owner only if its certificate is live at delivery, by a cross-contract call to the registry.

It paid a certified agent and refunded the buyer of a revoked one.

**9/**

Check it yourself. One command verifies a sitting: NEAR AI's signature on every answer, the Intel TDX quote against Intel's PCS, and NVIDIA's evidence for 8 GPUs. Verified, 12 checks.

Another re-reads every transaction we cite: 41/41.

**10/**

PROCTOR is hireable on the NEAR AI Agent Market: market.near.ai/a/proctor-check. Name any agent or model and it reports hire or do not hire, read from the chain.

Claude Code can ask the same through PROCTOR's MCP server.

**11/**

Code, contracts, runner, verifier, MCP server, sentinel: https://github.com/egbujor-emmanuel/proctor
Try it, and order a re-test: https://proctor.attrito.workers.dev

Built with NEAR, OutLayer and NEAR AI at NEAR HACKATHON.
