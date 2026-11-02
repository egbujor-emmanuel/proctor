/**
 * PROCTOR's sentinel: a Cloudflare Worker whose Cron Trigger wakes it every
 * hour. Each tick it expires re-tests whose callback never came, and with
 * probability CHANCE (so the hours cannot be predicted) re-tests one live
 * certificate chosen at random, signing from the sentinel testnet account.
 * Every action is a public NEAR transaction from that account; the Worker's
 * logs record each tick, including the ones that do nothing.
 */

import { Account, type KeyPairString, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";

import { outcomeFromLogs, plan, VERDICTS } from "./plan";
import { chainNowNs, listCertificates, view } from "./registry";

export interface Env {
  REGISTRY: string;
  SENTINEL_ACCOUNT: string;
  RPC_URL: string;
  /** Probability that a tick runs a re-test, e.g. "0.2". */
  CHANCE: string;
  SENTINEL_PRIVATE_KEY?: string;
}

/** Re-tests pay no author fee; this covers storage plus OutLayer, which refunds what it doesn't use. */
const RETEST_DEPOSIT = "0.06" as const;

/** Signs and sends one registry call; returns the tx hash and every receipt log. */
export type Send = (method: string, args: object, gasTgas: `${number}`, depositNear: `${number}`) => Promise<{ tx: string; logs: string[] }>;

function nearSender(env: Env): Send {
  const provider = new JsonRpcProvider({ url: env.RPC_URL });
  const account = new Account(env.SENTINEL_ACCOUNT, provider, env.SENTINEL_PRIVATE_KEY as KeyPairString);
  return async (method, args, gasTgas, depositNear) => {
    const result = await account.callFunctionRaw({
      contractId: env.REGISTRY,
      methodName: method,
      args,
      gas: teraToGas(gasTgas),
      deposit: nearToYocto(depositNear),
      waitUntil: "FINAL",
    });
    const tx = result.transaction_outcome?.id ?? "unknown";
    const logs = (result.receipts_outcome ?? []).flatMap((r) => r.outcome.logs ?? []);
    return { tx, logs };
  };
}

const log = (entry: Record<string, unknown>) => console.log(JSON.stringify({ worker: "proctor-sentinel", ...entry }));

function uniform(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
}

function randomBelow(n: number): number {
  return Math.floor(uniform() * n);
}

/** One scheduled tick. Throws on any failure so Cloudflare records the invocation as failed. */
export async function tick(env: Env, send: Send, roll = uniform(), random = randomBelow): Promise<Record<string, unknown>> {
  const chance = Number(env.CHANCE);
  if (!(chance >= 0 && chance <= 1)) throw new Error(`CHANCE must be between 0 and 1, got ${env.CHANCE}`);
  const certs = await listCertificates(env.RPC_URL, env.REGISTRY);
  const requestedAt = new Map<number, string>();
  for (const id of certs.map((c) => c.retest_in_flight).filter((id): id is number => id !== null)) {
    const sitting = await view<{ requested_at_ns: string } | null>(env.RPC_URL, env.REGISTRY, "get_sitting", { sitting_id: id });
    if (sitting) requestedAt.set(id, sitting.requested_at_ns);
  }
  const step = plan(certs, requestedAt, await chainNowNs(env.RPC_URL), chance, roll, random);

  const expired: string[] = [];
  for (const id of step.expire) {
    const { tx } = await send("expire_sitting", { sitting_id: id }, "30", "0");
    expired.push(`${id}:${tx}`);
  }
  if (!step.retest) return { action: "none", reason: step.skip, expired };

  const { tx, logs } = await send("retest", { cert_id: step.retest.cert_id }, "300", RETEST_DEPOSIT);
  const outcome = outcomeFromLogs(logs);
  const result = { action: "retest", cert_id: step.retest.cert_id, candidate: step.retest.candidate, tx, outcome: outcome ?? "none", expired };
  // Only a verdict counts; anything else must show up as a failed invocation.
  if (!outcome || !VERDICTS.has(outcome)) throw new Error(`re-test ended without a verdict: ${JSON.stringify(result)}`);
  return result;
}

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const startedAt = new Date(controller.scheduledTime).toISOString();
    if (!env.SENTINEL_PRIVATE_KEY) {
      log({ tick: startedAt, action: "none", reason: "SENTINEL_PRIVATE_KEY is not set" });
      return;
    }
    const run = tick(env, nearSender(env)).then(
      (result) => log({ tick: startedAt, ...result }),
      (error: unknown) => {
        log({ tick: startedAt, error: error instanceof Error ? error.message : String(error) });
        throw error;
      },
    );
    ctx.waitUntil(run);
    await run;
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/") return new Response("not found", { status: 404 });
    return Response.json({
      name: "proctor-sentinel",
      purpose: "Runs PROCTOR's surprise re-tests: every hour, with probability CHANCE, re-tests one live certificate chosen at random.",
      registry: env.REGISTRY,
      signs_as: env.SENTINEL_ACCOUNT,
      chance_per_hour: Number(env.CHANCE),
      armed: Boolean(env.SENTINEL_PRIVATE_KEY),
      history: `https://testnet.near.rocks/account/${env.SENTINEL_ACCOUNT}`,
      source: "https://github.com/egbujor-emmanuel/proctor/tree/master/sentinel",
    });
  },
} satisfies ExportedHandler<Env>;
