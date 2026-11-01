"use client";

import { useRegistry } from "@/hooks/useRegistry";
import { explorerAccount, REGISTRY } from "@/lib/config";
import { CertificatePaper } from "./CertificatePaper";

function Skeleton() {
  return (
    <div aria-hidden="true" className="h-[420px] animate-pulse rounded-sm border border-rule bg-paper-raised motion-reduce:animate-none" />
  );
}

/** Certificates and exams, read live from the registry contract. */
export function LiveRegistry() {
  const { data, error, isLoading, mutate } = useRegistry();
  const certificates = data ? [...data.certificates].reverse() : [];
  const exams = data?.exams.filter((e) => e.active) ?? [];

  return (
    <section id="registry" aria-labelledby="registry-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-seal">Live from NEAR testnet</p>
          <h2 id="registry-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            The registry
          </h2>
        </div>
        <a
          href={explorerAccount(REGISTRY)}
          target="_blank"
          rel="noopener noreferrer"
          className="hash text-sm text-ink-muted underline decoration-rule underline-offset-4 hover:text-seal"
        >
          {REGISTRY}
        </a>
      </div>

      <div aria-live="polite" aria-busy={isLoading} className="mt-10">
        {isLoading && <Skeleton />}

        {error && !data && (
          <div role="alert" className="rounded-sm border border-revoked bg-revoked-soft p-6">
            <p className="font-medium text-revoked">Could not read the registry.</p>
            <p className="mt-1 text-sm text-ink-muted">{error.message} Nothing below is guessed; it only shows what the chain says.</p>
            <button
              type="button"
              onClick={() => mutate()}
              className="mt-4 min-h-11 rounded border border-revoked px-4 text-sm font-medium text-revoked hover:bg-revoked hover:text-paper"
            >
              Try again
            </button>
          </div>
        )}

        {data && certificates.length === 0 && (
          <div className="rounded-sm border border-dashed border-rule p-8 text-center">
            <p className="font-serif text-2xl text-ink">No certificates yet</p>
            <p className="mt-2 text-sm text-ink-muted">The first passing sitting will appear here. See “Test it in 5 minutes” to sit one.</p>
          </div>
        )}

        {data && certificates.length > 0 && (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid gap-8">
              {certificates.map((cert) => (
                <CertificatePaper key={cert.cert_id} cert={cert} />
              ))}
            </div>
            <aside aria-labelledby="exams-title" className="h-fit border-t border-rule pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              <h3 id="exams-title" className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">
                Open exams
              </h3>
              <ul className="mt-4 divide-y divide-rule">
                {exams.map((exam) => (
                  <li key={exam.exam_id} className="py-4">
                    <p className="font-medium text-ink">{exam.title}</p>
                    <p className="hash mt-1 text-xs text-ink-muted">{exam.exam_id}</p>
                    <p className="mt-2 text-sm text-ink-muted">
                      {exam.question_count} sealed questions · pass at {exam.pass_mark_bps / 100}% · sat {exam.sittings}×
                    </p>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        )}
      </div>
    </section>
  );
}
