import { describe, expect, it, vi } from "vitest";

import { candidateId, runCheck, snapshotVerdict } from "../check";
import { RPC_URLS } from "../config";
import { registry, RegistryError, type Certificate, type Exam } from "../registry";

/** Answers on the first RPC node only; the other node is down. */
function primaryOnly(answer: () => Promise<Response>) {
  return vi.fn<typeof fetch>(async (url) => {
    if (url !== RPC_URLS[0]) throw new TypeError("node down (test)");
    return answer();
  });
}

/** A NEAR RPC view-call response carrying `value` as JSON bytes. */
function rpc(value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "x", result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
}

const exam = (id: string, active = true): Exam => ({
  exam_id: id, author: "attrito.testnet", title: id, commitment: "c".repeat(64), pass_mark_bps: 6000, question_count: 5, active, sittings: 1,
});

const cert = (overrides: Partial<Certificate> = {}): Certificate => ({
  cert_id: 0, exam_id: "e1", exam_commitment: "c".repeat(64), candidate_model: "m", runner_hash: "r".repeat(64),
  score_bps: 6000, correct: 3, total: 5, issued_at_ns: 1, last_verified_ns: Date.now() * 1e6, retests_passed: 0, status: "Active",
  requested_by: "a.testnet", sitting_id: 2, response_ids_hash: "h".repeat(64), response_count: 5, ...overrides,
});

describe("candidateId", () => {
  it("uses model ids as they are and builds agent ids the way the registry does", () => {
    expect(candidateId({ kind: "model", value: " deepseek-ai/DeepSeek-V4.1-Flash-1017 " })).toEqual({ id: "deepseek-ai/DeepSeek-V4.1-Flash-1017" });
    expect(candidateId({ kind: "agent", value: "attrito.testnet/demo-agent" })).toEqual({ id: "agent:attrito.testnet/demo-agent" });
    expect(candidateId({ kind: "agent", value: "agent:attrito.testnet/demo-agent" })).toEqual({ id: "agent:attrito.testnet/demo-agent" });
  });

  it("refuses agent ids the registry could never issue", () => {
    expect(candidateId({ kind: "agent", value: "demo-agent" })).toHaveProperty("error");
    expect(candidateId({ kind: "agent", value: "attrito.testnet/a/b" })).toHaveProperty("error");
    expect(candidateId({ kind: "agent", value: `attrito.testnet/${"n".repeat(49)}` })).toHaveProperty("error");
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
    expect(body.params).toMatchObject({ request_type: "call_function", method_name: "latest_certificate", account_id: "registry-v2.attrito.testnet" });
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
    const fetchMock = primaryOnly(async () => rpc(pages.shift()));
    const listing = await registry.exams(fetchMock);
    expect(listing.rows).toHaveLength(101);
    expect(fetchMock.mock.calls.filter(([url]) => url === RPC_URLS[0])).toHaveLength(2);
  });

  it("uses whichever RPC node answers, and fails only when both do", async () => {
    const secondOnly = vi.fn<typeof fetch>(async (url) => {
      if (url === RPC_URLS[0]) return new Response("busy", { status: 503 });
      return rpc({ owner: "o", outlayer_account: "outlayer.testnet", runner_hash: "r", exams: 1, certificates: 2, next_sitting_id: 3 });
    });
    expect((await registry.config(secondOnly)).certificates).toBe(2);
    const bothDown = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(registry.config(bothDown)).rejects.toThrow("HTTP 503");
  });

  it("asks the first RPC node only, and touches the fallbacks only when it fails", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => rpc({ owner: "o", outlayer_account: "outlayer.testnet", runner_hash: "r", exams: 1, certificates: 2, next_sitting_id: 3 }));
    await registry.config(fetchMock);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([RPC_URLS[0]]);
  });

  it("falls through every node in order before giving up", async () => {
    const tried: unknown[] = [];
    const allDown = vi.fn<typeof fetch>(async (url) => {
      tried.push(url);
      throw new TypeError("node down (test)");
    });
    await expect(registry.config(allDown)).rejects.toThrow(/Could not reach NEAR testnet/);
    expect(tried).toEqual([...RPC_URLS]);
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

describe("snapshotVerdict", () => {
  it("answers from the latest known certificate, and only for candidates it has seen", () => {
    const old = cert({ cert_id: 0, status: { Revoked: { reason: "second failed re-test", at_ns: 1 } } });
    const current = cert({ cert_id: 3 });
    const verdict = snapshotVerdict("m", [exam("e1")], [old, current]);
    expect(verdict?.decision).toBe("hire");
    expect(verdict?.exams[0]?.prior_revocations).toBe(1);
    expect(snapshotVerdict("someone-else", [exam("e1")], [old, current])).toBeNull();
  });
});

describe("runCheck", () => {
  it("checks only active exams and hires on a live certificate", async () => {
    const fetchMock = primaryOnly(async () => rpc(cert()));
    const verdict = await runCheck("m", [exam("e1"), exam("old", false)], [], fetchMock);
    expect(verdict.decision).toBe("hire");
    expect(verdict.exams.map((e) => e.exam_id)).toEqual(["e1"]);
    expect(fetchMock.mock.calls.filter(([url]) => url === RPC_URLS[0])).toHaveLength(1);
  });

  it("treats a certificate for another candidate as a failed read, not as no certificate", async () => {
    const other = cert({ candidate_model: "someone-else" });
    await expect(runCheck("m", [exam("e1")], [], (async () => rpc(other)) as unknown as typeof fetch)).rejects.toThrow("different candidate or exam");
  });

  it("does not hire a certificate that has not been verified in over a week", async () => {
    const stale = cert({ last_verified_ns: (Date.now() - 8 * 24 * 3600 * 1000) * 1e6 });
    const verdict = await runCheck("m", [exam("e1")], [], (async () => rpc(stale)) as unknown as typeof fetch);
    expect(verdict.decision).toBe("do_not_hire");
    expect(verdict.exams[0]?.state).toBe("stale");
  });

  it("does not hire a suspended or uncertified candidate", async () => {
    const suspended = cert({ status: { Suspended: { reason: "re-test failed", at_ns: 2 } } });
    expect((await runCheck("m", [exam("e1")], [], (async () => rpc(suspended)) as unknown as typeof fetch)).decision).toBe("do_not_hire");
  });

  it("ignores exams anyone could have written to pass", async () => {
    const junk = { ...exam("easy"), author: "mallory.testnet", question_count: 1, pass_mark_bps: 0 };
    const fetchMock = vi.fn(async () => rpc(cert({ exam_id: "easy" })));
    const verdict = await runCheck("m", [junk], [], fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(verdict.decision).toBe("do_not_hire");
  });

  it("flags a candidate revoked before under the same id", async () => {
    const revoked = cert({ cert_id: 0, status: { Revoked: { reason: "second failed re-test", at_ns: 1 } } });
    const verdict = await runCheck("m", [exam("e1")], [revoked], (async () => rpc(cert({ cert_id: 4 }))) as unknown as typeof fetch);
    expect(verdict.decision).toBe("hire");
    expect(verdict.reasons.join(" ")).toContain("1 earlier certificate(s) under this id were revoked");
    expect((await runCheck("m", [exam("e1")], [], (async () => rpc(null)) as unknown as typeof fetch)).decision).toBe("do_not_hire");
  });
});
