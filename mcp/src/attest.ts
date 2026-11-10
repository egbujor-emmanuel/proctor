// Checks NEAR AI's hardware attestation itself, not just its signing keys:
// each TEE's Intel TDX quote (against Intel's own PCS), the binding of the
// signing key and our fresh nonce into that quote, the measured software, and
// for model TEEs the NVIDIA GPU evidence (NRAS, with NVIDIA's token signature).

import { getCollateralFromPcs, verify as verifyQuote } from "@phala/dcap-qvl";
import { p384 } from "@noble/curves/nist.js";
import { sha384 } from "@noble/hashes/sha2.js";

const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
const NRAS_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
/** TCB levels that are current; anything else (OutOfDate, Revoked, ...) fails. */
const ACCEPTED_TCB = new Set(["UpToDate", "SWHardeningNeeded"]);

/** One TEE's attestation, as NEAR AI's /v1/attestation/report returns it. */
export interface TeeAttestation {
  signing_address: string;
  intel_quote: string;
  /** Present for the gateway; model TEEs omit it (the quote carries it). */
  report_data?: string;
  request_nonce: string;
  nvidia_payload?: string;
  info?: { tcb_info?: { mrtd?: string; rtmr3?: string } };
}

export interface HardwareCheck {
  tee: string;
  ok: boolean;
  tcbStatus?: string;
  /** Each check that ran, and whether it passed. */
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** What attestation needs from the outside world; replaced in tests. */
export interface AttestDeps {
  /** Verifies a TDX quote with collateral from Intel's PCS; returns its status and report body. */
  verifyQuote: (quote: Uint8Array, nowSeconds: number) => Promise<{ status: string; report: Record<string, Uint8Array> }>;
  /** Posts GPU evidence to NVIDIA NRAS; returns its token list. */
  nras: (payload: string) => Promise<unknown>;
  /** NVIDIA's NRAS signing keys (JWKS). */
  nrasKeys: () => Promise<{ keys: { kid: string; x: string; y: string; crv?: string }[] }>;
  now: () => number;
}

/** NVIDIA's and Intel's services are sometimes slow; a network error, timeout or 5xx is tried once more. */
async function fetchWithRetry(url: string, init: Omit<RequestInit, "signal">, timeoutMs: number): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500 || attempt === 2) return res;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export const liveDeps: AttestDeps = {
  verifyQuote: async (quote, nowSeconds) => {
    const collateral = await getCollateralFromPcs(quote).catch(() => getCollateralFromPcs(quote));
    const result = verifyQuote(quote, collateral, nowSeconds);
    // A TDX report body (TD10/TD15); the fields read here are byte arrays.
    return { status: result.status, report: result.report.data as unknown as Record<string, Uint8Array> };
  },
  nras: async (payload) => {
    const res = await fetchWithRetry(NRAS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: payload }, 60_000);
    if (!res.ok) throw new Error(`NRAS answered HTTP ${res.status}`);
    return res.json();
  },
  nrasKeys: async () => {
    const res = await fetchWithRetry(NRAS_JWKS_URL, {}, 30_000);
    if (!res.ok) throw new Error(`NRAS keys: HTTP ${res.status}`);
    return res.json() as Promise<{ keys: { kid: string; x: string; y: string }[] }>;
  },
  now: () => Date.now(),
};

const hex = (bytes: Uint8Array | undefined) => (bytes ? Buffer.from(bytes).toString("hex") : "");
const strip0x = (s: string) => s.toLowerCase().replace(/^0x/, "");

/** NEAR AI's report_data: the signing address, zero-padded to 32 bytes, then the 32-byte nonce. */
export function expectedReportData(signingAddress: string, nonce: string): string {
  return strip0x(signingAddress).padEnd(64, "0") + nonce.toLowerCase();
}

/** Verifies an ES384 JWT against NRAS's keys; returns its claims. */
async function verifiedClaims(token: string, deps: AttestDeps): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed NRAS token");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { kid?: string; alg?: string };
  if (header.alg !== "ES384") throw new Error(`unexpected NRAS token algorithm ${header.alg}`);
  const jwk = (await deps.nrasKeys()).keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("NRAS token signed by an unknown key");
  const publicKey = Uint8Array.from([4, ...Buffer.from(jwk.x, "base64url"), ...Buffer.from(jwk.y, "base64url")]);
  const digest = sha384(new TextEncoder().encode(`${h}.${p}`));
  // JWS signers do not normalise S, so high-S signatures are valid here.
  if (!p384.verify(Uint8Array.from(Buffer.from(s, "base64url")), digest, publicKey, { prehash: false, lowS: false })) {
    throw new Error("NRAS token signature is invalid");
  }
  return JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
}

/** NRAS's verdict on the GPU evidence: overall result, nonce, and every GPU booted securely without debug. */
async function checkGpu(att: TeeAttestation, deps: AttestDeps): Promise<{ ok: boolean; detail: string }> {
  const tokens = (await deps.nras(att.nvidia_payload!)) as [[string, string], Record<string, string>];
  const overall = await verifiedClaims(tokens[0][1], deps);
  if (overall["x-nvidia-overall-att-result"] !== true) return { ok: false, detail: "NRAS overall result is not true" };
  if (overall.eat_nonce !== att.request_nonce) return { ok: false, detail: "NRAS verdict is for a different nonce" };
  const gpus = Object.values(tokens[1] ?? {});
  for (const token of gpus) {
    const c = await verifiedClaims(token, deps);
    if (c.secboot !== true || c.dbgstat !== "disabled" || c.measres !== "success" || c["x-nvidia-gpu-attestation-report-nonce-match"] !== true) {
      return { ok: false, detail: "a GPU failed secure boot, debug or measurement checks" };
    }
  }
  return { ok: true, detail: `${gpus.length} GPU(s): secure boot on, debug off, measurements match` };
}

/** Runs every hardware check on one TEE's attestation. `nonce` is the one we sent. */
export async function checkHardware(tee: string, att: TeeAttestation, nonce: string, deps: AttestDeps = liveDeps): Promise<HardwareCheck> {
  const checks: HardwareCheck["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  let tcbStatus: string | undefined;
  try {
    const { status, report } = await deps.verifyQuote(Buffer.from(att.intel_quote, "hex"), Math.floor(deps.now() / 1000));
    tcbStatus = status;
    add("Intel TDX quote verifies against Intel's PCS", ACCEPTED_TCB.has(status), `TCB ${status}`);
    // TD attributes bit 0 is DEBUG: a debuggable enclave can be read by its host.
    add("enclave is not in debug mode", ((report.tdAttributes?.[0] ?? 1) & 1) === 0);
    const reportData = hex(report.reportData);
    // Model TEEs omit the report_data field; the quote itself is what binds.
    const fieldMatches = att.report_data === undefined || reportData === att.report_data;
    add("quote binds the signing key and our nonce", fieldMatches && reportData === expectedReportData(att.signing_address, nonce));
    const tcb = att.info?.tcb_info;
    if (tcb?.mrtd && tcb.rtmr3) {
      add("measured software matches the reported configuration", hex(report.mrTd) === tcb.mrtd && hex(report.rtMr3) === tcb.rtmr3);
    }
  } catch (e) {
    add("Intel TDX quote verifies against Intel's PCS", false, e instanceof Error ? e.message : String(e));
  }
  if (att.nvidia_payload) {
    try {
      const gpu = await checkGpu(att, deps);
      add("NVIDIA GPU attestation (NRAS)", gpu.ok, gpu.detail);
    } catch (e) {
      add("NVIDIA GPU attestation (NRAS)", false, e instanceof Error ? e.message : String(e));
    }
  }
  return { tee, ok: checks.length > 0 && checks.every((c) => c.ok), ...(tcbStatus ? { tcbStatus } : {}), checks };
}
