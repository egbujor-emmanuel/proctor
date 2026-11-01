"use client";

import { useState, type FormEvent } from "react";

import { useRegistry } from "@/hooks/useRegistry";
import { candidateId, runCheck, type CandidateKind, type Verdict } from "@/lib/check";
import { MARKET } from "@/lib/config";
import { StatusBadge } from "../registry/StatusBadge";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "done"; verdict: Verdict; market?: string }
  | { kind: "error"; message: string };

const EXAMPLES: { kind: CandidateKind; value: string; label: string }[] = [
  { kind: "model", value: "deepseek-ai/DeepSeek-V4.1-Flash-1017", label: "DeepSeek V4.1 Flash" },
  { kind: "model", value: "openai/gpt-5.4-nano", label: "GPT-5.4 nano" },
  { kind: "market", value: "dailybriefer", label: "market: dailybriefer" },
];

/** The buyer check: hire or don't, from the candidate's live certificates. */
export function CheckAgent() {
  const { data, error: registryError } = useRegistry();
  const [kind, setKind] = useState<CandidateKind>("model");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function check(nextKind: CandidateKind, nextValue: string) {
    const id = candidateId({ kind: nextKind, value: nextValue });
    if ("error" in id) {
      setStatus({ kind: "error", message: id.error });
      return;
    }
    if (!data) {
      setStatus({ kind: "error", message: registryError ? registryError.message : "The registry is still loading. Try again in a moment." });
      return;
    }
    setStatus({ kind: "checking" });
    try {
      const verdict = await runCheck(id.id, data.exams);
      const handle = nextKind === "market" ? nextValue.trim().replace(/^market:/, "") : undefined;
      setStatus({ kind: "done", verdict, market: handle });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "The check failed. Try again." });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void check(kind, value);
  }

  function handleExample(example: (typeof EXAMPLES)[number]) {
    setKind(example.kind);
    setValue(example.value);
    void check(example.kind, example.value);
  }

  const isHire = status.kind === "done" && status.verdict.decision === "hire";

  return (
    <section id="check" aria-labelledby="check-title" className="border-y border-rule bg-paper-sunk">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-seal">The buyer check</p>
          <h2 id="check-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            Check an agent before you hire it
          </h2>
          <p className="mt-5 max-w-prose text-ink-muted">
            The same verdict the PROCTOR MCP server gives Claude Code, computed here from live registry reads. Only a live certificate says
            hire. A failed re-test, or no certificate at all, says don’t.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-4" noValidate>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Candidate type</legend>
              {(["model", "market"] as const).map((k) => (
                <label
                  key={k}
                  className="cursor-pointer rounded-full border border-rule px-4 py-2 text-sm text-ink-muted has-[:checked]:border-ink has-[:checked]:bg-ink has-[:checked]:text-paper has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)]"
                >
                  <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                  {k === "model" ? "NEAR AI model" : "Agent Market handle"}
                </label>
              ))}
            </fieldset>
            <label htmlFor="candidate" className="text-sm font-medium text-ink">
              {kind === "model" ? "Model id" : "Market handle"}
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id="candidate"
                name="candidate"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={kind === "model" ? "deepseek-ai/DeepSeek-V4.1-Flash-1017" : "dailybriefer"}
                autoComplete="off"
                spellCheck={false}
                className="hash min-h-12 w-full rounded border border-rule bg-paper-raised px-4 text-ink placeholder:text-ink-muted/60 focus:border-seal"
              />
              <button
                type="submit"
                disabled={status.kind === "checking"}
                className="min-h-12 shrink-0 rounded bg-ink px-6 font-medium text-paper transition-transform hover:bg-seal active:translate-y-px disabled:opacity-60"
              >
                {status.kind === "checking" ? "Checking…" : "Check"}
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-muted">Try:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.value}
                  type="button"
                  onClick={() => handleExample(ex)}
                  className="min-h-9 rounded border border-rule px-3 text-ink hover:border-seal hover:text-seal"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </form>
        </div>

        <div aria-live="polite" className="min-h-[320px]">
          {status.kind === "idle" && (
            <div className="flex h-full min-h-[320px] items-center justify-center rounded-sm border border-dashed border-rule p-8 text-center text-ink-muted">
              Enter a candidate, or pick one of the examples.
            </div>
          )}
          {status.kind === "checking" && (
            <div className="h-full min-h-[320px] animate-pulse rounded-sm border border-rule bg-paper-raised motion-reduce:animate-none" />
          )}
          {status.kind === "error" && (
            <div role="alert" className="rounded-sm border border-revoked bg-revoked-soft p-6 text-revoked">
              {status.message}
            </div>
          )}
          {status.kind === "done" && (
            <div className={`rounded-sm border-2 bg-paper-raised p-6 sm:p-8 ${isHire ? "border-active" : "border-revoked"}`}>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">Verdict</p>
              <p className={`mt-2 font-serif text-5xl ${isHire ? "text-active" : "text-revoked"}`}>{isHire ? "Hire" : "Do not hire"}</p>
              <p className="hash mt-3 text-sm text-ink">{status.verdict.candidate}</p>
              <ul className="mt-6 grid gap-3">
                {status.verdict.exams.map((exam) => (
                  <li key={exam.exam_id} className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
                    <StatusBadge state={exam.state} />
                    <span className="hash text-sm text-ink-muted">{exam.exam_id}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-5 grid gap-2 text-sm text-ink">
                {status.verdict.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {status.market && (
                <p className="mt-5 rounded border border-rule bg-paper-sunk px-3 py-2 text-sm text-ink-muted">
                  Market track record isn’t shown here: the Agent Market API doesn’t serve browsers on other sites. The MCP server includes it.{" "}
                  <a
                    href={`${MARKET}/a/${encodeURIComponent(status.market)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-seal underline underline-offset-4"
                  >
                    Open {status.market} on the market
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
