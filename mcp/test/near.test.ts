import { describe, expect, it, vi } from "vitest";

import { createRegistryReader, RegistryError } from "../src/near.js";
import { certificate, exam, rpcResult } from "./fixtures.js";

const RPC = "https://rpc.example";

function reader(fetchImpl: typeof fetch) {
  return createRegistryReader({ rpcUrl: RPC, contractId: "registry-v2.attrito.testnet", fetch: fetchImpl });
}

describe("createRegistryReader", () => {
  it("sends a read-only call_function query with base64 JSON args", async () => {
    const fetchMock = vi.fn(async () => rpcResult(certificate()));
    await reader(fetchMock as unknown as typeof fetch).latestCertificate("market:x", "near-basics-v1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(RPC);
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe("query");
    expect(body.params).toMatchObject({
      request_type: "call_function",
      finality: "final",
      account_id: "registry-v2.attrito.testnet",
      method_name: "latest_certificate",
    });
    expect(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString())).toEqual({
      candidate_model: "market:x",
      exam_id: "near-basics-v1",
    });
  });

  it("decodes certificates and nulls", async () => {
    const found = await reader((async () => rpcResult(certificate())) as unknown as typeof fetch).getCertificate(0);
    expect(found?.cert_id).toBe(0);
    const missing = await reader((async () => rpcResult(null)) as unknown as typeof fetch).getCertificate(9);
    expect(missing).toBeNull();
  });

  it("pages through every exam", async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => exam({ exam_id: `e${i}` })), [exam({ exam_id: "last" })]];
    const fetchMock = vi.fn(async () => rpcResult(pages.shift()));
    const exams = await reader(fetchMock as unknown as typeof fetch).listExams();
    expect(exams).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an RPC error instead of a wrong answer", async () => {
    const failing = (async () => Response.json({ jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR" } })) as unknown as typeof fetch;
    await expect(reader(failing).getCertificate(0)).rejects.toThrow(RegistryError);
  });

  it("rejects a result that is not a certificate", async () => {
    const odd = (async () => rpcResult({ hello: "world" })) as unknown as typeof fetch;
    await expect(reader(odd).getCertificate(0)).rejects.toThrow("unexpected shape for get_certificate");
  });

  it("reports HTTP failures and unreachable endpoints", async () => {
    const http500 = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch;
    await expect(reader(http500).getCertificate(0)).rejects.toThrow("HTTP 500");
    const offline = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(reader(offline).getCertificate(0)).rejects.toThrow("NEAR RPC unreachable");
  });
});
