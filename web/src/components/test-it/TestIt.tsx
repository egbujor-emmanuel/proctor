import { CopyCommand } from "@/components/ui/CopyCommand";
import { explorerAccount, REGISTRY } from "@/lib/config";
import { Eyebrow } from "@/components/ui/Eyebrow";

const EXAM = "near-protocol-basics-demo-v1";
const MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
/** PROCTOR's public demo agent; GET / on it says which model answers right now. */
const DEMO_AGENT = "https://proctor-demo-agent.attrito.workers.dev/v1/chat/completions";

const STEPS = [
  {
    title: "Read a live certificate. No setup.",
    body: "Any NEAR RPC answers this. The registry is a public contract and view calls are free.",
    command: `near contract call-function as-read-only ${REGISTRY} is_certified json-args '{"candidate_model":"${MODEL}","exam_id":"${EXAM}"}' network-config testnet now`,
    label: "check a certificate",
  },
  {
    title: "Get a free testnet account.",
    body: "NEAR's faucet funds it with test NEAR. Install near-cli-rs first (npm i -g near-cli-rs).",
    command: "near account create-account sponsor-by-faucet-service <your-name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create",
    label: "create a testnet account",
  },
  {
    title: "Sit the exam yourself.",
    body: "Your agent is sat through PROCTOR's demo endpoint and certified under your own account, as agent:<your-name>.testnet/my-agent. 0.1 test NEAR pays for the run and OutLayer refunds what it doesn't use. The verdict lands on chain in the same transaction, about 30 seconds later: certified or failed, depending on which model the demo agent is running.",
    command: `near contract call-function as-transaction ${REGISTRY} sit_exam_as_agent json-args '{"exam_id":"${EXAM}","name":"my-agent","endpoint":"${DEMO_AGENT}"}' prepaid-gas '300.0 Tgas' attached-deposit '0.1 NEAR' sign-as <your-name>.testnet network-config testnet sign-with-legacy-keychain send`,
    label: "sit the exam",
  },
  {
    title: "Run every test.",
    body: "Grading core, exam runner, benchmark, registry contract, MCP server, demo agent and website in one command; CI also runs the contract on a local NEAR node.",
    command: "git clone https://github.com/egbujor-emmanuel/proctor && cd proctor && bash scripts/test-all.sh",
    label: "run the test suites",
  },
];

export function TestIt() {
  return (
    <section id="test-it" aria-labelledby="test-it-title" className="border-y border-rule bg-paper-raised">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <Eyebrow text="For judges and builders" />
            <h2 id="test-it-title" className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
              Test it in 5 minutes
            </h2>
            <p className="mt-5 text-ink-muted">
              Everything runs on NEAR testnet, so it costs nothing. The registry is{" "}
              <a href={explorerAccount(REGISTRY)} target="_blank" rel="noopener noreferrer" className="hash text-seal underline underline-offset-4">
                {REGISTRY}
              </a>
              .
            </p>
          </div>
          <ol role="list" className="grid gap-8">
            {STEPS.map((step, i) => (
              <li key={step.title} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4">
                <span aria-hidden="true" className="font-serif text-3xl leading-none text-seal">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="font-medium text-ink">{step.title}</h3>
                  <p className="mt-1 text-sm text-ink-muted">{step.body}</p>
                  <div className="mt-3">
                    <CopyCommand command={step.command} label={step.label} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
