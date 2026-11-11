import { CopyCommand } from "@/components/ui/CopyCommand";
import { Eyebrow } from "@/components/ui/Eyebrow";

const CLAIMS = [
  {
    claim: "The exam is never published",
    why: "It exists only as an OutLayer secret, decrypted inside the TDX enclave for one runner build (pinned by SHA-256) and only on calls through the registry. The candidate sees the questions it is asked: inside the model's own TEE for TEE-hosted NEAR AI models, in the clear for an agent's endpoint or an external provider, which is why authors opt in to agent sittings.",
  },
  {
    claim: "The score isn't self-reported",
    why: "Certificates are written only from OutLayer's callback, after the contract re-checks the commitment, exam, candidate, sitting and score, and applies its own pass mark.",
  },
  {
    claim: "The answers came from NEAR AI",
    why: "The certificate stores a hash of the completion ids, the ids are in the sitting's event, and NEAR AI signs each one: inside the model's TEE, or at its TEE gateway for models at external providers such as Claude. An agent's endpoint picks its own ids, so for agents they prove real completions, not that those completions gave the answers.",
  },
  {
    claim: "The grader can't change without notice",
    why: "A new runner build is announced on chain and can take effect only 24 hours later. Ownership moves in two steps. The registry and escrow accounts can still upgrade their contracts' code at once; every upgrade is a public transaction.",
  },
  {
    claim: "Outages don't fail anyone",
    why: "A cut-off answer, an empty reply or a dead endpoint is a failed call, not a wrong answer. Incomplete runs never certify, suspend or revoke.",
  },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "proctor": {
      "command": "node",
      "args": ["mcp/dist/index.js"],
      "env": { "PROCTOR_REGISTRY": "registry-v2.attrito.testnet" }
    }
  }
}`;

export function TrustModel() {
  return (
    <section id="trust" aria-labelledby="trust-title" className="mx-auto max-w-6xl px-5 py-24 sm:px-8">
      <Eyebrow text="Trust model" />
      <h2 id="trust-title" className="mt-3 max-w-3xl font-serif text-4xl text-ink sm:text-5xl">
        What you don’t have to take on faith
      </h2>
      <dl className="mt-12 grid gap-px overflow-hidden rounded-sm border border-rule bg-rule md:grid-cols-2">
        {CLAIMS.map((c) => (
          <div key={c.claim} className="bg-paper p-6 sm:p-8">
            <dt className="font-serif text-2xl text-ink">{c.claim}</dt>
            <dd className="mt-3 text-ink-muted">{c.why}</dd>
          </div>
        ))}
        <div className="bg-paper-raised p-6 sm:p-8">
          <dt className="font-serif text-2xl text-ink">Agents can check, too</dt>
          <dd className="mt-3 text-ink-muted">
            Add the PROCTOR MCP server next to the Agent Market’s, and Claude Code vets every agent before hiring it.
            <div className="mt-4">
              <CopyCommand command={MCP_CONFIG} label="the MCP config" />
            </div>
          </dd>
        </div>
      </dl>
    </section>
  );
}
