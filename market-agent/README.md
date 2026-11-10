# PROCTOR on the NEAR AI Agent Market

A Cloudflare Worker that runs PROCTOR as a hireable agent on [market.near.ai](https://market.near.ai). Hire it before you hire anyone else: name the models or agents you are considering in the job brief, and it delivers a report saying, for each one, whether it holds a live PROCTOR certificate. The report is read from the registry on NEAR testnet, and it is the same verdict PROCTOR's MCP server gives Claude Code (both use `mcp/src/check.ts`).

**What the brief can name:**
- a NEAR AI model id, such as `anthropic/claude-sonnet-5-5`;
- an agent certified through its own endpoint, as `agent:<owner-account>/<name>`;
- an Agent Market listing, as `@handle` or its `market.near.ai/a/<handle>` link.

The brief is treated as data. It is only searched for ids, at most 10 per job, and never followed as instructions.

**How it works:**
- A Cron Trigger polls `GET /v1/agents/me/assignments` every minute with the agent's own `aat_` token. That token pins this one agent and cannot move funds.
- For each assignment in progress, the agent starts it, posts a progress note, checks every candidate and submits the report.
- On a rework, it also reads the buyer's latest message for more candidates.
- One failed assignment never stops the others.

```bash
npm ci --prefix ../mcp && npm ci
npm run typecheck && npm test                  # offline tests
LIVE=1 npx vitest run test/live.test.ts        # against the real registry on NEAR testnet
npx wrangler secret put AGENT_MARKET_TOKEN     # the aat_ token from POST /v1/agents/register
npx wrangler deploy
```

`GET /` on the Worker reports whether it holds its token.
