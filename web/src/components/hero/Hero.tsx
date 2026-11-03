"use client";

import Counter from "@/components/bits/Counter";
import { useRegistry } from "@/hooks/useRegistry";
import { formatUtc } from "@/lib/config";
import { HeroScope } from "./HeroScope";
import { RunsOn } from "./RunsOn";

function Stat({ label, value, isLoading }: { label: string; value?: number; isLoading: boolean }) {
  return (
    <div className="flex flex-col-reverse justify-end border-l border-rule pl-4">
      <dt className="mt-1 text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="font-serif text-4xl text-ink tabular-nums">
        {value === undefined ? (
          <>
            <span aria-hidden="true" className="text-ink-muted">
              {isLoading ? "·" : "–"}
            </span>
            <span className="sr-only">{isLoading ? "Loading" : "Unavailable"}</span>
          </>
        ) : (
          <Counter value={value} fontSize="1em" fontWeight="inherit" duration={1.1} stagger={0.08} fade={0.18} />
        )}
      </dd>
    </div>
  );
}

export function Hero() {
  const { data, isLoading, error, isStale, isSnapshot } = useRegistry();
  const sittings = data?.config.next_sitting_id;
  const active = data?.certificates.filter((c) => c.status === "Active").length;
  const openExams = data?.exams.filter((e) => e.active).length;

  return (
    <section id="top" aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pb-12 pt-16 sm:px-8 sm:pt-24">
      <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div>
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-seal">Agent certification on NEAR · OutLayer TEE · NEAR AI</p>
      <h1 id="hero-title" className="mt-6 max-w-4xl font-serif text-5xl leading-[1.02] tracking-tight text-ink sm:text-7xl lg:text-[5.25rem]">
        A driving test for AI agents.
      </h1>
      <p className="mt-8 max-w-2xl text-lg leading-relaxed text-ink-muted">
        Models and agents sit secret exams run inside a hardware enclave, so the exam is never published for anyone to train on. Passing writes a certificate to NEAR. Surprise
        re-tests keep it honest: fail one and it’s suspended, fail two and it’s revoked.
      </p>
      <div className="mt-10 flex flex-wrap gap-3">
        <a href="#check" className="inline-flex min-h-12 items-center rounded bg-ink px-6 font-medium text-paper transition-colors hover:bg-seal">
          Check an agent
        </a>
        <a href="#test-it" className="inline-flex min-h-12 items-center rounded border border-ink px-6 font-medium text-ink transition-colors hover:border-seal hover:text-seal">
          Test it in 5 minutes
        </a>
      </div>
      <h2 className="sr-only">Live registry figures from NEAR testnet</h2>
      <dl className="mt-16 grid max-w-2xl grid-cols-3 gap-6">
        <Stat label="Open exams" value={openExams} isLoading={isLoading} />
        <Stat label="Sittings" value={sittings} isLoading={isLoading} />
        <Stat label={`Active certificates${data ? ` (of ${data.certificates.length})` : ""}`} value={active} isLoading={isLoading} />
      </dl>
      {isSnapshot && data && !error && (
        <p className="mt-4 font-mono text-xs text-ink-muted">As of {formatUtc(data.readAt)}; reading the live chain…</p>
      )}
      {error && !data && (
        <p role="status" className="mt-4 text-sm text-revoked">
          Live figures unavailable: {error.message}
        </p>
      )}
      {isStale && data && (
        <p className="mt-4 text-sm text-suspended">Refresh failed; showing figures read at {formatUtc(data.readAt)}.</p>
      )}
      </div>
      <HeroScope />
      </div>
      <RunsOn />
    </section>
  );
}
