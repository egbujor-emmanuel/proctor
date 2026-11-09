#!/usr/bin/env node
// Verifies one PROCTOR sitting from public data. Usage:
//
//   NEARAI_API_KEY=... node mcp/dist/verify-cli.js --tx <hash> --sender <account that sent it>
//
// Environment: PROCTOR_REGISTRY (default registry-v2.attrito.testnet),
// NEAR_RPC_URL (default FastNEAR's archival testnet node), NEARAI_API_KEY (any
// NEAR AI Cloud key; signature lookups are not billed). Exits 0 only if every
// check ran and passed: 1 if any failed or none could run, 2 on an error.

import { createRegistryReader } from "./near.js";
import { Attestations, checkAnswer, DEFAULT_ATTESTATION_MODEL, readTransaction, responseIdsHash, sittingFromTransaction, type AnswerCheck } from "./verify.js";

// Archival: regular nodes keep about two days of blocks, so any older sitting
// would come back NOT_OBSERVED.
const DEFAULT_RPC = "https://archival-rpc.testnet.fastnear.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

let passed = 0;
let failed = 0;
function check(ok: boolean, text: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
  if (ok) passed += 1;
  else failed += 1;
}

const certIdOf = (outcome: unknown): number | undefined =>
  typeof outcome === "object" && outcome !== null
    ? Object.values(outcome).map((v) => (v as { cert_id?: unknown })?.cert_id).find((id): id is number => typeof id === "number")
    : undefined;

function describe(c: AnswerCheck): string {
  if (!c.ok) return c.error ?? "failed";
  const where = c.kind === "provider_tee" ? `signed inside ${c.model}'s TEE` : "signed by NEAR AI's gateway TEE (model at an external provider)";
  return `${where}; signer ${c.signer} is the key NEAR AI's attestation report lists`;
}

async function main(): Promise<void> {
  const tx = arg("--tx");
  const sender = arg("--sender");
  if (!tx || !sender) throw new Error("usage: verify-cli --tx <transaction hash> --sender <account that sent it>");
  const rpcUrl = process.env.NEAR_RPC_URL ?? DEFAULT_RPC;
  const contractId = process.env.PROCTOR_REGISTRY ?? "registry-v2.attrito.testnet";
  const registry = createRegistryReader({ rpcUrl, contractId });

  const transaction = await readTransaction(rpcUrl, tx, sender);
  check(transaction.receiver === contractId, `the transaction was sent to the registry ${contractId}`);
  const sitting = sittingFromTransaction(transaction, contractId, await registry.getOutlayerAccount());
  console.log(`      sitting ${sitting.sittingId}: ${sitting.candidate} on ${sitting.examId}, outcome ${JSON.stringify(sitting.outcome)}`);

  const recorded = await registry.getOutcome(sitting.sittingId);
  check(JSON.stringify(recorded) === JSON.stringify(sitting.outcome), `the registry's own record of sitting ${sitting.sittingId} matches the event`);

  const certId = certIdOf(sitting.outcome);
  const cert = certId === undefined ? null : await registry.getCertificate(certId);
  if (certId !== undefined) {
    if (!cert) throw new Error(`certificate ${certId} not found on ${contractId}`);
    check(cert.candidate_model === sitting.candidate && cert.exam_id === sitting.examId, `certificate ${certId} is for this candidate and exam`);
    if (cert.sitting_id === sitting.sittingId) {
      check(responseIdsHash(sitting.responseIds) === cert.response_ids_hash, `certificate ${certId}'s response_ids_hash matches the ${sitting.responseIds.length} completion ids in the event`);
    }
  }
  if (sitting.runnerHash) {
    const pinned = cert?.runner_hash;
    check(pinned === undefined || sitting.runnerHash === pinned, `OutLayer ran runner ${sitting.runnerHash.slice(0, 12)}… (${sitting.runnerUrl})${pinned ? ", the build on the certificate" : ""}`);
  } else {
    check(false, "no execution_completed event from OutLayer in this transaction, so the runner is unproven");
  }

  if (sitting.responseIds.length === 0) {
    check(false, "the sitting has no completion ids to check (no answer was recorded)");
    return;
  }
  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) {
    check(false, "signatures not checked: set NEARAI_API_KEY (any NEAR AI Cloud key; lookups are not billed)");
    return;
  }
  const attestations = new Attestations(apiKey);
  // A NEAR AI model candidate must have answered from that model's TEE; agents may use any model.
  const isAgent = sitting.candidate.startsWith("agent:");
  const expectModel = isAgent ? undefined : sitting.candidate;
  if (isAgent) {
    console.log(
      "info  agent candidate: the signatures prove each id is a real NEAR AI completion (and the runner refuses repeated ids), but the agent's endpoint chose them, so they cannot be tied to this sitting's answers",
    );
  }
  const checks = await Promise.all(sitting.responseIds.map((id) => checkAnswer(id, apiKey, attestations, fetch, { expectModel })));
  for (const c of checks) check(c.ok, `${c.id}: ${describe(c)}`);

  // The hardware under those keys: every TEE the signatures relied on, once each.
  if (process.argv.includes("--no-hardware")) return;
  const models = [...new Set(checks.filter((c) => c.kind === "provider_tee" && c.model).map((c) => c.model!))];
  const reports = models.length > 0 ? models.map((m) => [m, false] as const) : [[DEFAULT_ATTESTATION_MODEL, true] as const];
  const seen = new Set<string>();
  for (const [model, gatewayOnly] of reports) {
    for (const h of await attestations.hardware(model, gatewayOnly)) {
      if (seen.has(h.tee)) continue;
      seen.add(h.tee);
      const failedChecks = h.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
      check(h.ok, `hardware: ${h.tee}: ${h.ok ? h.checks.map((c) => c.detail ?? c.name).filter(Boolean).join("; ") : failedChecks.join("; ")}`);
    }
  }
}

main().then(
  () => {
    const ok = failed === 0 && passed > 0;
    console.log(ok ? `\nverified (${passed} checks)` : `\nNOT verified (${failed} failed, ${passed} passed)`);
    process.exit(ok ? 0 : 1);
  },
  (error: unknown) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
