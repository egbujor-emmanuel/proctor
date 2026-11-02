#!/usr/bin/env node
// What an exam author's PROCTOR earnings would pay out as through NEAR
// Intents (1Click): a dry quote only. Nothing is committed, no deposit
// address is created and nothing moves. Earnings are withdrawn from the
// registry in NEAR (withdraw_earnings); this shows the same amount swapped to
// another chain's token in one step on mainnet.
//
//   node scripts/payout-quote.mjs --author author.testnet --recipient 0x... [--to USDC:base] [--refund-to you.near]
//   node scripts/payout-quote.mjs --amount 2.5 --recipient 0x...
//
// Asset ids come from GET /v0/tokens, never hard-coded.

const ONE_CLICK = "https://1click.chaindefuser.com";
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const REGISTRY = process.env.REGISTRY ?? "registry-v2.attrito.testnet";
const YOCTO_PER_NEAR = 10n ** 24n;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** NEAR as a decimal string -> yoctoNEAR, exactly. */
export function toYocto(near) {
  if (!/^\d+(\.\d{1,24})?$/.test(near)) throw new Error(`not a NEAR amount: ${near}`);
  const [whole, frac = ""] = near.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

/** Smallest units -> a decimal string with `decimals` places, trimmed. */
export function fromUnits(units, decimals) {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

async function json(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function authorBalanceYocto(author) {
  const args = Buffer.from(JSON.stringify({ author })).toString("base64");
  const body = await json(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proctor", method: "query", params: { request_type: "call_function", finality: "final", account_id: REGISTRY, method_name: "get_author_balance", args_base64: args } }),
  });
  if (body.error || body.result?.error) throw new Error(`get_author_balance failed: ${JSON.stringify(body.error ?? body.result.error)}`);
  return BigInt(JSON.parse(Buffer.from(body.result.result).toString("utf8")));
}

async function main() {
  const recipient = arg("--recipient");
  if (!recipient) throw new Error("--recipient <address on the destination chain> is required");
  const [symbol, chain] = arg("--to", "USDC:base").split(":");
  const refundTo = arg("--refund-to", "attrito.near");
  const author = arg("--author");
  const amount = arg("--amount");

  let yocto;
  if (amount !== undefined) yocto = toYocto(amount);
  else if (author) yocto = await authorBalanceYocto(author);
  else throw new Error("pass --author <account> (reads its earnings) or --amount <NEAR>");
  if (yocto === 0n) {
    console.log(JSON.stringify({ author, earnings_near: "0", note: "nothing earned yet, so nothing to quote" }));
    return;
  }

  const tokens = await json(`${ONE_CLICK}/v0/tokens`);
  const from = tokens.find((t) => t.blockchain === "near" && t.symbol === "wNEAR");
  const to = tokens.find((t) => t.blockchain === chain && t.symbol.toLowerCase() === symbol.toLowerCase());
  if (!from || !to) throw new Error(`1Click lists no ${from ? `${symbol} on ${chain}` : "wNEAR on near"}`);

  const quote = await json(`${ONE_CLICK}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: from.assetId,
      destinationAsset: to.assetId,
      amount: yocto.toString(),
      depositType: "ORIGIN_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      referral: "proctor",
    }),
  });
  const q = quote.quote ?? {};
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        earnings_near: fromUnits(yocto, 24),
        pays_out: `${q.amountOutFormatted ?? fromUnits(q.amountOut ?? 0, to.decimals)} ${to.symbol} on ${to.blockchain}`,
        at_least: q.minAmountOut ? `${fromUnits(q.minAmountOut, to.decimals)} ${to.symbol}` : undefined,
        usd_value: q.amountOutUsd,
        eta_seconds: q.timeEstimate,
        from_asset: from.assetId,
        to_asset: to.assetId,
        note: "Dry quote: nothing was committed. A real payout runs on mainnet only, with the author's go-ahead.",
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("payout-quote.mjs")) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}
