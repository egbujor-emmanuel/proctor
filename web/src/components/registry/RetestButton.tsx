"use client";

import { useEffect, useState } from "react";
import { mutate } from "swr";

import { explorerTx } from "@/lib/config";
import { describeOutcome, orderRetest, type OutcomeTone, type RetestResult } from "@/lib/retest";

type Phase = { kind: "idle" } | { kind: "running"; startedAt: number } | { kind: "done"; result: RetestResult };

const TONE: Record<OutcomeTone, string> = {
  active: "border-active bg-active-soft text-active",
  suspended: "border-suspended bg-suspended-soft text-suspended",
  revoked: "border-revoked bg-revoked-soft text-revoked",
  muted: "border-rule bg-paper-sunk text-ink-muted",
};

/** Orders a surprise re-test of one certificate, paid by the sentinel, and shows what it did. */
export function RetestButton({ certId }: { certId: number }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (phase.kind !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  async function run() {
    const startedAt = Date.now();
    setNow(startedAt);
    setPhase({ kind: "running", startedAt });
    const result = await orderRetest(certId);
    setPhase({ kind: "done", result });
    // The certificate's status may have changed: read the registry again.
    if (result.ok) void mutate("registry-snapshot");
  }

  const seconds = phase.kind === "running" ? Math.max(0, Math.round((now - phase.startedAt) / 1000)) : 0;
  const outcome = phase.kind === "done" && phase.result.ok ? describeOutcome(phase.result.outcome) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={phase.kind === "running"}
        className="inline-flex min-h-11 items-center justify-center rounded bg-ink px-4 text-sm font-medium text-paper transition-colors hover:bg-seal disabled:cursor-wait disabled:opacity-70"
      >
        {phase.kind === "running" ? `Re-testing… ${seconds}s` : "Order a surprise re-test"}
      </button>
      <div aria-live="polite" className="text-xs text-ink-muted">
        {phase.kind === "idle" && <p>Free: the sentinel pays. At most once an hour per certificate.</p>}
        {phase.kind === "running" && <p>The runner is sitting the exam again inside OutLayer. About a minute.</p>}
        {phase.kind === "done" && outcome && phase.result.ok && (
          <p className={`rounded border px-3 py-2 text-sm ${TONE[outcome.tone]}`}>
            {outcome.text}{" "}
            <a href={explorerTx(phase.result.tx)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
              See the transaction<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        )}
        {phase.kind === "done" && !phase.result.ok && <p className="text-sm text-ink">Not re-tested: {phase.result.error}</p>}
      </div>
    </div>
  );
}
