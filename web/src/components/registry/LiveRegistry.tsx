"use client";

import { useRegistry } from "@/hooks/useRegistry";
import { explorerAccount, formatUtc, REGISTRY, runnerRelease, runnerVersion } from "@/lib/config";
import { CertificatePaper } from "./CertificatePaper";
import { Eyebrow } from "@/components/ui/Eyebrow";

function Skeleton() {
  return (
    <div aria-hidden="true" className="h-[420px] animate-pulse rounded-sm border border-rule bg-paper-raised motion-reduce:animate-none" />
  );
}

/** Certificates and exams, read live from the registry contract. */
export function LiveRegistry() {
  const { data, error, isLoading, isStale, isSnapshot, mutate } = useRegistry();
  const runner = data?.config.runner_hash;
  const pending = data?.config.pending_runner;
  const certificates = data ? [...data.certificates].reverse() : [];
  const exams = data?.exams.filter((e) => e.active) ?? [];

  return (
    <section id="registry" aria-labelledby="registry-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <Eyebrow text="Live from NEAR testnet" />
          <h2 id="registry-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            The registry
          </h2>
        </div>
        <a
          href={explorerAccount(REGISTRY)}
          target="_blank"
          rel="noopener noreferrer"
          className="hash inline-flex min-h-6 items-center text-sm text-ink-muted underline decoration-ink-muted underline-offset-4 hover:text-seal"
        >
          {REGISTRY}
          <span className="sr-only"> on NEAR Explorer (opens in a new tab)</span>
        </a>
      </div>

      <p role="status" className="sr-only">
        {data ? `${certificates.length} ${certificates.length === 1 ? "certificate" : "certificates"} loaded from the registry.` : ""}
      </p>
      <div className="mt-10">
        {isLoading && <Skeleton />}

        {runner && (
          <p className="mb-6 text-sm text-ink-muted">
            Grading with runner{" "}
            <a href={runnerRelease(runner)} target="_blank" rel="noopener noreferrer" className="hash text-ink underline underline-offset-4 hover:text-seal">
              {runnerVersion(runner) ?? runner.slice(0, 12)}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
            {pending && (
              <>
                . {runnerVersion(pending.runner_hash) ?? "A new build"} is proposed and can take effect from{" "}
                {formatUtc(pending.effective_at_ns / 1_000_000)}, after the 24-hour timelock.
              </>
            )}
          </p>
        )}

        {isSnapshot && data && !error && (
          <p role="status" className="mb-6 font-mono text-xs text-ink-muted">
            Showing the registry as read at {formatUtc(data.readAt)}; reading the live chain…
          </p>
        )}

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

        {isStale && data && (
          <p role="status" className="mb-6 rounded-sm border border-suspended bg-suspended-soft px-4 py-3 text-sm text-suspended">
            The last refresh failed, so this shows the registry as read at {formatUtc(data.readAt)}.{" "}
            <button type="button" onClick={() => mutate()} className="underline underline-offset-4">
              Refresh now
            </button>
          </p>
        )}
        {data && data.skipped > 0 && (
          <p role="status" className="mb-6 rounded-sm border border-rule bg-paper-sunk px-4 py-3 text-sm text-ink-muted">
            {data.skipped} registry {data.skipped === 1 ? "entry is" : "entries are"} in a format this page doesn’t read yet and{" "}
            {data.skipped === 1 ? "is" : "are"} not shown.
          </p>
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
            <div className="h-fit border-t border-rule pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
              <h3 id="exams-title" className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">
                Open exams
              </h3>
              <ul role="list" className="mt-4 divide-y divide-rule">
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
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
