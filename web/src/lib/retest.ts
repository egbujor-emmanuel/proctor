// Ordering a surprise re-test from the page. The sentinel pays and signs it;
// the registry still allows one re-test per certificate per hour.

import * as z from "zod/mini";

import { SENTINEL } from "./config";

/** A re-test runs the whole exam inside OutLayer; a minute is typical, four is the limit. */
const RETEST_TIMEOUT_MS = 240_000;

const Done = z.object({ tx: z.string(), outcome: z.string() });
const Refused = z.object({ error: z.string() });

export type RetestResult = { ok: true; tx: string; outcome: string } | { ok: false; error: string };

export async function orderRetest(certId: number, fetcher: typeof fetch = fetch): Promise<RetestResult> {
  let response: Response;
  try {
    response = await fetcher(`${SENTINEL}/retest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cert_id: certId }),
      signal: AbortSignal.timeout(RETEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "Could not reach the sentinel. Check your connection and try again." };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const done = Done.safeParse(body);
    return done.success ? { ok: true, tx: done.data.tx, outcome: done.data.outcome } : { ok: false, error: "The sentinel sent a reply this page does not understand." };
  }
  const refused = Refused.safeParse(body);
  return { ok: false, error: refused.success ? refused.data.error : `The sentinel answered HTTP ${response.status}.` };
}

export type OutcomeTone = "active" | "suspended" | "revoked" | "muted";

/** What a re-test's outcome did to the certificate, in one line. */
export function describeOutcome(outcome: string): { text: string; tone: OutcomeTone } {
  switch (outcome) {
    case "RetestPassed":
      return { text: "Passed. The certificate stays live.", tone: "active" };
    case "Suspended":
      return { text: "Failed. The certificate is suspended until it passes again.", tone: "suspended" };
    case "Revoked":
      return { text: "Failed twice in a row. The certificate is revoked.", tone: "revoked" };
    case "Incomplete":
      return { text: "Incomplete: an outage, so nothing changed and the hourly slot was given back.", tone: "muted" };
    default:
      return { text: `Finished: ${outcome}.`, tone: "muted" };
  }
}
