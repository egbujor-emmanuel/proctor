// Types for pick.mjs, so TypeScript callers (the sentinel Worker) can share it.

export const RETEST_COOLDOWN_NS: bigint;
export const SITTING_TIMEOUT_NS: bigint;

interface CertLike {
  cert_id: number;
  candidate_model: string;
  exam_id: string;
  status: unknown;
  retest_in_flight: number | null | undefined;
  last_retest_requested_ns: string | number | null | undefined;
}

export function ineligibility(cert: CertLike, nowNs: bigint): string | null;
export function pick(
  certs: CertLike[],
  nowNs: bigint,
  random: (n: number) => number,
  onlyCertId?: number,
): { cert_id: number; candidate: string; exam_id: string; eligible: number } | { skip: string };
export function stuckSittings(certs: CertLike[], requestedAt: Map<number, string | number>, nowNs: bigint): number[];
