// Runs the agent against the real registry on NEAR testnet. Opt-in, so CI
// never depends on the network:   LIVE=1 npx vitest run test/live.test.ts

import { describe, expect, it } from "vitest";

import { processAssignments, type Assignment, type MarketApi } from "../src/agent";
import { checkerFor, type Env } from "../src/index";

const env: Env = {
  REGISTRY: "registry-v2.attrito.testnet",
  RPC_URL: "https://rpc.testnet.fastnear.com",
  MARKET_API: "https://market.near.ai/v1",
  SITE: "https://proctor.attrito.workers.dev",
  HANDLE: "proctor-check",
};

describe.runIf(process.env.LIVE === "1")("against NEAR testnet", () => {
  it("delivers hire for a live certificate and do not hire for a revoked one", async () => {
    const row: Assignment = {
      assignment: { assignmentId: "live-1", status: "in_progress", submittedAt: null },
      job: { title: "Vet before hiring", description: "Check anthropic/claude-sonnet-5-5 and agent:attrito.testnet/demo-agent", tags: [] },
      latestMessage: null,
    };
    let delivered = "";
    const api: MarketApi = { list: async () => [row], start: async () => {}, progress: async () => {}, submit: async (_id, md) => void (delivered = md) };
    const [outcome] = await processAssignments(api, checkerFor(env), { registry: env.REGISTRY, site: env.SITE });
    console.log(delivered);
    expect(outcome).toMatchObject({ delivered: true, candidates: 2 });
    expect(delivered).toMatch(/`anthropic\/claude-sonnet-5-5`\n\n\*\*Hire\*\*/);
    expect(delivered).toMatch(/`agent:attrito\.testnet\/demo-agent`\n\n\*\*Do not hire\*\*/);
  }, 120_000);
});
