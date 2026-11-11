import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { patrolledExams, tick, type Env, type Send } from "../src/index";
import { outcomeFromLogs, plan } from "../src/plan";
import type { Certificate } from "../src/registry";

const NOW = 1_793_590_000_000_000_000n;
const HOUR = 3_600n * 1_000_000_000n;
const cert = (id: number, extra: Partial<Certificate> = {}): Certificate => ({
  cert_id: id,
  candidate_model: `m${id}`,
  exam_id: "e",
  status: "Active",
  retest_in_flight: null,
  last_retest_requested_ns: null,
  ...extra,
});
const ENV: Env = { REGISTRY: "registry-v2.attrito.testnet", SENTINEL_ACCOUNT: "proctor-sentinel.testnet", RPC_URL: "https://rpc.example", CHANCE: "0.2" };
const resolved = (outcome: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "proctor", event: "sitting_resolved", data: [{ sitting_id: 9, outcome }] })}`;

describe("plan", () => {
  it("re-tests only when the roll falls under the chance", () => {
    expect(plan([cert(0)], new Map(), NOW, 0.2, 0.5, () => 0)).toMatchObject({ expire: [], skip: expect.stringContaining("probability 0.2") });
    expect(plan([cert(0)], new Map(), NOW, 0.2, 0.1, () => 0)).toEqual({ expire: [], retest: { cert_id: 0, candidate: "m0", why: "drawn" } });
  });

  it("expires stuck re-tests on every tick, even when it does not re-test", () => {
    const stuck = cert(1, { retest_in_flight: 7 });
    const p = plan([cert(0), stuck], new Map([[7, String(NOW - 2n * HOUR)]]), NOW, 0.2, 0.9, () => 0);
    expect(p.expire).toEqual([7]);
    expect(p.retest).toBeUndefined();
  });

  it("skips revoked certificates and the one-hour gap", () => {
    const revoked = cert(0, { status: { Revoked: { reason: "r", at_ns: 1 } } });
    const recent = cert(1, { last_retest_requested_ns: String(NOW - HOUR / 2n) });
    expect(plan([revoked, recent], new Map(), NOW, 1, 0, () => 0).skip).toContain("nothing eligible");
  });

  it("re-tests the live certificate verified longest ago once it is overdue, whatever the roll", () => {
    const days = (n: bigint) => String(NOW - n * 24n * HOUR);
    const fresh = cert(0, { last_verified_ns: days(1n) });
    const older = cert(1, { last_verified_ns: days(6n) });
    const oldest = cert(2, { last_verified_ns: days(9n) });
    expect(plan([fresh, older, oldest], new Map(), NOW, 0.2, 0.99, () => 0).retest).toEqual({ cert_id: 2, candidate: "m2", why: "overdue" });
  });

  it("leaves overdue certificates that are suspended, revoked or re-tested within the hour to the usual rules", () => {
    const old = String(NOW - 9n * 24n * HOUR);
    const suspended = cert(0, { status: { Suspended: { reason: "r", at_ns: 1 } }, last_verified_ns: old });
    const revoked = cert(1, { status: { Revoked: { reason: "r", at_ns: 1 } }, last_verified_ns: old });
    const cooling = cert(2, { last_verified_ns: old, last_retest_requested_ns: String(NOW - HOUR / 2n) });
    const fresh = cert(3, { last_verified_ns: String(NOW - HOUR) });
    expect(plan([suspended, revoked, cooling, fresh], new Map(), NOW, 0.2, 0.99, () => 0).skip).toContain("probability");
  });

  it("counts only patrolled exams as overdue", () => {
    const old = { ...cert(1, { last_verified_ns: String(NOW - 9n * 24n * HOUR) }), exam_id: "throwaway" };
    expect(plan([old, cert(0)], new Map(), NOW, 0.2, 0.99, () => 0, new Set(["e"])).skip).toContain("probability");
  });
});

describe("patrolled exams", () => {
  it("draws only from the exams the sentinel patrols", () => {
    const other = { ...cert(1), exam_id: "throwaway" };
    const p = plan([other, cert(0)], new Map(), NOW, 1, 0, () => 0, new Set([cert(0).exam_id]));
    expect(p.retest?.cert_id).toBe(0);
    expect(plan([other], new Map(), NOW, 1, 0, () => 0, new Set([cert(0).exam_id])).skip).toBe("no certificates yet");
    expect(patrolledExams({ EXAMS: " a, b ,," })).toEqual(new Set(["a", "b"]));
    expect(patrolledExams({})).toBeUndefined();
  });
});

describe("outcomeFromLogs", () => {
  it("reads object and unit outcomes and ignores other logs", () => {
    expect(outcomeFromLogs(["noise", "EVENT_JSON:{bad", resolved({ Suspended: { cert_id: 1, score_bps: 0 } })])).toBe("Suspended");
    expect(outcomeFromLogs([resolved("Expired")])).toBe("Expired");
    expect(outcomeFromLogs(["EVENT_JSON:{\"standard\":\"other\",\"event\":\"sitting_resolved\",\"data\":[{\"outcome\":\"X\"}]}"])).toBeUndefined();
  });
});

/** A fake NEAR RPC: certificates, sittings and the chain clock. */
function chain(certs: Certificate[], sittings: Record<number, { requested_at_ns: string }> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "block") return Response.json({ result: { header: { timestamp_nanosec: String(NOW) } } });
      const { method_name, args_base64 } = body.params;
      const args = JSON.parse(atob(args_base64));
      const value = method_name === "list_certificates" ? (args.from_index === 0 ? certs : []) : (sittings[args.sitting_id] ?? null);
      return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("tick", () => {
  it("re-tests a live certificate and reports the verdict", async () => {
    chain([cert(0)]);
    const send = vi.fn<Send>(async () => ({ tx: "TX1", logs: [resolved({ RetestPassed: { cert_id: 0, score_bps: 6000 } })] }));
    const result = await tick(ENV, send, 0.1, () => 0);
    expect(send).toHaveBeenCalledWith("retest", { cert_id: 0 }, "300", "0.06");
    expect(result).toMatchObject({ action: "retest", cert_id: 0, tx: "TX1", outcome: "RetestPassed" });
  });

  it("fails loudly when a re-test ends without a verdict", async () => {
    chain([cert(0)]);
    const send: Send = async () => ({ tx: "TX2", logs: [resolved({ Incomplete: { failed_calls: 1 } })] });
    await expect(tick(ENV, send, 0.1, () => 0)).rejects.toThrow("without a verdict");
  });

  it("expires a stuck re-test before anything else", async () => {
    chain([cert(0, { retest_in_flight: 4 })], { 4: { requested_at_ns: String(NOW - 2n * HOUR) } });
    const send = vi.fn<Send>(async () => ({ tx: "TX3", logs: [] }));
    const result = await tick(ENV, send, 0.9, () => 0);
    expect(send).toHaveBeenCalledWith("expire_sitting", { sitting_id: 4 }, "30", "0");
    expect(result).toMatchObject({ action: "none", expired: ["4:TX3"] });
  });

  it("does nothing on most hours", async () => {
    chain([cert(0)]);
    const send = vi.fn<Send>();
    expect(await tick(ENV, send, 0.99, () => 0)).toMatchObject({ action: "none" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a nonsensical chance", async () => {
    chain([cert(0)]);
    await expect(tick({ ...ENV, CHANCE: "2" }, vi.fn<Send>())).rejects.toThrow("CHANCE");
  });
});

describe("status page", () => {
  it("says what it does and whether it is armed", async () => {
    const res = await worker.fetch(new Request("https://sentinel.example/"), ENV);
    expect(await res.json()).toMatchObject({ signs_as: "proctor-sentinel.testnet", chance_per_hour: 0.2, armed: false });
  });
});
