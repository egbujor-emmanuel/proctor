// Picks the certificate for a surprise re-test. Pure, so the rules are tested
// (pick.test.mjs); surprise-retest.mjs does the I/O.

/** The registry's minimum gap between re-tests of one certificate. */
export const RETEST_COOLDOWN_NS = 3_600n * 1_000_000_000n;
/** Slack so a pick made from a slightly stale read is not refused on chain. */
const COOLDOWN_MARGIN_NS = 120n * 1_000_000_000n;

const isRevoked = (cert) => typeof cert.status === "object" && cert.status !== null && "Revoked" in cert.status;

/**
 * Why a certificate cannot be re-tested now, or null if it can. `nowNs` and
 * timestamps are BigInt nanoseconds (registry timestamps exceed 2^53).
 */
export function ineligibility(cert, nowNs) {
  if (isRevoked(cert)) return "revoked";
  if (cert.retest_in_flight !== null && cert.retest_in_flight !== undefined) return "a re-test is already running";
  const last = cert.last_retest_requested_ns;
  if (last !== null && last !== undefined && nowNs < BigInt(last) + RETEST_COOLDOWN_NS + COOLDOWN_MARGIN_NS) {
    return "re-tested less than an hour ago";
  }
  return null;
}

/**
 * Chooses one eligible certificate uniformly at random, or explains why none.
 * `random(n)` returns an integer in [0, n); pass crypto.randomInt in production.
 */
export function pick(certs, nowNs, random, onlyCertId) {
  const pool = onlyCertId === undefined ? certs : certs.filter((c) => c.cert_id === onlyCertId);
  if (onlyCertId !== undefined && pool.length === 0) return { skip: `certificate ${onlyCertId} does not exist` };
  const eligible = pool.filter((c) => ineligibility(c, nowNs) === null);
  if (eligible.length === 0) {
    const why = pool.map((c) => `#${c.cert_id}: ${ineligibility(c, nowNs)}`).join("; ");
    return { skip: pool.length === 0 ? "no certificates yet" : `nothing eligible (${why})` };
  }
  const cert = eligible[random(eligible.length)];
  return { cert_id: cert.cert_id, candidate: cert.candidate_model, exam_id: cert.exam_id, eligible: eligible.length };
}
