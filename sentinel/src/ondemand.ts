// A surprise re-test ordered from the website: anyone may ask, the sentinel
// pays. The registry already allows a re-test of a certificate at most once
// an hour; this adds a daily cap so the sentinel's account cannot be drained.

import { pick } from "../../scripts/retest/pick.mjs";
import { outcomeFromLogs } from "./plan";
import { chainNowNs, listCertificates } from "./registry";
import type { Env, Send } from "./index";

/** Re-tests the website may order per UTC day, across every certificate. */
export const DAILY_CAP = 48;
/** Re-tests pay no author fee; this covers storage plus OutLayer, which refunds what it doesn't use. */
const RETEST_DEPOSIT = "0.06" as const;
const NS_PER_DAY = 86_400n * 1_000_000_000n;

/** How many website re-tests were sent on the UTC day containing `nowNs`. */
export interface Quota {
  used(nowNs: bigint): Promise<number>;
  add(nowNs: bigint): Promise<void>;
}

const dayKey = (nowNs: bigint) => `retests:${nowNs / NS_PER_DAY}`;

/** The quota kept in Workers KV. A lost update can let one extra re-test through; the cap is a budget, not a lock. */
export function kvQuota(kv: KVNamespace): Quota {
  return {
    used: async (nowNs) => Number((await kv.get(dayKey(nowNs))) ?? 0),
    add: async (nowNs) => {
      const key = dayKey(nowNs);
      await kv.put(key, String(Number((await kv.get(key)) ?? 0) + 1), { expirationTtl: 3 * 86_400 });
    },
  };
}

/** An in-memory quota, for tests. */
export function memoryQuota(): Quota {
  const counts = new Map<string, number>();
  return {
    used: async (nowNs) => counts.get(dayKey(nowNs)) ?? 0,
    add: async (nowNs) => void counts.set(dayKey(nowNs), (counts.get(dayKey(nowNs)) ?? 0) + 1),
  };
}

export type RetestReply = { status: number; body: Record<string, unknown> };

/** Re-tests one certificate now, if the registry's rules and the daily cap allow it. */
export async function retestOnRequest(certId: number, env: Env, send: Send, quota: Quota): Promise<RetestReply> {
  if (!Number.isSafeInteger(certId) || certId < 0) return { status: 400, body: { error: "cert_id must be a certificate number" } };
  const [certs, nowNs] = await Promise.all([listCertificates(env.RPC_URL, env.REGISTRY), chainNowNs(env.RPC_URL)]);
  const exams = (env.EXAMS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const patrolled = exams.length > 0 ? certs.filter((c) => exams.includes(c.exam_id)) : certs;
  if (!patrolled.some((c) => c.cert_id === certId)) {
    return { status: 404, body: { error: `certificate ${certId} is not on an exam the sentinel patrols` } };
  }
  const choice = pick(patrolled, nowNs, () => 0, certId);
  if ("skip" in choice) return { status: 409, body: { error: choice.skip.replace(/^nothing eligible \(#\d+: (.*)\)$/, "$1") } };
  if ((await quota.used(nowNs)) >= DAILY_CAP) {
    return { status: 429, body: { error: `the website's ${DAILY_CAP} re-tests for today are used up; the sentinel still re-tests at random every hour` } };
  }
  await quota.add(nowNs);
  const { tx, logs } = await send("retest", { cert_id: certId }, "300", RETEST_DEPOSIT);
  return {
    status: 200,
    body: {
      cert_id: certId,
      candidate: choice.candidate,
      tx,
      outcome: outcomeFromLogs(logs) ?? "pending",
      explorer: `https://testnet.near.rocks/tx/${tx}`,
    },
  };
}
