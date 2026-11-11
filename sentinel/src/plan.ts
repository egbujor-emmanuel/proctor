// What one scheduled tick should do. Pure: the selection rules are the
// tested ones in scripts/retest/pick.mjs, shared with the GitHub workflow.

import { ineligibility, pick, stuckSittings } from "../../scripts/retest/pick.mjs";
import type { Certificate } from "./registry";

export type Plan = { expire: number[]; retest?: { cert_id: number; candidate: string; why: "overdue" | "drawn" }; skip?: string };

/**
 * A live certificate not verified for this long is re-tested before the random draw. Clients
 * stop relying on a certificate after 7 days without a pass (MAX_CERT_AGE_MS in mcp/src/verdict.ts),
 * so this keeps every live one current while still leaving the hour of each re-test unknown.
 */
export const OVERDUE_NS = 5n * 24n * 3_600n * 1_000_000_000n;

/** The live certificate verified longest ago, if it is overdue and can be re-tested now. */
function mostOverdue(certs: Certificate[], nowNs: bigint): Certificate | undefined {
  const overdue = certs.filter(
    (c) => c.status === "Active" && c.last_verified_ns && nowNs - BigInt(c.last_verified_ns) > OVERDUE_NS && ineligibility(c, nowNs) === null,
  );
  return overdue.sort((a, b) => (BigInt(a.last_verified_ns!) < BigInt(b.last_verified_ns!) ? -1 : 1))[0];
}

/**
 * `roll` is a uniform number in [0, 1) for the "fire this hour?" draw and
 * `random(n)` an integer in [0, n) for choosing among eligible certificates.
 */
export function plan(
  certs: Certificate[],
  requestedAt: Map<number, string>,
  nowNs: bigint,
  chance: number,
  roll: number,
  random: (n: number) => number,
  exams?: ReadonlySet<string>,
): Plan {
  // Stuck re-tests are expired every tick: they block their certificate.
  const expire = stuckSittings(certs, requestedAt, nowNs);
  // Only the exams this sentinel patrols: anyone can register an exam, and
  // certificates on throwaway ones must not dilute the draw.
  const patrolled = exams ? certs.filter((c) => exams.has(c.exam_id)) : certs;
  const due = mostOverdue(patrolled, nowNs);
  if (due) return { expire, retest: { cert_id: due.cert_id, candidate: due.candidate_model, why: "overdue" } };
  if (roll >= chance) return { expire, skip: `not this time (fires with probability ${chance})` };
  const choice = pick(patrolled, nowNs, random);
  if ("skip" in choice) return { expire, skip: choice.skip };
  return { expire, retest: { cert_id: choice.cert_id, candidate: choice.candidate, why: "drawn" } };
}

/** The sitting's outcome name from a transaction's logs (e.g. "Suspended"), if resolved. */
export function outcomeFromLogs(logs: string[]): string | undefined {
  for (const log of logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(log.slice("EVENT_JSON:".length));
      if (event?.standard !== "proctor" || event?.event !== "sitting_resolved") continue;
      const outcome = event.data?.[0]?.outcome;
      return typeof outcome === "string" ? outcome : Object.keys(outcome ?? {})[0];
    } catch {
      // Another contract's log; not ours.
    }
  }
  return undefined;
}

export const VERDICTS = new Set(["RetestPassed", "Suspended", "Revoked"]);
