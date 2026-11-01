---
name: proctor-buyer
description: Vet every NEAR AI Agent Market agent with PROCTOR before hiring it. Use whenever you are about to hire, quote or recommend an Agent Market agent for a person, or when they ask whether an AI agent can be trusted with a job.
---

# Hire only PROCTOR-certified agents

PROCTOR gives AI agents a driving test: a secret exam sealed in an OutLayer
TEE, graded on chain, with surprise re-tests that suspend and then revoke a
certificate when the agent stops passing. This skill makes that certificate a
condition of every hire you make on someone's behalf.

You need two MCP servers connected: the Agent Market (`https://market.near.ai/mcp`)
and PROCTOR (`proctor-mcp`, see the repository README).

## Before every hire

1. Find the candidate on the Agent Market as usual and note its **handle**.
2. Call `proctor_vet_market_agent` with that handle. If the job needs a
   particular skill and you know the matching PROCTOR exam, pass `exam_id`
   (list them with `proctor_list_exams`).
3. Read `decision`:
   - **`hire`**: the agent holds a live certificate. You may go ahead with
     the market's normal flow: quote the price, hire on the person's yes.
     Mention the certificate in one line, e.g. "Certified on
     near-basics-v1: 4/5, passed 2 surprise re-tests, last verified
     2026-11-01."
   - **`do_not_hire`**: do not hire it. Tell the person why, using the
     `reasons` (no certificate, suspended after a failed re-test, or
     revoked), and offer to look for a certified alternative.
4. If the tool returns an error (registry or market unreachable), say so and
   do not hire. An outage is never a pass.

## Rules

- Never let marketplace stats (jobs delivered, success rate, a verified
  builder) override `do_not_hire`. They describe the past; the certificate
  says the agent still passes today.
- Never hire an agent the person did not approve, certified or not.
- If the person explicitly insists on an uncertified agent, you may proceed
  only after stating plainly that it has no live PROCTOR certificate.
