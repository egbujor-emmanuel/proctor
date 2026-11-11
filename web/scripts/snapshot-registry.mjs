// Reads the registry at build time and writes src/data/registry-snapshot.json,
// so the page can show real figures on first paint while it reads the live
// chain. The page labels it with its time and replaces it with the live read.
//
//   node scripts/snapshot-registry.mjs
//
// Offline (no RPC), it keeps the committed snapshot and exits 0, so a build
// never fails for want of a network.

import { writeFile } from "node:fs/promises";

const REGISTRY = "registry-v2.attrito.testnet";
const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://test.rpc.fastnear.com"];
const OUT = new URL("../src/data/registry-snapshot.json", import.meta.url);
const PAGE = 100;

async function view(method, args) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "proctor-snapshot",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: REGISTRY,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    },
  });
  const errors = [];
  for (const url of RPC_URLS) {
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
      const json = await response.json();
      if (!json.result?.result) throw new Error(JSON.stringify(json.error ?? json.result?.error ?? "no result"));
      return JSON.parse(Buffer.from(json.result.result).toString());
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(`${method} failed on every node: ${errors.join("; ")}`);
}

async function listAll(method) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const page = await view(method, { from_index: from, limit: PAGE });
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

try {
  const [config, exams, certificates] = await Promise.all([view("get_config", {}), listAll("list_exams"), listAll("list_certificates")]);
  const snapshot = { registry: REGISTRY, readAt: Date.now(), config, exams, certificates };
  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`snapshot: ${exams.length} exam(s), ${certificates.length} certificate(s), sitting ${config.next_sitting_id}`);
} catch (error) {
  console.warn(`snapshot: kept the committed snapshot (${error instanceof Error ? error.message : error})`);
}
