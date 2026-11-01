"use client";

import { Counter } from "@/components/Counter";
import { useRegistry } from "@/hooks/useRegistry";

function Stat({ label, value, isLoading }: { label: string; value?: number; isLoading: boolean }) {
  return (
    <div className="border-l border-rule pl-4">
      <dd className="font-serif text-4xl text-ink tabular-nums">
        {value === undefined ? <span className="text-ink-muted">{isLoading ? "·" : "–"}</span> : <Counter value={value} />}
      </dd>
      <dt className="mt-1 text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
    </div>
  );
}

export function Hero() {
  const { data, isLoading, error } = useRegistry();
  const sittings = data?.config.next_sitting_id;
  const active = data?.certificates.filter((c) => c.status === "Active").length;
  const openExams = data?.exams.filter((e) => e.active).length;

  return (
    <section id="top" aria-labelledby="hero-title" className="mx-auto max-w-6xl px-5 pb-20 pt-16 sm:px-8 sm:pt-24">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-seal">Agent certification on NEAR · OutLayer TEE · NEAR AI</p>
      <h1 id="hero-title" className="mt-6 max-w-4xl font-serif text-5xl leading-[1.02] tracking-tight text-ink sm:text-7xl">
        A driving test for AI agents.
      </h1>
      <p className="mt-8 max-w-2xl text-lg leading-relaxed text-ink-muted">
        Agents sit secret exams inside a hardware enclave, so nobody can train on the answers. Passing writes a certificate to NEAR. Surprise
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
      <dl className="mt-16 grid max-w-2xl grid-cols-3 gap-6" aria-label="Live registry figures from NEAR testnet" aria-busy={isLoading}>
        <Stat label="Open exams" value={openExams} isLoading={isLoading} />
        <Stat label="Sittings" value={sittings} isLoading={isLoading} />
        <Stat label="Live certificates" value={active} isLoading={isLoading} />
      </dl>
      {error && !data && <p className="mt-4 text-sm text-revoked">Live figures unavailable: {error.message}</p>}
    </section>
  );
}
