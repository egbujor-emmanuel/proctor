// Checks the page runs against the chain when a visitor opens it: what is
// deployed is what the repository builds, and nothing can change silently.

import * as z from "zod/mini";

import { BUILDS, ESCROW, formatUtc, REGISTRY, runnerVersion, SENTINEL } from "./config";
import { accountCodeHash, ConfigSchema, view } from "./registry";

export interface LiveCheck {
  id: "registry-code" | "escrow-code" | "runner" | "timelock" | "sentinel";
  title: string;
  /** true: passed; false: failed; null: could not be checked right now. */
  ok: boolean | null;
  detail: string;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet, as NEAR uses for code hashes) of a hex byte string. */
export function base58FromHex(hex: string): string {
  const bytes = hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? [];
  // BigInt() rather than literals: the site's TypeScript target predates them.
  const [zero, byte, base] = [BigInt(0), BigInt(256), BigInt(58)];
  let n = zero;
  for (const b of bytes) n = n * byte + BigInt(b);
  let out = "";
  while (n > zero) {
    out = ALPHABET[Number(n % base)] + out;
    n /= base;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);
const unchecked = (id: LiveCheck["id"], title: string, error: unknown): LiveCheck => ({
  id,
  title,
  ok: null,
  detail: `Could not check right now: ${error instanceof Error ? error.message : String(error)}`,
});

async function codeCheck(id: "registry-code" | "escrow-code", account: string, build: string, fetcher: typeof fetch): Promise<LiveCheck> {
  const title = id === "registry-code" ? "The registry runs the CI build" : "The escrow runs the CI build";
  try {
    const onChain = await accountCodeHash(account, fetcher);
    const expected = base58FromHex(build);
    return onChain === expected
      ? { id, title, ok: true, detail: `${account} code hash ${short(onChain)} = SHA-256 ${short(build)} from RELEASE.sha256` }
      : { id, title, ok: false, detail: `${account} runs code ${onChain}, but the CI build is ${expected}` };
  } catch (error) {
    return unchecked(id, title, error);
  }
}

const SentinelStatus = z.object({ armed: z.boolean() });

async function sentinelCheck(fetcher: typeof fetch): Promise<LiveCheck> {
  const title = "The sentinel can run surprise re-tests";
  try {
    const res = await fetcher(`${SENTINEL}/`, { signal: AbortSignal.timeout(15_000) });
    const status = SentinelStatus.parse(await res.json());
    return status.armed
      ? { id: "sentinel", title, ok: true, detail: "It holds its key and re-tests at random hours; anyone can also order one below a certificate" }
      : { id: "sentinel", title, ok: false, detail: "The sentinel holds no key, so it cannot sign re-tests" };
  } catch (error) {
    return unchecked("sentinel", title, error);
  }
}

const DAY_NS = 86_400 * 1e9;

/**
 * Fails if a proposed runner build could take effect less than 24 hours after it was proposed.
 * With nothing pending, the pinned runner (checked separately) is the only one that can grade.
 */
function timelockCheck(title: string, pending: { runner_hash: string; proposed_at_ns: number; effective_at_ns: number } | null | undefined): LiveCheck {
  if (!pending) {
    return { id: "timelock", title, ok: true, detail: "No new build is proposed, so only the pinned runner can grade. A new one must be proposed on chain and wait 24 hours" };
  }
  const waitNs = pending.effective_at_ns - pending.proposed_at_ns;
  const hours = Math.round(waitNs / 3.6e12);
  return waitNs >= DAY_NS
    ? { id: "timelock", title, ok: true, detail: `A new build ${short(pending.runner_hash)} was proposed ${hours} hours before it can take effect, from ${formatUtc(pending.effective_at_ns / 1e6)}` }
    : { id: "timelock", title, ok: false, detail: `A new build ${short(pending.runner_hash)} could take effect only ${hours} hours after it was proposed` };
}

/** Runs every check; each one is independent, so one failing read never hides the others. */
export async function runLiveChecks(fetcher: typeof fetch = fetch): Promise<LiveCheck[]> {
  const configRead = view(ConfigSchema, "get_config", {}, fetcher);
  const runnerTitle = "The registry grades with the released runner";
  const timelockTitle = "No new runner build can grade without 24 hours' notice";
  const [registry, escrow, config, sentinel] = await Promise.all([
    codeCheck("registry-code", REGISTRY, BUILDS.registry, fetcher),
    codeCheck("escrow-code", ESCROW, BUILDS.escrow, fetcher),
    configRead.then((c) => ({ c }), (error: unknown) => ({ error })),
    sentinelCheck(fetcher),
  ]);

  let runner: LiveCheck;
  let timelock: LiveCheck;
  if ("error" in config) {
    runner = unchecked("runner", runnerTitle, config.error);
    timelock = unchecked("timelock", timelockTitle, config.error);
  } else {
    const { runner_hash: hash, pending_runner: pending } = config.c;
    runner =
      hash === BUILDS.runner
        ? { id: "runner", title: runnerTitle, ok: true, detail: `Pinned runner ${runnerVersion(hash) ?? "build"}, SHA-256 ${short(hash)}, the CI build in exam-runner/RELEASE.sha256` }
        : { id: "runner", title: runnerTitle, ok: false, detail: `The registry pins ${hash}, not the released build ${BUILDS.runner}` };
    timelock = timelockCheck(timelockTitle, pending);
  }
  return [registry, escrow, runner, timelock, sentinel];
}
