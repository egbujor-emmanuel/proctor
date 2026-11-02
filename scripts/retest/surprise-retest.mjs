#!/usr/bin/env node
// Surprise re-test picker. Reads the registry over NEAR RPC (no keys), then
// prints one JSON line: the certificate to re-test, or why it skipped.
// The GitHub workflow signs the re-test with near-cli-rs.
//
//   REGISTRY=registry-v2.attrito.testnet node scripts/retest/surprise-retest.mjs [--cert N] [--chance 0.25]
//
// --chance makes the hourly schedule fire at random hours, so nobody can
// predict when the next re-test comes. --cert forces one certificate.

import { randomInt } from "node:crypto";

import { pick } from "./pick.mjs";

const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const PAGE = 100;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function view(registry, method, args) {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "proctor-retest",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: registry, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || body.result?.error) throw new Error(`view ${method} failed: ${JSON.stringify(body.error ?? body.result.error)}`);
  // Keep nanosecond timestamps exact: they are above 2^53.
  const text = Buffer.from(body.result.result).toString("utf8").replace(/("(?:last_retest_requested_ns)"\s*:\s*)(\d+)/g, '$1"$2"');
  return JSON.parse(text);
}

async function chainNowNs() {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proctor-retest", method: "block", params: { finality: "final" } }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  // Keep the timestamp exact by reading its digits, not a float.
  const raw = JSON.stringify(body.result?.header ?? {}).match(/"timestamp_nanosec":"(\d+)"/)?.[1];
  if (!raw) throw new Error("could not read the chain's time");
  return BigInt(raw);
}

async function main() {
  const registry = process.env.REGISTRY;
  if (!registry) throw new Error("set REGISTRY to the registry contract account");
  const chance = Number(arg("--chance") ?? "1");
  const only = arg("--cert");
  if (!(chance > 0 && chance <= 1)) throw new Error("--chance must be in (0, 1]");
  if (only === undefined && chance < 1 && randomInt(1_000_000) >= chance * 1_000_000) {
    console.log(JSON.stringify({ skip: `not this hour (fires with probability ${chance})` }));
    return;
  }
  const certs = [];
  for (let from = 0; ; from += PAGE) {
    const value = await view(registry, "list_certificates", { from_index: from, limit: PAGE });
    certs.push(...value);
    if (value.length < PAGE) break;
  }
  const choice = pick(certs, await chainNowNs(), randomInt, only === undefined ? undefined : Number(only));
  console.log(JSON.stringify(choice));
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
