import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { type Env, type Send } from "../src/index";
import { DAILY_CAP, memoryQuota, retestOnRequest } from "../src/ondemand";
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
const ENV: Env = {
  REGISTRY: "registry-v2.attrito.testnet",
  SENTINEL_ACCOUNT: "proctor-sentinel.testnet",
  RPC_URL: "https://rpc.example",
  CHANCE: "0.2",
  EXAMS: "e",
  ALLOWED_ORIGINS: "https://proctor.attrito.workers.dev",
};
const resolved = (outcome: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "proctor", event: "sitting_resolved", data: [{ sitting_id: 9, outcome }] })}`;

function chain(certs: Certificate[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "block") return Response.json({ result: { header: { timestamp_nanosec: String(NOW) } } });
      const args = JSON.parse(atob(body.params.args_base64));
      const value = args.from_index === 0 ? certs : [];
      return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("a re-test ordered from the website", () => {
  it("re-tests a live certificate and reports the verdict and transaction", async () => {
    chain([cert(3)]);
    const send = vi.fn<Send>(async () => ({ tx: "TX9", logs: [resolved({ Suspended: { cert_id: 3, score_bps: 2000 } })] }));
    const res = await retestOnRequest(3, ENV, send, memoryQuota());
    expect(send).toHaveBeenCalledWith("retest", { cert_id: 3 }, "300", "0.06");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cert_id: 3, tx: "TX9", outcome: "Suspended" });
  });

  it("refuses a certificate that was re-tested less than an hour ago, without sending anything", async () => {
    chain([cert(3, { last_retest_requested_ns: String(NOW - HOUR / 2n) })]);
    const send = vi.fn<Send>();
    const res = await retestOnRequest(3, ENV, send, memoryQuota());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("less than an hour ago");
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a revoked certificate", async () => {
    chain([cert(1, { status: { Revoked: { reason: "x" } } })]);
    const res = await retestOnRequest(1, ENV, vi.fn<Send>(), memoryQuota());
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("revoked");
  });

  it("refuses certificates on exams the sentinel does not patrol", async () => {
    chain([cert(5, { exam_id: "throwaway" })]);
    const res = await retestOnRequest(5, ENV, vi.fn<Send>(), memoryQuota());
    expect(res.status).toBe(404);
  });

  it("refuses an id that is not a certificate number", async () => {
    const res = await retestOnRequest(Number.NaN, ENV, vi.fn<Send>(), memoryQuota());
    expect(res.status).toBe(400);
  });

  it("stops at the daily cap so nobody can drain the sentinel's account", async () => {
    chain([cert(3)]);
    const quota = memoryQuota();
    for (let i = 0; i < DAILY_CAP; i++) await quota.add(NOW);
    const send = vi.fn<Send>();
    const res = await retestOnRequest(3, ENV, send, quota);
    expect(res.status).toBe(429);
    expect(send).not.toHaveBeenCalled();
  });

  it("counts a re-test against the cap only once it is sent", async () => {
    chain([cert(3)]);
    const quota = memoryQuota();
    await retestOnRequest(3, ENV, async () => ({ tx: "T", logs: [resolved({ RetestPassed: { cert_id: 3, score_bps: 8000 } })] }), quota);
    expect(await quota.used(NOW)).toBe(1);
  });

  it("reports a run that ended without a verdict as incomplete, not as an error", async () => {
    chain([cert(3)]);
    const res = await retestOnRequest(3, ENV, async () => ({ tx: "T2", logs: [resolved({ Incomplete: { failed_calls: 1 } })] }), memoryQuota());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: "Incomplete", tx: "T2" });
  });
});

describe("the /retest endpoint", () => {
  it("answers the browser's preflight for the website only", async () => {
    const ok = await worker.fetch(new Request("https://s.example/retest", { method: "OPTIONS", headers: { origin: "https://proctor.attrito.workers.dev" } }), ENV);
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://proctor.attrito.workers.dev");
    const other = await worker.fetch(new Request("https://s.example/retest", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), ENV);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("is refused when the sentinel holds no key", async () => {
    const res = await worker.fetch(
      new Request("https://s.example/retest", { method: "POST", body: JSON.stringify({ cert_id: 3 }), headers: { origin: "https://proctor.attrito.workers.dev" } }),
      ENV,
    );
    expect(res.status).toBe(503);
  });

  it("rejects a body that is not JSON with a certificate id", async () => {
    const res = await worker.fetch(new Request("https://s.example/retest", { method: "POST", body: "nope" }), { ...ENV, SENTINEL_PRIVATE_KEY: "ed25519:x" });
    expect(res.status).toBe(400);
  });
});
