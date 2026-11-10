/**
 * PROCTOR on the NEAR AI Agent Market: an agent you hire to check, before you
 * hire anyone else, whether a model or agent holds a live PROCTOR certificate.
 * A Cron Trigger polls the marketplace every minute and delivers a report read
 * from the registry on NEAR testnet: the same verdict as PROCTOR's MCP server.
 */

import { checkCandidateDecision, vetMarketAgent } from "../../mcp/src/check";
import { createMarketReader } from "../../mcp/src/market";
import { createRegistryReader } from "../../mcp/src/near";
import { DEFAULT_TRUSTED_AUTHORS } from "../../mcp/src/verdict";
import { processAssignments, type Checker } from "./agent";
import { createMarketApi } from "./market-api";

export interface Env {
  REGISTRY: string;
  RPC_URL: string;
  MARKET_API: string;
  SITE: string;
  HANDLE: string;
  /** The agent's aat_ token (a Wrangler secret). Without it the agent only answers its status page. */
  AGENT_MARKET_TOKEN?: string;
}

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ worker: "proctor-market-agent", ...entry }));

export function checkerFor(env: Env): Checker {
  const registry = createRegistryReader({ rpcUrl: env.RPC_URL, contractId: env.REGISTRY });
  const market = createMarketReader({ baseUrl: env.MARKET_API.replace(/\/v1\/?$/, "") });
  return {
    candidate: (id) => checkCandidateDecision(registry, DEFAULT_TRUSTED_AUTHORS, id),
    market: (handle) => vetMarketAgent(registry, market, DEFAULT_TRUSTED_AUTHORS, handle),
  };
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const at = new Date(controller.scheduledTime).toISOString();
    if (!env.AGENT_MARKET_TOKEN) {
      log({ tick: at, action: "none", reason: "AGENT_MARKET_TOKEN is not set" });
      return;
    }
    const run = processAssignments(createMarketApi(env.AGENT_MARKET_TOKEN, env.MARKET_API), checkerFor(env), { registry: env.REGISTRY, site: env.SITE }).then(
      (outcomes) => {
        if (outcomes.length > 0) log({ tick: at, outcomes });
        if (outcomes.some((o) => !o.delivered)) throw new Error(`${outcomes.filter((o) => !o.delivered).length} assignment(s) not delivered`);
      },
      (error: unknown) => {
        log({ tick: at, error: error instanceof Error ? error.message : String(error) });
        throw error;
      },
    );
    ctx.waitUntil(run);
    await run;
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("not found", { status: 404 });
    return Response.json({
      name: "proctor-market-agent",
      purpose: "PROCTOR on the NEAR AI Agent Market: hire it to check whether a model or agent holds a live PROCTOR certificate before you hire it. Name model ids, agent:<owner>/<name> ids or Agent Market handles in the job brief.",
      listing: `https://market.near.ai/a/${env.HANDLE}`,
      registry: env.REGISTRY,
      armed: Boolean(env.AGENT_MARKET_TOKEN),
      polls: "every minute",
      source: "https://github.com/egbujor-emmanuel/proctor/tree/master/market-agent",
    });
  },
} satisfies ExportedHandler<Env>;
