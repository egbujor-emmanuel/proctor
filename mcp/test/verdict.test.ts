import { describe, expect, it } from "vitest";

import { agentCandidateId, certState, checkExam, countedExams, decide, marketCandidate, untrustedReason } from "../src/verdict.js";
import { certificate, marketAgent } from "./fixtures.js";

const suspended = { Suspended: { reason: "re-test scored 2000 bps", at_ns: 1 } };
const revoked = { Revoked: { reason: "second failed re-test", at_ns: 2 } };

describe("certState", () => {
  it("reads each registry status", () => {
    expect(certState(null)).toBe("none");
    expect(certState(certificate())).toBe("active");
    expect(certState(certificate({ status: suspended }))).toBe("suspended");
    expect(certState(certificate({ status: revoked }))).toBe("revoked");
  });
});

describe("trusted exams", () => {
  const base = { exam_id: "e", author: "attrito.testnet", pass_mark_bps: 6000, question_count: 5, active: true };

  it("counts only real tests by trusted authors", () => {
    expect(untrustedReason(base)).toBeNull();
    expect(untrustedReason({ ...base, author: "mallory.testnet" })).toContain("not on the trusted list");
    expect(untrustedReason({ ...base, question_count: 1 })).toContain("fewer than 5");
    expect(untrustedReason({ ...base, pass_mark_bps: 0 })).toContain("pass mark is below 50%");
    expect(untrustedReason({ ...base, active: false })).toContain("closed");
    expect(untrustedReason({ ...base, author: "mallory.testnet" }, ["mallory.testnet"])).toBeNull();
    expect(countedExams([base, { ...base, exam_id: "x", author: "m.testnet" }]).map((e) => e.exam_id)).toEqual(["e"]);
  });
});

describe("decide", () => {
  it("hires only with a live certificate", () => {
    const verdict = decide("m", [checkExam("near-basics-v1", certificate())]);
    expect(verdict.decision).toBe("hire");
    expect(verdict.reasons[0]).toContain("certified on near-basics-v1");
    expect(verdict.reasons[0]).toContain("4/5 (80.00%)");
    expect(verdict.reasons[0]).toContain("2 surprise re-test(s) passed");
  });

  it("states the last verification as a readable UTC time", () => {
    const verdict = decide("m", [checkExam("near-basics-v1", certificate())]);
    expect(verdict.reasons[0]).toMatch(/last verified \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/);
    expect(verdict.reasons[0]).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("says plainly when a hire sits beside a revoked or suspended certificate on another exam", () => {
    const verdict = decide("m", [checkExam("demo-v1", certificate({ status: revoked })), checkExam("pool-v1", certificate())]);
    expect(verdict.decision).toBe("hire");
    expect(verdict.reasons.join(" ")).toContain("caution: hire rests on the live certificate on pool-v1; the certificate on demo-v1 is revoked");
  });

  it.each([
    ["none", null, "holds no PROCTOR certificate"],
    ["suspended", certificate({ status: suspended }), "suspended until it passes again"],
    ["revoked", certificate({ status: revoked }), "was revoked"],
  ])("does not hire a candidate whose certificate is %s", (_state, cert, reason) => {
    const verdict = decide("m", [checkExam("near-basics-v1", cert)]);
    expect(verdict.decision).toBe("do_not_hire");
    expect(verdict.reasons[0]).toContain(reason);
  });

  it("carries the suspension reason in the certificate summary", () => {
    const check = checkExam("near-basics-v1", certificate({ status: suspended }));
    expect(check.certificate?.reason).toBe("re-test scored 2000 bps");
  });

  it("does not hire when no exam was checked", () => {
    expect(decide("m", []).decision).toBe("do_not_hire");
  });

  it("never lets a strong market record override a missing certificate", () => {
    const busy = marketAgent({ delivered_jobs: 9_000, success_rate: 100 });
    const verdict = decide("agent:busy.testnet/busy", [checkExam("near-basics-v1", null)], busy);
    expect(verdict.decision).toBe("do_not_hire");
    expect(verdict.market).toMatchObject({ delivered_jobs: 9_000, success_rate: 100, builder_verification: "identity_verified" });
  });

  it("hires when any checked exam holds a live certificate", () => {
    const verdict = decide("m", [checkExam("a", null), checkExam("b", certificate({ exam_id: "b" }))]);
    expect(verdict.decision).toBe("hire");
  });
});

describe("agent and market candidate ids", () => {
  it("names agents after the account that registers them, like the registry", () => {
    expect(agentCandidateId("alice.testnet", "bot")).toBe("agent:alice.testnet/bot");
  });

  it("binds a listing to the account it names in a tag, its description or its bio", () => {
    const want = { id: "agent:alice.testnet/dailybriefer", account: "alice.testnet" };
    expect(marketCandidate(marketAgent({ description: null, tags: ["news", "proctor:alice.testnet"] }))).toEqual(want);
    expect(marketCandidate(marketAgent({ description: "Certified (proctor:alice.testnet)." }))).toEqual(want);
    expect(marketCandidate(marketAgent({ description: null, bio_markdown: "**PROCTOR:alice.testnet**" }))).toEqual(want);
  });

  it.each([
    ["no declaration", { description: "Gathers news" }, "does not name"],
    ["two different accounts", { description: "proctor:alice.testnet", tags: ["proctor:bob.near"] }, "more than one"],
    ["an invalid account", { description: "proctor:Alice..testnet" }, "does not name"],
    ["a prefix glued to another word", { description: "notproctor:alice.testnet" }, "does not name"],
    ["a handle the registry cannot use as a name", { handle: "x".repeat(49), description: "proctor:alice.testnet" }, "cannot be a PROCTOR agent name"],
  ])("refuses %s", (_label, overrides, message) => {
    const result = marketCandidate(marketAgent(overrides));
    expect(result).toEqual({ error: expect.stringContaining(message) });
  });

  it("counts the same account named twice as one", () => {
    expect(marketCandidate(marketAgent({ description: "proctor:alice.testnet", tags: ["proctor:alice.testnet"] }))).toHaveProperty("id");
  });
});

describe("summary times", () => {
  it("reads real nanosecond timestamps and never throws on an out-of-range one", () => {
    const real = checkExam("e", certificate({ last_verified_ns: 1793533263771828645 }));
    expect(real.certificate?.last_verified).toBe("2026-11-01T11:41:03.771Z");
    const broken = checkExam("e", certificate({ last_verified_ns: 1e30 }));
    expect(broken.certificate?.last_verified).toBe("unknown");
  });
});

describe("certificate freshness", () => {
  const DAY_NS = 24 * 60 * 60 * 1e9;
  const now = Date.UTC(2026, 10, 2);

  it("counts an Active certificate not verified in over 7 days as stale, and does not hire", () => {
    const old = certificate({ last_verified_ns: (now / 1000 - 8 * 24 * 3600) * 1e9 });
    const check = checkExam("e", old, now);
    expect(check.state).toBe("stale");
    expect(check.certificate?.reason).toBe("last verified 8 days ago");
    expect(decide("m", [check]).decision).toBe("do_not_hire");
  });

  it("keeps a recently verified certificate live", () => {
    const fresh = certificate({ last_verified_ns: now * 1e6 - DAY_NS });
    expect(checkExam("e", fresh, now).state).toBe("active");
  });

  it("does not let staleness hide a suspension or revocation", () => {
    const status = { Revoked: { reason: "r", at_ns: 1 } };
    expect(checkExam("e", certificate({ status, last_verified_ns: 1 }), now).state).toBe("revoked");
  });
});

describe("declaration parsing edge cases", () => {
  it("accepts a declaration that ends a sentence but not a longer name", () => {
    expect(marketCandidate(marketAgent({ description: "Certified by proctor:alice.testnet." }))).toHaveProperty("id", "agent:alice.testnet/dailybriefer");
    expect(marketCandidate(marketAgent({ description: "proctor:alice.testnet.evil.com" }))).toHaveProperty("error");
  });
});
