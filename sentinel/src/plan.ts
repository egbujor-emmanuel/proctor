// What one scheduled tick should do. Pure: the selection rules are the
// tested ones in scripts/retest/pick.mjs, shared with the GitHub workflow.

import { pick, stuckSittings } from "../../scripts/retest/pick.mjs";
import type { Certificate } from "./registry";

export type Plan = { expire: number[]; retest?: { cert_id: number; candidate: string }; skip?: string };

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
  if (roll >= chance) return { expire, skip: `not this time (fires with probability ${chance})` };
  // Only the exams this sentinel patrols: anyone can register an exam, and
  // certificates on throwaway ones must not dilute the draw.
  const patrolled = exams ? certs.filter((c) => exams.has(c.exam_id)) : certs;
  const choice = pick(patrolled, nowNs, random);
  if ("skip" in choice) return { expire, skip: choice.skip };
  return { expire, retest: { cert_id: choice.cert_id, candidate: choice.candidate } };
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
