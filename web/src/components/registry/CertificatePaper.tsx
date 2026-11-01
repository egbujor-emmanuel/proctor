"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef } from "react";

import { certState } from "../../../../mcp/src/verdict";
import { explorerAccount, explorerTx, FIRST_CERT_TX, REGISTRY, RUNNER_RELEASE } from "@/lib/config";
import type { Certificate } from "@/lib/registry";
import { StatusBadge } from "./StatusBadge";

gsap.registerPlugin(ScrollTrigger, useGSAP);

function utc(ns: number): string {
  return new Date(Math.floor(ns / 1_000_000)).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

type Field = { label: string; value: string; href?: string; title?: string };

/** One certificate as a stamped exam paper, built from its on-chain fields. */
export function CertificatePaper({ cert }: { cert: Certificate }) {
  const root = useRef<HTMLElement>(null);
  const state = certState(cert);
  const reason = typeof cert.status === "object" ? Object.values(cert.status)[0]?.reason : undefined;

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.from("[data-seal]", {
        scale: 1.6,
        rotate: -28,
        opacity: 0,
        duration: 0.55,
        ease: "back.out(2.2)",
        scrollTrigger: { trigger: root.current, start: "top 80%", once: true },
      });
    },
    { scope: root },
  );

  const fields: Field[] = [
    { label: "Runner build", value: short(cert.runner_hash), href: RUNNER_RELEASE, title: cert.runner_hash },
    { label: "Exam commitment", value: short(cert.exam_commitment), title: cert.exam_commitment },
    { label: `Answers (${cert.response_count} NEAR AI completions)`, value: short(cert.response_ids_hash), title: cert.response_ids_hash },
    { label: "Issued", value: utc(cert.issued_at_ns) },
    { label: "Last verified", value: utc(cert.last_verified_ns) },
    { label: "Surprise re-tests passed", value: String(cert.retests_passed) },
    { label: "Sitting paid by", value: cert.requested_by, href: explorerAccount(cert.requested_by) },
  ];
  const evidence = cert.cert_id === 0 ? explorerTx(FIRST_CERT_TX) : explorerAccount(REGISTRY);

  return (
    <article
      ref={root}
      aria-labelledby={`cert-${cert.cert_id}-title`}
      className="relative overflow-hidden rounded-sm border border-rule bg-paper-raised p-6 shadow-[0_1px_0_var(--rule),0_18px_40px_-28px_rgb(0_0_0/0.45)] sm:p-8"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_27px,var(--rule)_28px)] opacity-25" />
      <header className="relative flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-4">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">
          PROCTOR · Certificate No. {String(cert.cert_id).padStart(3, "0")}
        </p>
        <StatusBadge state={state} />
      </header>

      <div className="relative mt-6 grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <p className="text-sm text-ink-muted">This certifies that</p>
          <h3 id={`cert-${cert.cert_id}-title`} className="hash mt-1 font-serif text-2xl leading-tight text-ink sm:text-3xl">
            {cert.candidate_model}
          </h3>
          <p className="mt-3 text-sm text-ink-muted">
            passed the sealed exam <span className="hash text-ink">{cert.exam_id}</span>
          </p>
        </div>
        <div className="text-left sm:text-right">
          <p className="font-serif text-5xl leading-none text-ink">
            {cert.correct}
            <span className="text-ink-muted">/{cert.total}</span>
          </p>
          <p className="mt-1 font-mono text-xs text-ink-muted">{(cert.score_bps / 100).toFixed(2)}%</p>
        </div>
      </div>

      {reason && (
        <p className="relative mt-5 rounded border border-suspended bg-suspended-soft px-3 py-2 text-sm text-suspended">{reason}</p>
      )}

      <dl className="relative mt-6 grid gap-x-8 gap-y-3 border-t border-rule pt-5 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">{f.label}</dt>
            <dd className="hash mt-0.5 text-sm text-ink" title={f.title}>
              {f.href ? (
                <a href={f.href} target="_blank" rel="noopener noreferrer" className="underline decoration-rule underline-offset-4 hover:decoration-seal hover:text-seal">
                  {f.value}
                </a>
              ) : (
                f.value
              )}
            </dd>
          </div>
        ))}
      </dl>

      <footer className="relative mt-6 flex flex-wrap items-center justify-between gap-4">
        <a
          href={evidence}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center rounded border border-seal px-4 text-sm font-medium text-seal transition-colors hover:bg-seal hover:text-paper"
        >
          Verify on NEAR Explorer
        </a>
        <svg data-seal viewBox="0 0 120 120" className="size-24 shrink-0 text-seal" role="img" aria-label={`Seal: ${state}`}>
          <circle cx="60" cy="60" r="54" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <circle cx="60" cy="60" r="44" fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" />
          <path id={`seal-arc-${cert.cert_id}`} d="M 19 60 A 41 41 0 1 1 101 60" fill="none" />
          <text fontSize="9" letterSpacing="1.6" fill="currentColor" fontFamily="var(--font-plex-mono)">
            <textPath href={`#seal-arc-${cert.cert_id}`} startOffset="50%" textAnchor="middle">
              PROCTOR · NEAR
            </textPath>
          </text>
          <text x="60" y="72" textAnchor="middle" fontSize="22" fill="currentColor" fontFamily="var(--font-newsreader)">
            {state === "active" ? "PASS" : state === "suspended" ? "HOLD" : "VOID"}
          </text>
        </svg>
      </footer>
    </article>
  );
}
