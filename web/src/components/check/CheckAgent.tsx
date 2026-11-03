"use client";

import { useRef, useState, type FormEvent } from "react";

import { useRegistry } from "@/hooks/useRegistry";
import { candidateId, runCheck, snapshotVerdict, type CandidateKind, type Verdict } from "@/lib/check";
import { Breakable } from "@/components/ui/Breakable";
import { formatUtc } from "@/lib/config";
import { registry } from "@/lib/registry";
import LatticeLoader from "@/components/bits/LatticeLoader";
import { StatusBadge } from "../registry/StatusBadge";
import { Eyebrow } from "@/components/ui/Eyebrow";

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  // provisionalAt: answered from the registry as read then, while the live read runs.
  | { kind: "done"; verdict: Verdict; provisionalAt?: number }
  | { kind: "error"; message: string };

const EXAMPLES: { kind: CandidateKind; value: string; label: string }[] = [
  { kind: "model", value: "deepseek-ai/DeepSeek-V4.1-Flash-1017", label: "DeepSeek V4.1 Flash" },
  { kind: "model", value: "openai/gpt-5.4-nano", label: "GPT-5.4 nano" },
  { kind: "agent", value: "attrito.testnet/demo-agent", label: "agent: demo-agent" },
];

const HINT: Record<CandidateKind, string> = {
  model: "A NEAR AI model id, such as org/model-name. Letters, digits and . _ : / @ + - only.",
  agent: "An agent that sits exams through its own endpoint: the NEAR account that registered it, a slash, and its name.",
};

type Tone = "hire" | "unknown" | "refuse";

/**
 * "unknown" when nothing is on record: the verdict is still do_not_hire, but
 * nothing bad is known either, so it reads differently from a revocation.
 */
function toneOf(verdict: Verdict): Tone {
  if (verdict.decision === "hire") return "hire";
  return verdict.exams.every((e) => e.state === "none") ? "unknown" : "refuse";
}

const HEADLINE: Record<Tone, string> = { hire: "Hire", unknown: "No certificate", refuse: "Do not hire" };
const TONE_CLASS: Record<Tone, { border: string; text: string }> = {
  hire: { border: "border-active", text: "text-active" },
  unknown: { border: "border-ink-muted", text: "text-ink" },
  refuse: { border: "border-revoked", text: "text-revoked" },
};

/** One short sentence for screen readers, instead of reading the whole card. */
function announcement(status: Status): string {
  if (status.kind === "checking") return "Checking the registry.";
  if (status.kind === "error") return status.message;
  if (status.kind === "done") {
    const { candidate, reasons } = status.verdict;
    return `${HEADLINE[toneOf(status.verdict)]}: ${candidate}. ${reasons[0] ?? ""}`;
  }
  return "";
}

/** The buyer check: hire or don't, from the candidate's live certificates. */
export function CheckAgent() {
  const { data, isStale } = useRegistry();
  const [kind, setKind] = useState<CandidateKind>("model");
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Only the most recent check may set the result: an older, slower one
  // must never overwrite a newer verdict.
  const latest = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const isChecking = status.kind === "checking";

  async function check(nextKind: CandidateKind, nextValue: string) {
    const id = candidateId({ kind: nextKind, value: nextValue });
    if ("error" in id) {
      // The previous verdict answered a different id; don't leave it beside the error.
      latest.current += 1;
      setStatus({ kind: "idle" });
      setFieldError(id.error);
      input.current?.focus();
      return;
    }
    setFieldError(null);
    const mine = ++latest.current;
    // Answer at once from the registry the page already holds, labelled as such,
    // then replace it with the live read.
    const quick = data ? snapshotVerdict(id.id, data.exams, data.certificates) : null;
    setStatus(quick && data ? { kind: "done", verdict: quick, provisionalAt: data.readAt } : { kind: "checking" });
    try {
      // Before the page's first registry read lands, read the exam list here
      // rather than asking the user to come back.
      const exams = data?.exams ?? (await registry.exams()).rows;
      const verdict = await runCheck(id.id, exams, data?.certificates ?? []);
      if (mine !== latest.current) return;
      setStatus({ kind: "done", verdict });
    } catch (e) {
      if (mine !== latest.current) return;
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "The check failed. Try again." });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isChecking) void check(kind, value);
  }

  function handleExample(example: (typeof EXAMPLES)[number]) {
    if (isChecking) return;
    setKind(example.kind);
    setValue(example.value);
    void check(example.kind, example.value);
  }

  function handleKindChange(next: CandidateKind) {
    setKind(next);
    setFieldError(null);
    // A verdict for the other kind of candidate no longer answers this form.
    latest.current += 1;
    setStatus({ kind: "idle" });
  }

  const tone = status.kind === "done" ? toneOf(status.verdict) : null;
  const describedBy = `candidate-hint${fieldError ? " candidate-error" : ""}`;

  return (
    <section id="check" aria-labelledby="check-title" className="border-y border-rule bg-paper-sunk">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div>
          <Eyebrow text="The buyer check" />
          <h2 id="check-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            Check an agent before you hire it
          </h2>
          <p className="mt-5 max-w-prose text-ink-muted">
            The same verdict the PROCTOR MCP server gives Claude Code, computed here from live registry reads. Only a live certificate says
            hire. A failed re-test, or no certificate at all, says don’t.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 grid gap-3" noValidate>
            <fieldset className="flex flex-wrap gap-2">
              <legend className="sr-only">Candidate type</legend>
              {(["model", "agent"] as const).map((k) => (
                <label
                  key={k}
                  className="group cursor-pointer rounded-full border border-ink-muted/50 px-4 py-2 text-sm text-ink-muted has-[:checked]:border-ink has-[:checked]:bg-ink has-[:checked]:text-paper has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--focus)] forced-colors:has-[:checked]:underline"
                >
                  <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => handleKindChange(k)} className="sr-only" />
                  <span aria-hidden="true" className="hidden group-has-[:checked]:inline">
                    ✓{" "}
                  </span>
                  {k === "model" ? "NEAR AI model" : "Agent endpoint"}
                </label>
              ))}
            </fieldset>
            <label htmlFor="candidate" className="mt-2 text-sm font-medium text-ink">
              {kind === "model" ? "Model id" : "Agent (owner/name)"}
            </label>
            <p id="candidate-hint" className="-mt-1 text-sm text-ink-muted">
              {HINT[kind]}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                ref={input}
                id="candidate"
                name="candidate"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setFieldError(null);
                }}
                placeholder={kind === "model" ? "deepseek-ai/DeepSeek-V4.1-Flash-1017" : "attrito.testnet/demo-agent"}
                autoComplete="off"
                spellCheck={false}
                aria-required="true"
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={describedBy}
                className="hash min-h-12 w-full min-w-0 rounded border border-ink-muted bg-paper-raised px-3 text-sm text-ink placeholder:text-ink-muted focus:border-seal"
              />
              <button
                type="submit"
                aria-disabled={isChecking}
                className="min-h-12 shrink-0 rounded bg-ink px-6 font-medium text-paper transition-colors hover:bg-seal active:translate-y-px aria-disabled:cursor-progress aria-disabled:opacity-70"
              >
                {isChecking ? "Checking…" : "Check"}
              </button>
            </div>
            {/* The slot keeps its height, so an error never shifts the examples below. */}
            <p id="candidate-error" className="min-h-5 text-sm font-medium text-revoked">
              {fieldError}
            </p>
            <div role="group" aria-labelledby="examples-label" className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <span id="examples-label" className="text-ink-muted">
                Try:
              </span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.value}
                  type="button"
                  onClick={() => handleExample(ex)}
                  aria-disabled={isChecking}
                  className="min-h-9 rounded border border-ink-muted/50 px-3 text-ink hover:border-seal hover:text-seal aria-disabled:opacity-60"
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </form>
          <p className="mt-6 max-w-prose text-sm text-ink-muted">
            Hiring from the NEAR AI Agent Market? The MCP server’s <code className="hash text-ink">proctor_vet_market_agent</code> matches a
            listing to its certificate: the listing names its account with <code className="hash text-ink">proctor:&lt;account&gt;</code>, and
            that account certifies the agent under the listing’s handle.
          </p>
        </div>

        <div className="min-h-[320px]">
          <p role="status" className="sr-only">
            {announcement(status)}
          </p>
          {status.kind === "idle" && (
            <div className="flex h-full min-h-[320px] items-center justify-center rounded-sm border border-dashed border-rule p-8 text-center text-ink-muted">
              Enter a candidate, or pick one of the examples.
            </div>
          )}
          {status.kind === "checking" && (
            <div aria-hidden="true" className="flex h-full min-h-[320px] items-center justify-center rounded-sm border border-rule bg-paper-raised">
              <LatticeLoader label="Reading certificates from NEAR testnet" pattern="orbit" grid={4} color="var(--seal)" fontSize={14} cellSize={7} showTimer />
            </div>
          )}
          {status.kind === "error" && (
            <div className="rounded-sm border border-revoked bg-revoked-soft p-6 text-revoked">{status.message}</div>
          )}
          {status.kind === "done" && (
            <div aria-label="Verdict" className={`rounded-sm border-2 bg-paper-raised p-6 sm:p-8 ${TONE_CLASS[tone ?? "refuse"].border}`}>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-ink-muted">Verdict</p>
              <p className={`mt-2 font-serif text-5xl ${TONE_CLASS[tone ?? "refuse"].text}`}>{HEADLINE[tone ?? "refuse"]}</p>
              {tone === "unknown" && (
                <p className="mt-2 text-sm text-ink-muted">Nothing on record vouches for it, so PROCTOR can’t recommend hiring it. Nothing bad is on record either.</p>
              )}
              <p className="hash mt-3 text-sm text-ink">
                <Breakable text={status.verdict.candidate} />
              </p>
              {status.provisionalAt !== undefined && (
                <p className="mt-2 font-mono text-xs text-ink-muted">
                  From the registry as read at {formatUtc(status.provisionalAt)}; confirming on chain…
                </p>
              )}
              <ul role="list" className="mt-6 grid gap-3">
                {status.verdict.exams.map((exam) => (
                  <li key={exam.exam_id} className="flex flex-wrap items-center gap-3 border-t border-rule pt-3">
                    <StatusBadge state={exam.state} />
                    <span className="hash text-sm text-ink-muted">
                      <span className="sr-only">Exam </span>
                      {exam.exam_id}
                    </span>
                  </li>
                ))}
              </ul>
              <ul role="list" className="mt-5 grid gap-2 text-sm text-ink">
                {status.verdict.reasons.map((r, i) => (
                  <li key={`${i}-${r}`}>{r}</li>
                ))}
              </ul>
              {data && (isStale || data.skipped > 0) && (
                <p className="mt-5 rounded border border-suspended bg-suspended-soft px-3 py-2 text-sm text-suspended">
                  {isStale && `The exam list is from ${formatUtc(data.readAt)}; refreshing it failed. `}
                  {data.skipped > 0 && `${data.skipped} registry record${data.skipped === 1 ? "" : "s"} could not be read and ${data.skipped === 1 ? "was" : "were"} left out.`}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
