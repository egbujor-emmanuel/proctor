"use client";

import useSWR from "swr";

import { CopyCommand } from "@/components/ui/CopyCommand";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { CLAIMS } from "@/data/claims";
import { explorerTx } from "@/lib/config";
import { runLiveChecks, type LiveCheck } from "@/lib/live-checks";

const REPO_BLOB = "https://github.com/egbujor-emmanuel/proctor/blob/master";

const VERDICT: Record<"pass" | "fail" | "unknown" | "pending", { label: string; className: string }> = {
  pass: { label: "Pass", className: "border-active bg-active-soft text-active" },
  fail: { label: "Fail", className: "border-revoked bg-revoked-soft text-revoked" },
  unknown: { label: "Not checked", className: "border-rule bg-paper-sunk text-ink-muted" },
  pending: { label: "Checking", className: "border-rule bg-paper-sunk text-ink-muted" },
};

function verdictOf(check: LiveCheck | undefined): keyof typeof VERDICT {
  if (!check) return "pending";
  return check.ok === true ? "pass" : check.ok === false ? "fail" : "unknown";
}

const PLACEHOLDERS: Pick<LiveCheck, "id" | "title">[] = [
  { id: "registry-code", title: "The registry runs the CI build" },
  { id: "escrow-code", title: "The escrow runs the CI build" },
  { id: "runner", title: "The registry grades with the released runner" },
  { id: "timelock", title: "No new runner build can grade without 24 hours' notice" },
  { id: "sentinel", title: "The sentinel can run surprise re-tests" },
];

/** Live checks against the chain, then each claim with its test and transaction. */
export function Verify() {
  const { data, isValidating, mutate } = useSWR("live-checks", () => runLiveChecks(), { revalidateOnFocus: false });
  const passed = data?.filter((c) => c.ok === true).length;

  return (
    <section id="verify" aria-labelledby="verify-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <Eyebrow text="Verify it yourself" />
      <h2 id="verify-title" className="mt-3 max-w-3xl font-serif text-4xl text-ink sm:text-5xl">
        Checked against the chain as you read this
      </h2>
      <p className="mt-5 max-w-prose text-ink-muted">
        This page just read NEAR testnet: the code each contract runs, the runner build the registry pins, and whether the sentinel is armed. Each
        claim below names the test that checks it and the transaction that shows it.
      </p>

      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="font-serif text-2xl text-ink">Live checks</h3>
        <p className="font-mono text-xs text-ink-muted" aria-live="polite">
          {data ? `${passed} of ${data.length} passed` : "reading NEAR testnet…"}
          <button
            type="button"
            onClick={() => void mutate()}
            disabled={isValidating}
            className="ml-3 inline-flex min-h-8 items-center rounded border border-rule px-2 text-ink hover:border-seal hover:text-seal disabled:opacity-60"
          >
            {isValidating ? "Checking…" : "Run again"}
          </button>
        </p>
      </div>
      <ul role="list" className="mt-4 divide-y divide-rule rounded-sm border border-rule bg-paper-raised">
        {PLACEHOLDERS.map((p) => {
          const check = data?.find((c) => c.id === p.id);
          const v = VERDICT[verdictOf(check)];
          return (
            <li key={p.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[7rem_1fr] sm:items-baseline">
              <span className={`inline-flex w-fit items-center rounded-full border px-2.5 py-0.5 font-mono text-xs uppercase tracking-wide ${v.className}`}>{v.label}</span>
              <div className="min-w-0">
                <p className="text-ink">{p.title}</p>
                <p className="hash mt-1 break-words text-sm text-ink-muted">{check?.detail ?? "…"}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <h3 className="mt-14 font-serif text-2xl text-ink">Claims, with their evidence</h3>
      <div className="mt-4 relative overflow-x-auto rounded-sm border border-rule">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <caption className="sr-only">Each claim with the test that checks it and the transaction that shows it</caption>
          <thead className="bg-paper-sunk font-mono text-xs uppercase tracking-wide text-ink-muted">
            <tr>
              <th scope="col" className="px-4 py-3">Claim</th>
              <th scope="col" className="px-4 py-3">Test</th>
              <th scope="col" className="px-4 py-3">On chain</th>
            </tr>
          </thead>
          <tbody>
            {CLAIMS.map((c) => (
              <tr key={c.test.name} className="border-t border-rule align-top">
                <th scope="row" className="px-4 py-3 font-normal text-ink">{c.claim}</th>
                <td className="px-4 py-3">
                  <a href={`${REPO_BLOB}/${c.test.file}`} target="_blank" rel="noopener noreferrer" className="hash break-words text-ink-muted underline underline-offset-4 hover:text-seal">
                    {c.test.name}
                    <span className="sr-only"> in {c.test.file} (opens in a new tab)</span>
                  </a>
                </td>
                <td className="px-4 py-3">
                  {c.tx ? (
                    <a href={explorerTx(c.tx)} target="_blank" rel="noopener noreferrer" className="hash text-ink-muted underline underline-offset-4 hover:text-seal">
                      {c.tx.slice(0, 8)}…<span className="sr-only"> transaction (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span className="text-ink-muted">a test, not a transaction</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-ink-muted">
        Every claim, with the code that enforces it:{" "}
        <a href={`${REPO_BLOB}/CLAIMS.md`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4 hover:text-seal">
          CLAIMS.md<span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>

      <h3 className="mt-14 font-serif text-2xl text-ink">From your own terminal</h3>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="min-w-0">
          <p className="mb-2 text-sm text-ink-muted">Re-read every transaction the README cites, by hash. No account or key.</p>
          <CopyCommand command="node scripts/evidence.mjs" label="the evidence command" />
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-sm text-ink-muted">Check one sitting: NEAR AI&apos;s signatures and the Intel TDX and NVIDIA hardware under them.</p>
          <CopyCommand command="npm --prefix mcp run verify -- --tx 4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1 --sender attrito.testnet" label="the verify command" />
        </div>
      </div>
    </section>
  );
}
