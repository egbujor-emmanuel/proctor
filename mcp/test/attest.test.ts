import { describe, expect, it } from "vitest";
import { p384 } from "@noble/curves/nist.js";
import { sha384 } from "@noble/hashes/sha2.js";

import { checkHardware, expectedReportData, type AttestDeps, type TeeAttestation } from "../src/attest.js";

const NONCE = "ab".repeat(32);
const ADDRESS = "0xb98a789cdc4817275f5155593ba73ef2a957e779";
const MRTD = "11".repeat(48);
const RTMR3 = "22".repeat(48);

// A P-384 key standing in for NVIDIA's NRAS signing key.
const nrasSecret = p384.utils.randomSecretKey();
const nrasPublic = p384.getPublicKey(nrasSecret, false);
const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const jwks = { keys: [{ kid: "nras-test", crv: "P-384", x: b64(nrasPublic.slice(1, 49)), y: b64(nrasPublic.slice(49)) }] };

function jwt(claims: Record<string, unknown>, secret = nrasSecret, kid = "nras-test"): string {
  const head = b64(JSON.stringify({ alg: "ES384", kid }));
  const body = b64(JSON.stringify(claims));
  const sig = p384.sign(sha384(new TextEncoder().encode(`${head}.${body}`)), secret, { prehash: false, lowS: false });
  return `${head}.${body}.${b64(sig)}`;
}

const goodGpu = { secboot: true, dbgstat: "disabled", measres: "success", "x-nvidia-gpu-attestation-report-nonce-match": true, eat_nonce: NONCE };

function attestation(overrides: Partial<TeeAttestation> = {}): TeeAttestation {
  return {
    signing_address: ADDRESS,
    intel_quote: "00",
    report_data: expectedReportData(ADDRESS, NONCE),
    request_nonce: NONCE,
    info: { tcb_info: { mrtd: MRTD, rtmr3: RTMR3 } },
    ...overrides,
  };
}

function deps(o: { status?: string; reportData?: string; debug?: boolean; overall?: Record<string, unknown>; gpu?: Record<string, unknown>; secret?: typeof nrasSecret } = {}): AttestDeps {
  return {
    verifyQuote: async () => ({
      status: o.status ?? "UpToDate",
      report: {
        reportData: Buffer.from(o.reportData ?? expectedReportData(ADDRESS, NONCE), "hex"),
        tdAttributes: Uint8Array.from([o.debug ? 1 : 0, 0, 0, 0, 0, 0, 0, 0]),
        mrTd: Buffer.from(MRTD, "hex"),
        rtMr3: Buffer.from(RTMR3, "hex"),
      },
    }),
    nras: async () => [
      ["JWT", jwt({ "x-nvidia-overall-att-result": true, eat_nonce: NONCE, ...o.overall }, o.secret)],
      { "GPU-0": jwt({ ...goodGpu, ...o.gpu }, o.secret), "GPU-1": jwt(goodGpu, o.secret) },
    ],
    nrasKeys: async () => jwks,
    now: () => 1_800_000_000_000,
  };
}

const failed = (h: Awaited<ReturnType<typeof checkHardware>>) => h.checks.filter((c) => !c.ok).map((c) => c.name);

describe("hardware attestation", () => {
  it("passes a gateway whose quote binds its key and our nonce", async () => {
    const h = await checkHardware("gateway", attestation(), NONCE, deps());
    expect(h.ok).toBe(true);
    expect(h.tcbStatus).toBe("UpToDate");
    expect(h.checks.map((c) => c.name)).toEqual([
      "Intel TDX quote verifies against Intel's PCS",
      "enclave is not in debug mode",
      "quote binds the signing key and our nonce",
      "measured software matches the reported configuration",
    ]);
  });

  it("passes a model TEE with GPU evidence, even though it omits report_data", async () => {
    const h = await checkHardware("model", attestation({ report_data: undefined, nvidia_payload: "{}" }), NONCE, deps());
    expect(h.ok).toBe(true);
    expect(h.checks.at(-1)?.detail).toContain("2 GPU(s)");
  });

  it("fails an out-of-date TCB", async () => {
    const h = await checkHardware("gateway", attestation(), NONCE, deps({ status: "OutOfDate" }));
    expect(failed(h)).toEqual(["Intel TDX quote verifies against Intel's PCS"]);
  });

  it("fails a debuggable enclave", async () => {
    const h = await checkHardware("gateway", attestation(), NONCE, deps({ debug: true }));
    expect(failed(h)).toEqual(["enclave is not in debug mode"]);
  });

  it("fails a quote made for another nonce (a replayed report)", async () => {
    const h = await checkHardware("gateway", attestation(), NONCE, deps({ reportData: expectedReportData(ADDRESS, "cd".repeat(32)) }));
    expect(failed(h)).toEqual(["quote binds the signing key and our nonce"]);
  });

  it("fails GPU tokens not signed by NVIDIA", async () => {
    const h = await checkHardware("model", attestation({ nvidia_payload: "{}" }), NONCE, deps({ secret: p384.utils.randomSecretKey() }));
    expect(failed(h)).toEqual(["NVIDIA GPU attestation (NRAS)"]);
    expect(h.checks.at(-1)?.detail).toBe("NRAS token signature is invalid");
  });

  it("fails a GPU verdict for another nonce", async () => {
    const h = await checkHardware("model", attestation({ nvidia_payload: "{}" }), NONCE, deps({ overall: { eat_nonce: "00".repeat(32) } }));
    expect(h.checks.at(-1)?.detail).toBe("NRAS verdict is for a different nonce");
  });

  it("fails when any GPU runs in debug mode", async () => {
    const h = await checkHardware("model", attestation({ nvidia_payload: "{}" }), NONCE, deps({ gpu: { dbgstat: "enabled" } }));
    expect(h.ok).toBe(false);
    expect(h.checks.at(-1)?.detail).toContain("secure boot, debug or measurement");
  });

  it("lays out report_data as the padded address followed by the nonce", () => {
    expect(expectedReportData("0xABC", "ff")).toBe("abc".padEnd(64, "0") + "ff");
  });
});
