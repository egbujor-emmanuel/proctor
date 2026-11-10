"use client";

import { checkExam, type CertState } from "../../../../mcp/src/verdict";
import { useRegistry } from "@/hooks/useRegistry";
import { CERT_TXS, explorerAccount, explorerTx, formatUtc, REGISTRY } from "@/lib/config";
import type { Certificate } from "@/lib/registry";
import { Breakable } from "@/components/ui/Breakable";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { StatusBadge } from "../registry/StatusBadge";

/** Live certificates first, then the ones that lapsed, then failures. */
const RANK: Record<CertState, number> = { active: 0, stale: 1, suspended: 2, revoked: 3, none: 4 };

interface Row {
  cert: Certificate;
  state: CertState;
  /** Earlier certificates for the same candidate and exam that were revoked. */
  revokedBefore: number;
}

/** The latest certificate per candidate and exam, with its standing. */
function rows(certificates: Certificate[]): Row[] {
  const latest = new Map<string, Certificate>();
  for (const c of certificates) {
    const key = `${c.candidate_model}|${c.exam_id}`;
    const seen = latest.get(key);
    if (!seen || c.cert_id > seen.cert_id) latest.set(key, c);
  }
  return [...latest.values()]
    .map((cert) => ({
      cert,
      state: checkExam(cert.exam_id, cert).state,
      revokedBefore: certificates.filter(
        (c) => c.candidate_model === cert.candidate_model && c.exam_id === cert.exam_id && c.cert_id < cert.cert_id && typeof c.status === "object" && "Revoked" in c.status,
      ).length,
    }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.cert.score_bps - a.cert.score_bps || b.cert.cert_id - a.cert.cert_id);
}

/** Every model and agent PROCTOR has certified, ranked by standing, read live from the registry. */
export function IndexBoard() {
  const { data } = useRegistry();
  const list = data ? rows(data.certificates) : [];
  const live = list.filter((r) => r.state === "active").length;

  return (
    <section id="index" aria-labelledby="index-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <Eyebrow text="The PROCTOR Index" />
      <h2 id="index-title" className="mt-3 max-w-3xl font-serif text-4xl text-ink sm:text-5xl">
        Which models still hold their certificate
      </h2>
      <p className="mt-5 max-w-prose text-ink-muted">
        Every candidate the registry has certified, ranked by where it stands today. Surprise re-tests keep moving this table: a model that
        slips is suspended, then revoked, in public.
      </p>
      {data && (
        <p className="mt-3 font-mono text-xs text-ink-muted">
          {live} of {list.length} holding a live certificate · read from{" "}
          <a href={explorerAccount(REGISTRY)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-seal">
            {REGISTRY}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}

      <div className="mt-8 overflow-x-auto rounded-sm border border-rule">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">PROCTOR certificates, ranked by standing</caption>
          <thead className="bg-paper-sunk font-mono text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-3">Candidate</th>
              <th scope="col" className="px-4 py-3">Exam</th>
              <th scope="col" className="px-4 py-3">Score</th>
              <th scope="col" className="px-4 py-3">Re-tests passed</th>
              <th scope="col" className="px-4 py-3">Last verified</th>
              <th scope="col" className="px-4 py-3">Standing</th>
            </tr>
          </thead>
          <tbody>
            {list.map(({ cert, state, revokedBefore }) => {
              const tx = CERT_TXS[cert.cert_id];
              return (
                <tr key={cert.cert_id} className="border-t border-rule align-top">
                  <th scope="row" className="px-4 py-3 font-normal">
                    <span className="hash text-ink">
                      <Breakable text={cert.candidate_model} />
                    </span>
                    <span className="mt-1 block font-mono text-xs text-ink-muted">
                      {cert.candidate_endpoint ? "agent" : "NEAR AI model"} · certificate {cert.cert_id}
                      {tx && (
                        <>
                          {" · "}
                          <a href={explorerTx(tx)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-seal">
                            sitting
                            <span className="sr-only"> transaction (opens in a new tab)</span>
                          </a>
                        </>
                      )}
                      {revokedBefore > 0 && ` · revoked ${revokedBefore}× before`}
                    </span>
                  </th>
                  <td className="hash px-4 py-3 text-ink-muted">
                    <Breakable text={cert.exam_id} />
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-ink">
                    {cert.correct}/{cert.total}
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums text-ink">{cert.retests_passed}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                    <time dateTime={new Date(cert.last_verified_ns / 1e6).toISOString()}>{formatUtc(cert.last_verified_ns / 1e6)}</time>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge state={state} />
                  </td>
                </tr>
              );
            })}
            {data && list.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-ink-muted">
                  No certificates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
