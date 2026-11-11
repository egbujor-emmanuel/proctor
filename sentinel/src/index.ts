/**
 * PROCTOR's sentinel: a Cloudflare Worker whose Cron Trigger wakes it every
 * hour. Each tick it expires re-tests whose callback never came, re-tests a
 * live certificate not verified for 5 days (so none lapses into "stale"), and
 * otherwise, with probability CHANCE (so the hours cannot be predicted),
 * re-tests one live certificate chosen at random, signing from the sentinel testnet account.
 * Every action is a public NEAR transaction from that account; the Worker's
 * logs record each tick, including the ones that do nothing.
 */

import { Account, type KeyPairString, JsonRpcProvider, nearToYocto, teraToGas } from "near-api-js";

import { kvQuota, retestOnRequest } from "./ondemand";
import { outcomeFromLogs, plan, VERDICTS } from "./plan";
import { chainNowNs, listCertificates, view } from "./registry";

export interface Env {
  REGISTRY: string;
  SENTINEL_ACCOUNT: string;
  RPC_URL: string;
  /** Probability that a tick runs a re-test, e.g. "0.2". */
  CHANCE: string;
  /** Comma-separated exam ids to patrol; empty means every exam. */
  EXAMS?: string;
  SENTINEL_PRIVATE_KEY?: string;
  /** Comma-separated origins whose pages may order a re-test (the website). */
  ALLOWED_ORIGINS?: string;
  /** Counts the website's re-tests per day (the daily cap). */
  RETEST_QUOTA?: KVNamespace;
}

/** CORS headers for a request from one of the allowed origins; none for anyone else. */
function cors(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", vary: "origin" };
}

/** POST /retest {"cert_id": n}: a surprise re-test ordered from the website, paid by the sentinel. */
async function handleRetest(request: Request, env: Env): Promise<Response> {
  const headers = cors(request, env);
  const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, { error: "POST a JSON body {\"cert_id\": n}" });
  if (!env.SENTINEL_PRIVATE_KEY) return reply(503, { error: "the sentinel holds no key, so it cannot pay for re-tests" });
  const body = (await request.json().catch(() => null)) as { cert_id?: unknown } | null;
  if (!body || typeof body.cert_id !== "number") return reply(400, { error: "POST a JSON body {\"cert_id\": n}" });
  if (!env.RETEST_QUOTA) return reply(503, { error: "the daily re-test budget is not configured" });
  try {
    const { status, body: out } = await retestOnRequest(body.cert_id, env, nearSender(env), kvQuota(env.RETEST_QUOTA));
    log({ request: "retest", cert_id: body.cert_id, status, ...out });
    return reply(status, out);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log({ request: "retest", cert_id: body.cert_id, error: message });
    return reply(502, { error: `the re-test could not be sent: ${message}` });
  }
}

/** The EXAMS setting as a set, or undefined to patrol every exam. */
export function patrolledExams(env: Pick<Env, "EXAMS">): ReadonlySet<string> | undefined {
  const ids = (env.EXAMS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : undefined;
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
    // Only receipts the registry itself executed can report its outcome.
    const logs = (result.receipts_outcome ?? []).filter((r) => r.outcome.executor_id === env.REGISTRY).flatMap((r) => r.outcome.logs ?? []);
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
  const step = plan(certs, requestedAt, await chainNowNs(env.RPC_URL), chance, roll, random, patrolledExams(env));

  const expired: string[] = [];
  for (const id of step.expire) {
    const { tx } = await send("expire_sitting", { sitting_id: id }, "30", "0");
    expired.push(`${id}:${tx}`);
  }
  if (!step.retest) return { action: "none", reason: step.skip, expired };

  const { tx, logs } = await send("retest", { cert_id: step.retest.cert_id }, "300", RETEST_DEPOSIT);
  const outcome = outcomeFromLogs(logs);
  const result = { action: "retest", why: step.retest.why, cert_id: step.retest.cert_id, candidate: step.retest.candidate, tx, outcome: outcome ?? "none", expired };
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
    // nearSender parses the key, so a bad key is reported like any other failure.
    const run = Promise.resolve().then(() => tick(env, nearSender(env))).then(
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
    const path = new URL(request.url).pathname;
    if (path === "/retest") return handleRetest(request, env);
    if (path !== "/") return new Response("not found", { status: 404 });
    // The website reads this page to show whether the sentinel is armed.
    return Response.json({
      name: "proctor-sentinel",
      purpose: "Runs PROCTOR's surprise re-tests: every hour it re-tests a live certificate not verified for 5 days, if there is one; otherwise, with probability CHANCE, one live certificate chosen at random.",
      overdue_after_days: 5,
      registry: env.REGISTRY,
      signs_as: env.SENTINEL_ACCOUNT,
      chance_per_hour: Number(env.CHANCE),
      exams: [...(patrolledExams(env) ?? ["every exam"])],
      armed: Boolean(env.SENTINEL_PRIVATE_KEY),
      order_a_retest: "POST /retest with {\"cert_id\": n} from the website; at most once an hour per certificate (the registry's rule) and a daily cap",
      history: `https://testnet.near.rocks/account/${env.SENTINEL_ACCOUNT}`,
      source: "https://github.com/egbujor-emmanuel/proctor/tree/master/sentinel",
    }, { headers: cors(request, env) });
  },
} satisfies ExportedHandler<Env>;
