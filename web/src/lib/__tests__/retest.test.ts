import { describe, expect, it, vi } from "vitest";

import { describeOutcome, orderRetest } from "../retest";

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("orderRetest", () => {
  it("posts the certificate id to the sentinel and returns the verdict and transaction", async () => {
    const fetcher = reply(200, { cert_id: 11, candidate: "openai/gpt-5.4-mini", tx: "Eokg4Rja", outcome: "Suspended", explorer: "https://testnet.near.rocks/tx/Eokg4Rja" });
    const result = await orderRetest(11, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "https://proctor-sentinel.attrito.workers.dev/retest",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ cert_id: 11 }) }),
    );
    expect(result).toEqual({ ok: true, tx: "Eokg4Rja", outcome: "Suspended" });
  });

  it("passes on the sentinel's reason when it refuses", async () => {
    expect(await orderRetest(1, reply(409, { error: "re-tested less than an hour ago" }))).toEqual({ ok: false, error: "re-tested less than an hour ago" });
  });

  it("explains a network failure in plain words", async () => {
    const result = await orderRetest(1, vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/could not reach the sentinel/i);
  });

  it("refuses a reply that does not have the expected shape", async () => {
    const result = await orderRetest(1, reply(200, { tx: 42 }));
    expect(result.ok).toBe(false);
  });
});

describe("describeOutcome", () => {
  it("says what each outcome did to the certificate", () => {
    expect(describeOutcome("RetestPassed").tone).toBe("active");
    expect(describeOutcome("Suspended").text).toMatch(/suspended/i);
    expect(describeOutcome("Revoked").text).toMatch(/revoked/i);
    expect(describeOutcome("Incomplete").text).toMatch(/nothing changed/i);
    expect(describeOutcome("SomethingNew").tone).toBe("muted");
  });
});
