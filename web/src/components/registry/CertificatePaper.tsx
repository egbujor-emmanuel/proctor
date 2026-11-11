"use client";

import { Breakable } from "@/components/ui/Breakable";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useRef } from "react";

import { certState } from "../../../../mcp/src/verdict";
import {
  CERT_TXS,
  explorerAccount,
  explorerTx,
  REGISTRY,
  runnerRelease,
  runnerVersion,
} from "@/lib/config";
import type { Certificate } from "@/lib/registry";
import { CopyButton } from "@/components/ui/CopyButton";
import { RetestButton } from "./RetestButton";
import { StatusBadge } from "./StatusBadge";

gsap.registerPlugin(ScrollTrigger, useGSAP);

function isoFromNs(ns: number): string | undefined {
  const date = new Date(Math.floor(ns / 1_000_000));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function utc(iso: string | undefined): string {
  return iso ? `${iso.replace("T", " ").slice(0, 16)} UTC` : "unknown";
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

/** `full` is the complete hash; `value` may be a shortened form of it. */
type Field = {
  label: string;
  value: string;
  href?: string;
  full?: string;
  time?: string;
};

/** One certificate as a stamped exam paper, built from its on-chain fields. */
export function CertificatePaper({ cert }: { cert: Certificate }) {
  const root = useRef<HTMLElement>(null);
  const state = certState(cert);
  const reason =
    typeof cert.status === "object"
      ? Object.values(cert.status)[0]?.reason
      : undefined;

  useGSAP(
    () => {
      // matchMedia reverts the stamp if the visitor turns on reduced motion.
      const mm = gsap.matchMedia(root);
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from("[data-seal]", {
          scale: 1.6,
          rotate: -28,
          opacity: 0,
          duration: 0.55,
          ease: "back.out(2.2)",
          scrollTrigger: {
            trigger: root.current,
            start: "top 80%",
            once: true,
          },
        });
      });
    },
    { scope: root },
  );

  const fields: Field[] = [
    {
      label: "Runner build",
      value: `${runnerVersion(cert.runner_hash) ?? "build"} · ${short(cert.runner_hash)}`,
      href: runnerRelease(cert.runner_hash),
      full: cert.runner_hash,
    },
    {
      label: "Exam commitment",
      value: short(cert.exam_commitment),
      full: cert.exam_commitment,
    },
    {
      label: `Answers (${cert.response_count} NEAR AI completions)`,
      value: short(cert.response_ids_hash),
      full: cert.response_ids_hash,
    },
    {
      label: "Issued",
      value: utc(isoFromNs(cert.issued_at_ns)),
      time: isoFromNs(cert.issued_at_ns),
    },
    {
      label: "Last verified",
      value: utc(isoFromNs(cert.last_verified_ns)),
      time: isoFromNs(cert.last_verified_ns),
    },
    { label: "Surprise re-tests passed", value: String(cert.retests_passed) },
    {
      label: "Sitting paid by",
      value: cert.requested_by,
      href: explorerAccount(encodeURIComponent(cert.requested_by)),
    },
  ];
  const sittingTx = CERT_TXS[cert.cert_id];
  const evidence = sittingTx
    ? explorerTx(sittingTx)
    : explorerAccount(REGISTRY);

  return (
    <article
      ref={root}
      aria-labelledby={`cert-${cert.cert_id}-no cert-${cert.cert_id}-title`}
      className="relative overflow-hidden rounded-sm border border-rule bg-paper-raised p-6 shadow-[0_1px_0_var(--rule),0_18px_40px_-28px_rgb(0_0_0/0.45)] sm:p-8"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(0deg,transparent,transparent_27px,var(--rule)_28px)] opacity-25"
      />
      <header className="relative flex flex-wrap items-baseline justify-between gap-3 border-b border-rule pb-4">
        <p
          id={`cert-${cert.cert_id}-no`}
          className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted"
        >
          PROCTOR · Certificate No. {String(cert.cert_id).padStart(3, "0")}
        </p>
        <StatusBadge state={state} />
      </header>

      <div className="relative mt-6 grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <p className="text-sm text-ink-muted">This certifies that</p>
          <h3
            id={`cert-${cert.cert_id}-title`}
            className="hash mt-1 font-serif text-2xl leading-tight text-ink sm:text-3xl"
          >
            <Breakable text={cert.candidate_model} />
          </h3>
          <p className="mt-3 text-sm text-ink-muted">
            passed the sealed exam{" "}
            <span className="hash text-ink">{cert.exam_id}</span>
          </p>
          {cert.candidate_endpoint && (
            <p className="mt-1 text-sm text-ink-muted">
              answering at{" "}
              <span className="hash text-ink">
                <Breakable text={cert.candidate_endpoint} />
              </span>
              , where every re-test asks again
            </p>
          )}
        </div>
        <div className="text-left sm:text-right">
          <p className="font-serif text-5xl leading-none text-ink">
            {cert.correct}
            <span className="text-ink-muted">/{cert.total}</span>
          </p>
          <p className="mt-1 font-mono text-xs text-ink-muted">
            {(cert.score_bps / 100).toFixed(2)}%
          </p>
        </div>
      </div>

      {reason && (
        <p className="relative mt-5 rounded border border-suspended bg-suspended-soft px-3 py-2 text-sm text-suspended">
          {reason}
        </p>
      )}

      <dl className="relative mt-6 grid gap-x-8 gap-y-3 border-t border-rule pt-5 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">
              {f.label}
            </dt>
            <dd className="hash mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
              {f.href ? (
                <a
                  href={f.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-6 items-center underline decoration-ink-muted underline-offset-4 hover:decoration-seal hover:text-seal"
                >
                  <span aria-hidden={f.full ? true : undefined}>{f.value}</span>
                  {f.full && (
                    <span className="sr-only">{f.label} release on GitHub</span>
                  )}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : f.time ? (
                <time dateTime={f.time}>{f.value}</time>
              ) : (
                <span aria-hidden={f.full ? true : undefined}>{f.value}</span>
              )}
              {f.full && (
                <>
                  <code className="sr-only">{f.full}</code>
                  <CopyButton
                    text={f.full}
                    label={`full ${f.label.toLowerCase()} hash`}
                    className="min-h-7 px-2 py-0 text-xs"
                  />
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <footer className="relative mt-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-start gap-3">
          <a
            href={evidence}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded border border-seal px-4 text-sm font-medium text-seal transition-colors hover:bg-seal hover:text-paper"
          >
            Verify on NEAR Explorer
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <RetestButton certId={cert.cert_id} revoked={state === "revoked"} />
        </div>
        <svg
          data-seal
          viewBox="0 0 120 120"
          className="size-24 shrink-0 text-seal"
          aria-hidden="true"
        >
          <circle
            cx="60"
            cy="60"
            r="54"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
          <circle
            cx="60"
            cy="60"
            r="44"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
          <path
            id={`seal-arc-${cert.cert_id}`}
            d="M 19 60 A 41 41 0 1 1 101 60"
            fill="none"
          />
          <text
            fontSize="9"
            letterSpacing="1.6"
            fill="currentColor"
            fontFamily="var(--font-plex-mono)"
          >
            <textPath
              href={`#seal-arc-${cert.cert_id}`}
              startOffset="50%"
              textAnchor="middle"
            >
              PROCTOR · NEAR
            </textPath>
          </text>
          <text
            x="60"
            y="72"
            textAnchor="middle"
            fontSize="22"
            fill="currentColor"
            fontFamily="var(--font-newsreader)"
          >
            {state === "active"
              ? "PASS"
              : state === "suspended"
                ? "HOLD"
                : "VOID"}
          </text>
        </svg>
      </footer>
    </article>
  );
}
