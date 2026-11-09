// Independent check of one PROCTOR sitting, from public data only:
//   1. the sitting's events, read from the NEAR transaction, accepted only from
//      receipts the registry (and, for the runner, OutLayer) itself executed;
//   2. the event cross-checked against the registry's own record of the sitting;
//   3. the certificate's response_ids_hash, recomputed from the event's ids;
//   4. the runner OutLayer ran, against the one on the certificate;
//   5. for every answer, NEAR AI's signature: valid, and from the key NEAR AI's
//      attestation report lists (the model's TEE, or for models at external
//      providers, NEAR AI's gateway TEE). The report's hardware quotes are not
//      re-verified here; NEAR AI's own verifier does that.
// The request/response hashes inside each signature cover the secret exam,
// so they are reported but cannot be recomputed by a third party.

import { createHash } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { checkHardware, type AttestDeps, type HardwareCheck, type TeeAttestation } from "./attest.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { z } from "zod";

import { SittingOutcomeSchema, type SittingOutcome } from "./near.js";

const NEAR_AI = "https://cloud-api.near.ai";
/** Any TEE-hosted model: its report also carries the gateway's attestation. */
export const DEFAULT_ATTESTATION_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

type Fetch = typeof fetch;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The address that signed `text` with Ethereum personal_sign (EIP-191). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`);
  const body = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, "utf8"), body]));
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  const point = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(recovery).recoverPublicKey(digest);
  return `0x${toHex(keccak_256(point.toBytes(false).subarray(1)).subarray(12))}`;
}

/** The registry's hash of a sitting's completion ids (checks.rs response_ids_hash). */
export function responseIdsHash(ids: string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

// ------------------------------------------------------------ chain evidence

const TxStatusSchema = z.object({
  result: z.object({
    transaction: z.object({ receiver_id: z.string() }),
    receipts_outcome: z.array(
      z.object({ outcome: z.object({ executor_id: z.string(), logs: z.array(z.string()), status: z.record(z.string(), z.unknown()) }) }),
    ),
  }),
});

export interface Receipt {
  executor: string;
  logs: string[];
  /** False when the receipt failed: its logs are not evidence of anything. */
  succeeded: boolean;
}

export interface Transaction {
  receiver: string;
  receipts: Receipt[];
}

export async function readTransaction(rpcUrl: string, txHash: string, sender: string, doFetch: Fetch = fetch): Promise<Transaction> {
  const response = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proctor-verify", method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status} for ${txHash}`);
  const body: unknown = await response.json().catch(() => null);
  const parsed = TxStatusSchema.safeParse(body);
  if (!parsed.success) throw new Error(`cannot read transaction ${txHash} sent by ${sender}: ${JSON.stringify((body as { error?: unknown })?.error ?? "unexpected response")}`);
  return {
    receiver: parsed.data.result.transaction.receiver_id,
    receipts: parsed.data.result.receipts_outcome.map(({ outcome }) => ({
      executor: outcome.executor_id,
      logs: outcome.logs,
      succeeded: !("Failure" in outcome.status),
    })),
  };
}

const ResolvedSchema = z.object({
  sitting_id: z.number().int().nonnegative(),
  candidate_model: z.string(),
  exam_id: z.string(),
  outcome: SittingOutcomeSchema,
  response_ids: z.array(z.string()),
});
const ExecutedSchema = z.object({ code_source: z.object({ WasmUrl: z.object({ url: z.string(), hash: z.string() }) }) });

export interface SittingEvents {
  sittingId: number;
  candidate: string;
  examId: string;
  outcome: SittingOutcome;
  responseIds: string[];
  /** The runner OutLayer ran, from its execution_completed event. */
  runnerHash?: string;
  runnerUrl?: string;
}

function events(receipt: Receipt, standard: string, name: string): unknown[] {
  const found: unknown[] = [];
  for (const log of receipt.logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    try {
      const event = JSON.parse(log.slice("EVENT_JSON:".length));
      if (event?.standard === standard && event?.event === name) found.push(event.data?.[0]);
    } catch {
      // Not an event this verifier reads; other contracts may log anything.
    }
  }
  return found;
}

/**
 * The sitting's evidence, taken only from successful receipts executed by the
 * registry (sitting_resolved) and by OutLayer (execution_completed), so no
 * other contract in the transaction can supply it.
 */
export function sittingFromTransaction(tx: Transaction, registry: string, outlayer: string): SittingEvents {
  const ok = tx.receipts.filter((r) => r.succeeded);
  const resolved = ok.filter((r) => r.executor === registry).flatMap((r) => events(r, "proctor", "sitting_resolved"));
  if (resolved.length !== 1) throw new Error(`expected one sitting_resolved event from ${registry}, found ${resolved.length}`);
  const sitting = ResolvedSchema.safeParse(resolved[0]);
  if (!sitting.success) throw new Error("the registry's sitting_resolved event has an unexpected shape");
  const executed = ok.filter((r) => r.executor === outlayer).flatMap((r) => events(r, "near-outlayer", "execution_completed"));
  const runner = executed.length === 1 ? ExecutedSchema.safeParse(executed[0]) : undefined;
  const s = sitting.data;
  return {
    sittingId: s.sitting_id,
    candidate: s.candidate_model,
    examId: s.exam_id,
    outcome: s.outcome,
    responseIds: s.response_ids,
    ...(runner?.success ? { runnerHash: runner.data.code_source.WasmUrl.hash, runnerUrl: runner.data.code_source.WasmUrl.url } : {}),
  };
}

// ------------------------------------------------------- NEAR AI signatures

export interface AnswerCheck {
  id: string;
  ok: boolean;
  kind?: string;
  model?: string;
  signer?: string;
  listed?: string[];
  error?: string;
}

const SignatureSchema = z.object({
  text: z.string(),
  signature: z.string(),
  signing_address: z.string(),
  signing_algo: z.string(),
  signature_kind: z.string().optional(),
});
const ReportSchema = z.object({
  model_attestations: z.array(z.looseObject({ signing_address: z.string().optional() })).optional(),
  gateway_attestation: z.looseObject({ signing_address: z.string().optional() }).optional(),
});

/** One model's attestation report: the listed keys, plus the raw evidence and the nonce we sent. */
export interface Report {
  model: string[];
  gateway?: string;
  nonce: string;
  raw: z.infer<typeof ReportSchema>;
}

/** NEAR AI attestation reports, cached per model; a failed lookup is not cached. */
export class Attestations {
  private cache = new Map<string, Promise<Report>>();
  constructor(
    private apiKey: string,
    private doFetch: Fetch = fetch,
  ) {}

  get(model: string) {
    let entry = this.cache.get(model);
    if (!entry) {
      entry = this.fetchReport(model).catch((error: unknown) => {
        this.cache.delete(model);
        throw error;
      });
      this.cache.set(model, entry);
    }
    return entry;
  }

  private async fetchReport(model: string) {
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const url = `${NEAR_AI}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
    const response = await this.doFetch(url, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(60_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`attestation for ${model}: ${(body as { error?: { message?: string } })?.error?.message ?? `HTTP ${response.status}`}`);
    const report = ReportSchema.safeParse(body);
    if (!report.success) throw new Error(`attestation for ${model} has an unexpected shape`);
    return {
      model: (report.data.model_attestations ?? []).flatMap((a) => (a.signing_address ? [a.signing_address.toLowerCase()] : [])),
      gateway: report.data.gateway_attestation?.signing_address?.toLowerCase(),
      nonce,
      raw: report.data,
    };
  }

  /**
   * Hardware checks on the TEEs behind a model's report: the gateway, and
   * unless `gatewayOnly` the model's own TEE(s). See attest.ts.
   */
  async hardware(model: string, gatewayOnly = false, deps?: AttestDeps): Promise<HardwareCheck[]> {
    const { raw, nonce } = await this.get(model);
    const tees: [string, unknown][] = [["NEAR AI gateway", raw.gateway_attestation]];
    if (!gatewayOnly) for (const a of raw.model_attestations ?? []) tees.push([`${model} TEE`, a]);
    return Promise.all(
      tees.filter(([, a]) => a && typeof (a as TeeAttestation).intel_quote === "string").map(([tee, a]) => checkHardware(tee, a as TeeAttestation, nonce, deps)),
    );
  }
}

/**
 * Checks one completion's NEAR AI signature against the keys NEAR AI's
 * attestation lists. For a NEAR AI model candidate, `expectModel` also
 * requires the answer to come from that model's TEE.
 */
export async function checkAnswer(
  id: string,
  apiKey: string,
  attestations: Attestations,
  doFetch: Fetch = fetch,
  options: { attestationModel?: string; expectModel?: string } = {},
): Promise<AnswerCheck> {
  try {
    const response = await doFetch(`${NEAR_AI}/v1/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await response.json().catch(() => null);
    const record = SignatureSchema.safeParse(body);
    if (!response.ok || !record.success) {
      return { id, ok: false, error: `no NEAR AI signature: ${(body as { error?: { message?: string } })?.error?.message ?? `HTTP ${response.status}`}` };
    }
    const { text, signature, signing_address, signature_kind } = record.data;
    const signer = recoverSigner(text, signature).toLowerCase();
    if (signer !== signing_address.toLowerCase()) return { id, ok: false, signer, error: "signature does not recover to the reported signing address" };

    const parts = text.split(":");
    const kind = signature_kind ?? (parts.length === 3 ? "provider_tee" : "gateway");
    if (kind === "provider_tee") {
      const model = parts.slice(0, -2).join(":");
      if (options.expectModel && model !== options.expectModel) {
        return { id, ok: false, kind, model, signer, error: `signed for ${model}, but the candidate is ${options.expectModel}` };
      }
      const listed = (await attestations.get(model)).model;
      const ok = listed.includes(signer);
      return { id, ok, kind, model, signer, listed, ...(ok ? {} : { error: "signer is not in the model's attestation report" }) };
    }
    // Gateway signatures cover only hashes, so the model cannot be read from them.
    const { gateway } = await attestations.get(options.attestationModel ?? DEFAULT_ATTESTATION_MODEL);
    const ok = gateway === signer;
    return { id, ok, kind, signer, listed: gateway ? [gateway] : [], ...(ok ? {} : { error: "signer is not NEAR AI's attested gateway" }) };
  } catch (error) {
    return { id, ok: false, error: message(error) };
  }
}
