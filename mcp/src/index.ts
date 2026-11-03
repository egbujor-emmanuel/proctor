#!/usr/bin/env node
// stdio entry point. Configure with environment variables:
//   PROCTOR_REGISTRY  registry contract account (required)
//   NEAR_RPC_URL      NEAR JSON-RPC endpoint (default: FastNEAR testnet)
//   PROCTOR_MARKET_URL  Agent Market base URL (default: https://market.near.ai)
//   PROCTOR_TRUSTED_AUTHORS  comma-separated exam authors whose exams count
//                     when no exam is named (default: attrito.testnet)
// stdout carries the MCP protocol, so diagnostics go to stderr only.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMarketReader } from "./market.js";
import { createRegistryReader } from "./near.js";
import { createProctorServer } from "./server.js";

const DEFAULT_RPC = "https://rpc.testnet.fastnear.com";

function trustedAuthorsFromEnv(value: string | undefined): string[] | undefined {
  const authors = value?.split(",").map((a) => a.trim()).filter(Boolean);
  return authors && authors.length > 0 ? authors : undefined;
}

async function main(): Promise<void> {
  const contractId = process.env.PROCTOR_REGISTRY;
  if (!contractId) {
    throw new Error("PROCTOR_REGISTRY is not set: name the registry contract account, e.g. registry-v2.attrito.testnet");
  }
  const server = createProctorServer({
    registry: createRegistryReader({ rpcUrl: process.env.NEAR_RPC_URL ?? DEFAULT_RPC, contractId }),
    market: createMarketReader({ baseUrl: process.env.PROCTOR_MARKET_URL }),
    trustedAuthors: trustedAuthorsFromEnv(process.env.PROCTOR_TRUSTED_AUTHORS),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`proctor-mcp: serving registry ${contractId}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`proctor-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
