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
  listing_status: string;
  delivered_jobs: number;
  success_rate: number | null;
  builder?: { verification?: { level: string } | null } | null;
}

export type CertState = "active" | "suspended" | "revoked" | "none";
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

/** Market agents are certified under this candidate id. */
export function marketCandidateId(handle: string): string {
  return `market:${handle}`;
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

export function checkExam(examId: string, cert: Certificate | null): ExamCheck {
  return cert === null ? { exam_id: examId, state: "none" } : { exam_id: examId, state: certState(cert), certificate: summarize(cert) };
}

const STATE_REASON: Record<Exclude<CertState, "active">, string> = {
  none: "holds no PROCTOR certificate",
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
