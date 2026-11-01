import { describe, expect, it, vi } from "vitest";

import { candidateId, runCheck } from "../check";
import { registry, RegistryError, type Certificate, type Exam } from "../registry";

/** A NEAR RPC view-call response carrying `value` as JSON bytes. */
function rpc(value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "x", result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
}

const exam = (id: string, active = true): Exam => ({
  exam_id: id, author: "a.testnet", title: id, commitment: "c".repeat(64), pass_mark_bps: 6000, question_count: 5, active, sittings: 1,
});

const cert = (overrides: Partial<Certificate> = {}): Certificate => ({
  cert_id: 0, exam_id: "e1", exam_commitment: "c".repeat(64), candidate_model: "m", runner_hash: "r".repeat(64),
  score_bps: 6000, correct: 3, total: 5, issued_at_ns: 1, last_verified_ns: 1, retests_passed: 0, status: "Active",
  requested_by: "a.testnet", sitting_id: 2, response_ids_hash: "h".repeat(64), response_count: 5, ...overrides,
});

describe("candidateId", () => {
  it("uses model ids as they are and prefixes market handles", () => {
    expect(candidateId({ kind: "model", value: " deepseek-ai/DeepSeek-V4.1-Flash-1017 " })).toEqual({ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    expect(candidateId({ kind: "market", value: "dailybriefer" })).toEqual({ id: "market:dailybriefer" });
    expect(candidateId({ kind: "market", value: "market:dailybriefer" })).toEqual({ id: "market:dailybriefer" });
  });

  it("rejects empty input and characters the registry would refuse", () => {
    expect(candidateId({ kind: "model", value: "  " })).toHaveProperty("error");
    expect(candidateId({ kind: "model", value: "a b" })).toHaveProperty("error");
    expect(candidateId({ kind: "model", value: "a|b" })).toHaveProperty("error");
  });
});

describe("registry view calls", () => {
  it("sends a keyless call_function query and decodes the result", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => rpc(cert()));
    const found = await registry.latest("m", "e1", fetchMock as unknown as typeof fetch);
    expect(found?.cert_id).toBe(0);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.params).toMatchObject({ request_type: "call_function", method_name: "latest_certificate", account_id: "registry.attrito.testnet" });
    expect(JSON.parse(atob(body.params.args_base64))).toEqual({ candidate_model: "m", exam_id: "e1" });
  });

  it("reports failures instead of showing a guess", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(registry.config(down)).rejects.toThrow(RegistryError);
    const odd = (async () => rpc({ hello: "world" })) as unknown as typeof fetch;
    await expect(registry.latest("m", "e1", odd)).rejects.toThrow("unexpected latest_certificate result");
  });
});

describe("real registry data", () => {
  it("accepts real nanosecond timestamps, which are above 2^53", async () => {
    const real = cert({ issued_at_ns: 1793533263771828645, last_verified_ns: 1793533263771828645 });
    const found = await registry.latest("m", "e1", (async () => rpc(real)) as unknown as typeof fetch);
    expect(found?.issued_at_ns).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("pages through lists longer than the contract's 100-row page", async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => exam(`e${i}`)), [exam("last")]];
    const fetchMock = vi.fn<typeof fetch>(async () => rpc(pages.shift()));
    const listing = await registry.exams(fetchMock);
    expect(listing.rows).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips and counts a malformed row instead of blanking the list", async () => {
    const listing = await registry.certificates((async () => rpc([cert(), { bogus: true }])) as unknown as typeof fetch);
    expect(listing.rows).toHaveLength(1);
    expect(listing.skipped).toBe(1);
  });

  it("reports a contract error with its reason", async () => {
    const failing = (async () => Response.json({ jsonrpc: "2.0", id: "x", result: { error: "wasm execution failed" } })) as unknown as typeof fetch;
    await expect(registry.config(failing)).rejects.toThrow("wasm execution failed");
  });
});

describe("runCheck", () => {
  it("checks only active exams and hires on a live certificate", async () => {
    const fetchMock = vi.fn(async () => rpc(cert()));
    const verdict = await runCheck("m", [exam("e1"), exam("old", false)], fetchMock as unknown as typeof fetch);
    expect(verdict.decision).toBe("hire");
    expect(verdict.exams.map((e) => e.exam_id)).toEqual(["e1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not hire a suspended or uncertified candidate", async () => {
    const suspended = cert({ status: { Suspended: { reason: "re-test failed", at_ns: 2 } } });
    expect((await runCheck("m", [exam("e1")], (async () => rpc(suspended)) as unknown as typeof fetch)).decision).toBe("do_not_hire");
    expect((await runCheck("m", [exam("e1")], (async () => rpc(null)) as unknown as typeof fetch)).decision).toBe("do_not_hire");
  });
});
