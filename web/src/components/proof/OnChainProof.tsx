import { Eyebrow } from "@/components/ui/Eyebrow";
import { explorerAccount, explorerTx } from "@/lib/config";

const SENTINEL = "proctor-sentinel.testnet";
const REPO = "https://github.com/egbujor-emmanuel/proctor";

interface Step {
  what: string;
  result: string;
  tx: string;
}

/** The model-swap demo, as it happened on testnet. */
const SWAP: Step[] = [
  { what: "The demo agent sits through its own endpoint, answering with Claude Sonnet 5.5", result: "Certified, 4/5", tx: "9Jwx3jXp8We4a77VVBNv7qGLKpL48UC3zF8uf7CX9yT5" },
  { what: "Its owner quietly swaps the same URL to GPT-5.4 nano; a surprise re-test arrives", result: "Suspended, 2/5", tx: "BrcXSNwX1qy7APxoTDNL5heFN22eB5FqoBT4teiQPUYX" },
  { what: "An hour later, another surprise re-test", result: "Revoked, 2/5", tx: "3SGvHzEY7c2Bo91eehtnapZbXE2eVk5mv4y1DDPWBLm4" },
];

const PAYOUT: Step[] = [
  { what: "The exam's author sets a fee per first sitting", result: "0.02 NEAR", tx: "F7LAcipJjpsesrfxGrgbRPCff7oax1SSLeSK99TVBw26" },
  { what: "A paid sitting ends in a verdict, and the author is credited", result: "+0.02 NEAR", tx: "F2rq3GxuZyg8mi3oFaaqDGBLyLQzeVhxWrW6F2jxn2bQ" },
  { what: "The author withdraws their earnings", result: "Paid out", tx: "z53mcD6N5wrzgW4FtB66UJ5SA8XUcjJn3ufgio7RjFR" },
];

function Steps({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <div>
      <h3 className="font-serif text-2xl text-ink">{title}</h3>
      <ol className="mt-5 grid gap-px overflow-hidden rounded-sm border border-rule bg-rule">
        {steps.map((s, i) => (
          <li key={s.tx} className="grid gap-2 bg-paper p-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:items-baseline sm:gap-4">
            <span aria-hidden="true" className="font-mono text-xs text-ink-muted">
              {String(i + 1).padStart(2, "0")}
            </span>
            <p className="text-ink">
              {s.what}. <span className="font-medium text-seal">{s.result}</span>
            </p>
            <a
              href={explorerTx(s.tx)}
              target="_blank"
              rel="noopener noreferrer"
              className="hash inline-flex min-h-6 items-center text-sm text-ink-muted underline decoration-ink-muted underline-offset-4 hover:text-seal"
            >
              {s.tx.slice(0, 8)}…<span className="sr-only"> transaction on NEAR Explorer (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What already happened on chain, with every transaction linked. */
export function OnChainProof() {
  return (
    <section id="proof" aria-labelledby="proof-title" className="border-y border-rule bg-paper-sunk">
      <div className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
        <Eyebrow text="Already on chain" />
        <h2 id="proof-title" className="mt-3 max-w-3xl font-serif text-4xl text-ink sm:text-5xl">
          A quiet model swap, caught in two re-tests
        </h2>
        <div className="mt-12 grid gap-12 lg:grid-cols-2">
          <Steps title="The model-swap demo" steps={SWAP} />
          <Steps title="Exam authors get paid" steps={PAYOUT} />
        </div>
        <dl className="mt-12 grid gap-6 sm:grid-cols-3">
          <div className="border-l border-rule pl-4">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Benchmark, 10 sittings per model</dt>
            <dd className="mt-2 text-ink">
              A swap from Claude Sonnet 5.5 to GPT-5.4 nano is revoked within two re-tests in every measured case.{" "}
              <a href={`${REPO}/blob/master/bench/RESULTS.md`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-seal">
                Full results<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
          <div className="border-l border-rule pl-4">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Surprise re-tests</dt>
            <dd className="mt-2 text-ink">
              A sentinel wakes every hour and, one time in five, re-tests a certificate picked at random. Every one is public.{" "}
              <a href={explorerAccount(SENTINEL)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-seal">
                Its history<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
          <div className="border-l border-rule pl-4">
            <dt className="text-xs uppercase tracking-wide text-ink-muted">Check it yourself</dt>
            <dd className="mt-2 text-ink">
              The verifier re-checks any sitting from public data: the runner build, the completion ids and NEAR AI’s signature on each.{" "}
              <a href={`${REPO}#2-verify-a-certificates-answers-yourself-needs-any-near-ai-cloud-key`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-6 items-center underline underline-offset-4 hover:text-seal">
                How<span className="sr-only"> (opens in a new tab)</span>
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
