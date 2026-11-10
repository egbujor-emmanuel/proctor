#!/usr/bin/env node
// Re-checks every NEAR testnet transaction cited in README.md and CLAIMS.md
// against the chain, and prints what each one did.
//
//   node scripts/evidence.mjs            (exits 1 if any cited transaction is missing or failed)
//
// Reads transactions by hash from FastNear's public transaction API, so no
// account or key is needed.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const API = "https://tx.test.fastnear.com/v0/transactions";
const BATCH = 20;
const TX_LINK = /testnet\.near\.rocks\/tx\/([1-9A-HJ-NP-Za-km-z]{43,44})/g;

/** Every distinct transaction hash linked from the given markdown texts, in first-seen order. */
export function extractTxHashes(...texts) {
  const seen = new Set();
  for (const text of texts) for (const m of text.matchAll(TX_LINK)) seen.add(m[1]);
  return [...seen];
}

/** The PROCTOR or escrow events in a transaction's receipt logs, as short labels. */
export function eventLabels(logs) {
  const out = [];
  for (const log of logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    let event;
    try {
      event = JSON.parse(log.slice("EVENT_JSON:".length));
    } catch {
      continue;
    }
    if (event?.standard !== "proctor" && event?.standard !== "proctor-escrow") continue;
    const data = event.data?.[0] ?? {};
    if (event.event === "sitting_resolved") {
      const outcome = typeof data.outcome === "string" ? data.outcome : Object.keys(data.outcome ?? {})[0];
      out.push(`sitting ${data.sitting_id}: ${outcome} (${data.candidate_model})`);
    } else {
      out.push(event.event);
    }
  }
  return out;
}

/** One row per transaction: who sent it, to what, which method, whether every receipt succeeded, and its events. */
export function summarize(entry) {
  const tx = entry.transaction;
  const receipts = entry.receipts ?? [];
  const failed = receipts.some((r) => r.execution_outcome?.outcome?.status && "Failure" in r.execution_outcome.outcome.status);
  const call = tx.actions.find((a) => typeof a === "object" && a.FunctionCall)?.FunctionCall;
  const logs = receipts.flatMap((r) => r.execution_outcome?.outcome?.logs ?? []);
  return {
    hash: tx.hash,
    signer: tx.signer_id,
    receiver: tx.receiver_id,
    method: call?.method_name ?? (typeof tx.actions[0] === "string" ? tx.actions[0] : Object.keys(tx.actions[0] ?? {})[0]),
    ok: !failed,
    events: eventLabels(logs),
  };
}

async function fetchBatch(hashes) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "proctor-evidence/1.0" },
    body: JSON.stringify({ tx_hashes: hashes }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`FastNear answered HTTP ${res.status}`);
  return (await res.json()).transactions ?? [];
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const hashes = extractTxHashes(read("README.md"), read("CLAIMS.md"));
  const found = new Map();
  for (let i = 0; i < hashes.length; i += BATCH) {
    for (const entry of await fetchBatch(hashes.slice(i, i + BATCH))) found.set(entry.transaction.hash, summarize(entry));
  }
  let problems = 0;
  for (const hash of hashes) {
    const row = found.get(hash);
    if (!row) {
      problems++;
      console.log(`MISSING  ${hash}  not found on NEAR testnet`);
      continue;
    }
    if (!row.ok) problems++;
    const what = row.events.length ? row.events.join("; ") : "no PROCTOR event";
    console.log(`${row.ok ? "OK     " : "FAILED "}  ${hash.slice(0, 10)}…  ${row.signer} → ${row.receiver}.${row.method}  ${what}`);
  }
  console.log(`\n${found.size}/${hashes.length} cited transactions found on NEAR testnet, ${hashes.length - problems} with every receipt succeeding`);
  process.exitCode = problems ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`evidence: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  });
}
