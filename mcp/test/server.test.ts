import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import type { MarketAgent, MarketReader } from "../src/market.js";
import type { Certificate, Exam, RegistryReader } from "../src/near.js";
import { createProctorServer } from "../src/server.js";
import { certificate, exam, marketAgent } from "./fixtures.js";

interface World {
  exams?: Exam[];
  certs?: Record<string, Certificate>;
  agents?: MarketAgent[];
  registryDown?: boolean;
}

function fakes(world: World): { registry: RegistryReader; market: MarketReader } {
  const down = () => {
    if (world.registryDown) throw new Error("NEAR RPC unreachable (test)");
  };
  return {
    registry: {
      contractId: "registry.attrito.testnet",
      async listExams() {
        down();
        return world.exams ?? [exam()];
      },
      async latestCertificate(candidate, examId) {
        down();
        return world.certs?.[`${candidate}|${examId}`] ?? null;
      },
      async getCertificate(certId) {
        down();
        return Object.values(world.certs ?? {}).find((c) => c.cert_id === certId) ?? null;
      },
    },
    market: {
      async findByHandle(handle) {
        return (world.agents ?? []).find((a) => a.handle === handle) ?? null;
      },
    },
  };
}

async function connect(world: World): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createProctorServer(fakes(world)).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  return { isError: result.isError === true, text, json: result.isError ? null : JSON.parse(text) };
}

describe("PROCTOR MCP server", () => {
  it("exposes four read-only tools", async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "proctor_check_candidate",
      "proctor_get_certificate",
      "proctor_list_exams",
      "proctor_vet_market_agent",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("clears a certified market agent for hire", async () => {
    const client = await connect({
      agents: [marketAgent()],
      certs: { "agent:alice.testnet/dailybriefer|near-basics-v1": certificate() },
    });
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "dailybriefer" });
    expect(json.decision).toBe("hire");
    expect(json.candidate).toBe("agent:alice.testnet/dailybriefer");
    expect(json.market.delivered_jobs).toBe(5);
  });

  it("refuses an uncertified market agent", async () => {
    const client = await connect({ agents: [marketAgent()] });
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "dailybriefer" });
    expect(json.decision).toBe("do_not_hire");
    expect(json.reasons[0]).toContain("holds no PROCTOR certificate");
  });

  it("refuses an agent whose certificate is suspended", async () => {
    const status = { Suspended: { reason: "re-test scored 2000 bps", at_ns: 1 } };
    const client = await connect({
      agents: [marketAgent()],
      certs: { "agent:alice.testnet/dailybriefer|near-basics-v1": certificate({ status }) },
    });
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "dailybriefer", exam_id: "near-basics-v1" });
    expect(json.decision).toBe("do_not_hire");
    expect(json.exams[0].certificate.reason).toBe("re-test scored 2000 bps");
  });

  it("refuses a listing that does not name its PROCTOR account", async () => {
    const client = await connect({
      agents: [marketAgent({ description: "Gathers information" })],
      certs: { "agent:alice.testnet/dailybriefer|near-basics-v1": certificate() },
    });
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "dailybriefer" });
    expect(json.decision).toBe("do_not_hire");
    expect(json.reasons).toEqual([expect.stringContaining('"proctor:<account>"')]);
    expect(json.market.delivered_jobs).toBe(5);
  });

  it("does not let a listing borrow another account's certificate", async () => {
    // Mallory's listing names Alice's account; Alice certified her own handle, not Mallory's.
    const client = await connect({
      agents: [marketAgent({ handle: "copycat", description: "proctor:alice.testnet" })],
      certs: { "agent:alice.testnet/dailybriefer|near-basics-v1": certificate() },
    });
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "copycat" });
    expect(json.candidate).toBe("agent:alice.testnet/copycat");
    expect(json.decision).toBe("do_not_hire");
  });

  it("refuses a handle that is not on the market", async () => {
    const client = await connect({});
    const { json } = await call(client, "proctor_vet_market_agent", { handle: "ghost" });
    expect(json.decision).toBe("do_not_hire");
    expect(json.reasons[0]).toContain("no Agent Market agent has the handle 'ghost'");
  });

  it("checks only active exams when none is named", async () => {
    const client = await connect({
      exams: [exam({ exam_id: "old", active: false }), exam({ exam_id: "current" })],
      certs: { "m|old": certificate({ exam_id: "old" }) },
    });
    const { json } = await call(client, "proctor_check_candidate", { candidate: "m" });
    expect(json.exams.map((e: { exam_id: string }) => e.exam_id)).toEqual(["current"]);
    expect(json.decision).toBe("do_not_hire");
  });

  it("returns a certificate by id and errors for unknown ids", async () => {
    const client = await connect({ certs: { "m|near-basics-v1": certificate({ cert_id: 4, candidate_model: "m" }) } });
    const found = await call(client, "proctor_get_certificate", { cert_id: 4 });
    expect(found.json).toMatchObject({ cert_id: 4, candidate: "m", state: "active", score: "4/5 (80.00%)" });
    const missing = await call(client, "proctor_get_certificate", { cert_id: 99 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("no certificate with id 99");
  });

  it("reports a registry outage as an error, never as a verdict", async () => {
    const client = await connect({ agents: [marketAgent()], registryDown: true });
    const result = await call(client, "proctor_vet_market_agent", { handle: "dailybriefer" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("NEAR RPC unreachable");
  });

  it("rejects malformed arguments", async () => {
    const client = await connect({});
    const result = await call(client, "proctor_check_candidate", { candidate: "" });
    expect(result.isError).toBe(true);
  });
});
