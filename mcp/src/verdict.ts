// The hire / don't-hire decision. Pure, so every rule is unit tested.
//
// Only a live (Active) PROCTOR certificate earns "hire". Marketplace track
// record is reported alongside as context but never overrides the exam:
// a busy agent that failed its last re-test is still a "do not hire".
//
// Deliberately dependency-free (no imports), so the website imports this same
// file and shows exactly the verdicts the MCP server gives. The two shapes
// below are the fields it reads; the registry's and the market's full types
// satisfy them structurally.

/** The certificate fields the verdict reads. */
export interface Certificate {
  cert_id: number;
  exam_id: string;
  runner_hash: string;
  score_bps: number;
  correct: number;
  total: number;
  last_verified_ns: number;
  retests_passed: number;
  status: "Active" | { Suspended: { reason: string; at_ns: number } } | { Revoked: { reason: string; at_ns: number } };
}

/** The Agent Market fields the verdict reads. */
export interface MarketAgent {
  handle: string;
  name: string;
  description?: string | null;
  bio_markdown?: string | null;
  tags?: string[] | null;
  listing_status: string;
  delivered_jobs: number;
  success_rate: number | null;
  builder?: { verification?: { level: string } | null } | null;
}

/** "stale": Active on chain, but not verified recently enough to rely on. */
export type CertState = "active" | "stale" | "suspended" | "revoked" | "none";

/** A live certificate must have passed a sitting or re-test within this long. */
export const MAX_CERT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type Decision = "hire" | "do_not_hire";

export interface CertificateSummary {
  cert_id: number;
  exam_id: string;
  state: CertState;
  score: string;
  retests_passed: number;
  last_verified: string;
  runner_hash: string;
  reason?: string;
}

export interface ExamCheck {
  exam_id: string;
  state: CertState;
  certificate?: CertificateSummary;
}

export interface Verdict {
  decision: Decision;
  candidate: string;
  reasons: string[];
  exams: ExamCheck[];
  market?: {
    handle: string;
    name: string;
    listing_status: string;
    delivered_jobs: number;
    success_rate: number | null;
    builder_verification: string | null;
  };
}

/** An agent sitting through its own endpoint is certified as this id (registry `sit_exam_as_agent`). */
export function agentCandidateId(owner: string, name: string): string {
  return `agent:${owner}/${name}`;
}

// A listing names the NEAR account that certifies it with `proctor:<account>`
// in its tags, description or bio. NEAR account ids are lowercase.
// A trailing "." ends a sentence; ".x" would continue the name (alice.testnet.evil).
const DECLARATION = /(?:^|[^A-Za-z0-9])(?:proctor|PROCTOR|Proctor):([a-z0-9._-]+\.(?:near|testnet))(?![a-z0-9_-]|\.[a-z0-9])/g;
const NEAR_ACCOUNT = /^(?:(?:[a-z\d]+[-_])*[a-z\d]+\.)*(?:[a-z\d]+[-_])*[a-z\d]+$/;
/** The registry's rule for agent names: its id charset without "/", at most 48 bytes. */
const AGENT_NAME = /^[A-Za-z0-9._:@+-]{1,48}$/;

function declaredAccounts(agent: MarketAgent): string[] {
  const texts = [...(agent.tags ?? []), agent.description ?? "", agent.bio_markdown ?? ""];
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(DECLARATION)) {
      const account = match[1]!;
      if (account.length <= 64 && NEAR_ACCOUNT.test(account)) found.add(account);
    }
  }
  return [...found];
}

/**
 * The PROCTOR candidate behind a market listing. Both sides must agree: the
 * listing (which only its owner can edit) names a NEAR account, and that
 * account certifies an agent named exactly the listing's handle (which only
 * that account can do). Copying someone else's account into a listing points
 * at agent:<them>/<your-handle>, which they never certified.
 */
export function marketCandidate(agent: MarketAgent): { id: string; account: string } | { error: string } {
  const accounts = declaredAccounts(agent);
  if (accounts.length === 0) {
    return { error: `the listing does not name the NEAR account that certifies it (its owner adds "proctor:<account>" to its tags or description)` };
  }
  if (accounts.length > 1) {
    return { error: `the listing names more than one PROCTOR account (${accounts.join(", ")}), so it cannot be matched to one certificate` };
  }
  if (!AGENT_NAME.test(agent.handle)) {
    return { error: `the handle '${agent.handle}' cannot be a PROCTOR agent name` };
  }
  const account = accounts[0]!;
  return { id: agentCandidateId(account, agent.handle), account };
}

export function certState(cert: Certificate | null): CertState {
  if (cert === null) return "none";
  if (cert.status === "Active") return "active";
  return "Suspended" in cert.status ? "suspended" : "revoked";
}

/** ISO time for a nanosecond timestamp, or "unknown" if it is out of range. */
function isoFromNs(ns: number): string {
  const date = new Date(Math.floor(ns / 1_000_000));
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

export function summarize(cert: Certificate): CertificateSummary {
  const state = certState(cert);
  const summary: CertificateSummary = {
    cert_id: cert.cert_id,
    exam_id: cert.exam_id,
    state,
    score: `${cert.correct}/${cert.total} (${(cert.score_bps / 100).toFixed(2)}%)`,
    retests_passed: cert.retests_passed,
    last_verified: isoFromNs(cert.last_verified_ns),
    runner_hash: cert.runner_hash,
  };
  if (typeof cert.status === "object") {
    summary.reason = "Suspended" in cert.status ? cert.status.Suspended.reason : cert.status.Revoked.reason;
  }
  return summary;
}

/**
 * One exam's state for a candidate. An Active certificate that has not been
 * verified within MAX_CERT_AGE_MS counts as stale: re-tests may have stopped.
 */
export function checkExam(examId: string, cert: Certificate | null, nowMs: number = Date.now()): ExamCheck {
  if (cert === null) return { exam_id: examId, state: "none" };
  const summary = summarize(cert);
  const ageMs = nowMs - Math.floor(cert.last_verified_ns / 1_000_000);
  if (summary.state === "active" && ageMs > MAX_CERT_AGE_MS) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    return { exam_id: examId, state: "stale", certificate: { ...summary, state: "stale", reason: `last verified ${days} days ago` } };
  }
  return { exam_id: examId, state: summary.state, certificate: summary };
}

const STATE_REASON: Record<Exclude<CertState, "active">, string> = {
  none: "holds no PROCTOR certificate",
  stale: `has not passed a sitting or re-test in over ${MAX_CERT_AGE_MS / 86_400_000} days, so its certificate is not current`,
  suspended: "failed its most recent re-test; its certificate is suspended until it passes again",
  revoked: "failed two re-tests in a row; its certificate was revoked",
};

/**
 * Decides from per-exam checks. With a required exam, only that exam counts;
 * otherwise any live certificate is enough.
 */
export function decide(candidate: string, exams: ExamCheck[], market?: MarketAgent | null): Verdict {
  const reasons: string[] = [];
  const live = exams.filter((e) => e.state === "active");
  for (const exam of exams) {
    if (exam.state === "active" && exam.certificate) {
      const c = exam.certificate;
      reasons.push(`certified on ${exam.exam_id}: scored ${c.score}, last verified ${c.last_verified}, ${c.retests_passed} surprise re-test(s) passed`);
    } else if (exam.state !== "active") {
      reasons.push(`${exam.exam_id}: ${STATE_REASON[exam.state]}`);
    }
  }
  if (exams.length === 0) reasons.push("no PROCTOR exams were checked");

  const verdict: Verdict = { decision: live.length > 0 ? "hire" : "do_not_hire", candidate, reasons, exams };
  if (market) {
    verdict.market = {
      handle: market.handle,
      name: market.name,
      listing_status: market.listing_status,
      delivered_jobs: market.delivered_jobs,
      success_rate: market.success_rate,
      builder_verification: market.builder?.verification?.level ?? null,
    };
  }
  return verdict;
}
