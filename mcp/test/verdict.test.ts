import { describe, expect, it } from "vitest";

import { certState, checkExam, decide, marketCandidateId } from "../src/verdict.js";
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

describe("decide", () => {
  it("hires only with a live certificate", () => {
    const verdict = decide("m", [checkExam("near-basics-v1", certificate())]);
    expect(verdict.decision).toBe("hire");
    expect(verdict.reasons[0]).toContain("certified on near-basics-v1");
    expect(verdict.reasons[0]).toContain("4/5 (80.00%)");
    expect(verdict.reasons[0]).toContain("2 surprise re-test(s) passed");
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
    const verdict = decide("market:busy", [checkExam("near-basics-v1", null)], busy);
    expect(verdict.decision).toBe("do_not_hire");
    expect(verdict.market).toMatchObject({ delivered_jobs: 9_000, success_rate: 100, builder_verification: "identity_verified" });
  });

  it("hires when any checked exam holds a live certificate", () => {
    const verdict = decide("m", [checkExam("a", null), checkExam("b", certificate({ exam_id: "b" }))]);
    expect(verdict.decision).toBe("hire");
  });
});

describe("marketCandidateId", () => {
  it("prefixes market handles", () => {
    expect(marketCandidateId("dailybriefer")).toBe("market:dailybriefer");
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
