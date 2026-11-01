import type { Certificate, Exam } from "../src/near.js";
import type { MarketAgent } from "../src/market.js";

export function certificate(overrides: Partial<Certificate> = {}): Certificate {
  return {
    cert_id: 0,
    exam_id: "near-basics-v1",
    exam_commitment: "aed0590cdb979c1bea7f5d2c3c0f76151524c618a8f71a37ce9a9a4e44bed51c",
    candidate_model: "agent:alice.testnet/dailybriefer",
    candidate_endpoint: "https://dailybriefer.example.org/v1/chat/completions",
    runner_hash: "3cf89b3425f8e8c4029d9cfa34ed9a1925f23dca7a80ddf8d7d74ca927f69c99",
    score_bps: 8000,
    correct: 4,
    total: 5,
    issued_at_ns: 1_761_900_000_000_000_000,
    last_verified_ns: 1_761_990_000_000_000_000,
    retests_passed: 2,
    status: "Active",
    requested_by: "alice.testnet",
    sitting_id: 3,
    response_ids_hash: "ab".repeat(32),
    response_count: 5,
    ...overrides,
  };
}

export function exam(overrides: Partial<Exam> = {}): Exam {
  return {
    exam_id: "near-basics-v1",
    author: "author.testnet",
    title: "NEAR basics",
    commitment: "aed0590cdb979c1bea7f5d2c3c0f76151524c618a8f71a37ce9a9a4e44bed51c",
    pass_mark_bps: 6000,
    question_count: 5,
    active: true,
    sittings: 7,
    ...overrides,
  };
}

export function marketAgent(overrides: Partial<MarketAgent> = {}): MarketAgent {
  return {
    agent_id: "16b5adbc-982d-4802-b392-88a1d482e57b",
    handle: "dailybriefer",
    name: "Daily Briefing",
    description: "Gathers information and writes a daily briefing. Certified by proctor:alice.testnet",
    category: "automation",
    listing_status: "live",
    delivered_jobs: 5,
    success_rate: 63,
    builder: { display_name: "Builder", verification: { level: "identity_verified" } },
    ...overrides,
  };
}

/** Encodes a view-call result the way NEAR RPC returns it: JSON as a byte array. */
export function rpcResult(value: unknown): Response {
  const bytes = [...Buffer.from(JSON.stringify(value))];
  return Response.json({ jsonrpc: "2.0", id: "proctor-mcp", result: { result: bytes, logs: [], block_height: 1 } });
}
