#!/usr/bin/env node
// Verifies one PROCTOR sitting from public data. Usage:
//
//   NEARAI_API_KEY=... node mcp/dist/verify-cli.js --tx <hash> --sender <account that sent it>
//
// Environment: PROCTOR_REGISTRY (default registry-v2.attrito.testnet),
// NEAR_RPC_URL (default FastNEAR testnet), NEARAI_API_KEY (any NEAR AI Cloud
// key; signature lookups are not billed). Exits 0 only if every check passes.

import { createRegistryReader } from "./near.js";
import { Attestations, checkAnswer, readTransactionLogs, responseIdsHash, sittingFromLogs } from "./verify.js";

const DEFAULT_RPC = "https://rpc.testnet.fastnear.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const line = (ok: boolean, text: string) => console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);

async function main(): Promise<boolean> {
  const tx = arg("--tx");
  const sender = arg("--sender");
  if (!tx || !sender) throw new Error("usage: verify-cli --tx <transaction hash> --sender <account that sent it>");
  const rpcUrl = process.env.NEAR_RPC_URL ?? DEFAULT_RPC;
  const contractId = process.env.PROCTOR_REGISTRY ?? "registry-v2.attrito.testnet";
  const registry = createRegistryReader({ rpcUrl, contractId });

  const sitting = sittingFromLogs(await readTransactionLogs(rpcUrl, tx, sender));
  console.log(`sitting ${sitting.sittingId}: ${sitting.candidate}, outcome ${JSON.stringify(sitting.outcome)}`);
  let allOk = true;

  const certId = Object.values(sitting.outcome).map((v) => (v as { cert_id?: number })?.cert_id).find((id) => id !== undefined);
  if (certId !== undefined) {
    const cert = await registry.getCertificate(certId);
    if (!cert) throw new Error(`certificate ${certId} not found on ${contractId}`);
    if (cert.sitting_id === sitting.sittingId) {
      const ok = responseIdsHash(sitting.responseIds) === cert.response_ids_hash;
      line(ok, `certificate ${certId}: response_ids_hash matches the ${sitting.responseIds.length} completion ids in the event`);
      allOk &&= ok;
    } else {
      console.log(`info  certificate ${certId} was issued by sitting ${cert.sitting_id}; this is a re-test, so its ids are checked by signature only`);
    }
    if (sitting.runnerHash) {
      const ok = sitting.runnerHash === cert.runner_hash;
      line(ok, `OutLayer ran runner ${sitting.runnerHash.slice(0, 12)}… (${sitting.runnerUrl}), the build on the certificate`);
      allOk &&= ok;
    }
  }

  const apiKey = process.env.NEARAI_API_KEY;
  if (!apiKey) {
    console.log("SKIP  signatures not checked: set NEARAI_API_KEY (any NEAR AI Cloud key; lookups are not billed)");
    return false;
  }
  const attestations = new Attestations(apiKey);
  for (const id of sitting.responseIds) {
    const check = await checkAnswer(id, apiKey, attestations);
    const where = check.kind === "provider_tee" ? `signed inside ${check.model}'s TEE` : check.kind === "gateway" ? "signed by NEAR AI's gateway TEE (model at an external provider)" : "";
    line(check.ok, `${id}: ${check.ok ? `${where}, signer ${check.signer} is attested` : check.error}`);
    allOk &&= check.ok;
  }
  return allOk;
}

main().then(
  (ok) => {
    console.log(ok ? "\nverified" : "\nNOT fully verified");
    process.exit(ok ? 0 : 1);
  },
  (error) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
  },
);
