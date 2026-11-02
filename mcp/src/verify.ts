// Independent check of one PROCTOR sitting, from public data only:
//   1. the sitting's events, read from the NEAR transaction;
//   2. the certificate's response_ids_hash, recomputed from the event's ids;
//   3. the runner OutLayer ran (from OutLayer's own event) against the certificate;
//   4. for every answer, NEAR AI's signature: valid, and signed by the TEE key
//      NEAR AI's attestation report names (the model's TEE, or for models at
//      external providers, NEAR AI's gateway TEE).
// The request/response hashes inside each signature cover the secret exam,
// so they are reported but cannot be recomputed by a third party.

import { createHash } from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const NEAR_AI = "https://cloud-api.near.ai";
/** Any TEE-hosted model: its report also carries the gateway's attestation. */
export const DEFAULT_ATTESTATION_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

type Fetch = typeof fetch;

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The address that signed `text` with Ethereum personal_sign (EIP-191). */
export function recoverSigner(text: string, signatureHex: string): string {
  const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`);
  const message = Buffer.from(text, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${message.length}`, "utf8"), message]));
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  const point = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(recovery).recoverPublicKey(digest);
  const uncompressed = point.toBytes(false);
  return `0x${toHex(keccak_256(uncompressed.subarray(1)).subarray(12))}`;
}

/** The registry's hash of a sitting's completion ids (checks.rs response_ids_hash). */
export function responseIdsHash(ids: string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

export interface SittingEvents {
  sittingId: number;
  candidate: string;
  outcome: Record<string, unknown>;
  responseIds: string[];
  /** The runner OutLayer ran, from its execution_completed event. */
  runnerHash?: string;
  runnerUrl?: string;
}

/** Parses NEP-297 logs from a transaction into the sitting's evidence. */
export function sittingFromLogs(logs: string[]): SittingEvents {
  let sitting: SittingEvents | undefined;
  let runner: { hash?: string; url?: string } = {};
  for (const log of logs) {
    if (!log.startsWith("EVENT_JSON:")) continue;
    const event = JSON.parse(log.slice("EVENT_JSON:".length));
    const data = event.data?.[0];
    if (event.standard === "proctor" && event.event === "sitting_resolved") {
      sitting = { sittingId: data.sitting_id, candidate: data.candidate_model, outcome: data.outcome, responseIds: data.response_ids ?? [] };
    }
    if (event.standard === "near-outlayer" && event.event === "execution_completed") {
      const source = data?.code_source?.WasmUrl;
      runner = { hash: source?.hash, url: source?.url };
    }
  }
  if (!sitting) throw new Error("this transaction resolved no PROCTOR sitting (no sitting_resolved event)");
  return { ...sitting, runnerHash: runner.hash, runnerUrl: runner.url };
}

export async function readTransactionLogs(rpcUrl: string, txHash: string, sender: string, doFetch: Fetch = fetch): Promise<string[]> {
  const response = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proctor-verify", method: "EXPERIMENTAL_tx_status", params: { tx_hash: txHash, sender_account_id: sender, wait_until: "FINAL" } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as { error?: unknown; result?: { receipts_outcome?: { outcome: { logs: string[] } }[] } };
  if (body.error || !body.result) throw new Error(`cannot read transaction ${txHash}: ${JSON.stringify(body.error)}`);
  return (body.result.receipts_outcome ?? []).flatMap((r) => r.outcome.logs);
}

export interface AnswerCheck {
  id: string;
  ok: boolean;
  kind?: "provider_tee" | "gateway" | string;
  model?: string;
  signer?: string;
  attested?: string[];
  error?: string;
}

interface SignatureRecord {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

/** NEAR AI attestation, cached per model: the model TEE keys and the gateway key. */
export class Attestations {
  private cache = new Map<string, Promise<{ model: string[]; gateway?: string }>>();
  constructor(private apiKey: string, private doFetch: Fetch = fetch) {}

  get(model: string) {
    let entry = this.cache.get(model);
    if (!entry) {
      entry = (async () => {
        const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
        const url = `${NEAR_AI}/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`;
        const response = await this.doFetch(url, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(60_000) });
        const body = (await response.json()) as { model_attestations?: { signing_address?: string }[]; gateway_attestation?: { signing_address?: string }; error?: { message?: string } };
        if (!response.ok) throw new Error(`attestation for ${model}: ${body.error?.message ?? `HTTP ${response.status}`}`);
        return {
          model: (body.model_attestations ?? []).flatMap((a) => (a.signing_address ? [a.signing_address.toLowerCase()] : [])),
          gateway: body.gateway_attestation?.signing_address?.toLowerCase(),
        };
      })();
      this.cache.set(model, entry);
    }
    return entry;
  }
}

/** Checks one completion's NEAR AI signature against the attested signer. */
export async function checkAnswer(id: string, apiKey: string, attestations: Attestations, doFetch: Fetch = fetch, attestationModel = DEFAULT_ATTESTATION_MODEL): Promise<AnswerCheck> {
  try {
    const response = await doFetch(`${NEAR_AI}/v1/signature/${encodeURIComponent(id)}?signing_algo=ecdsa`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const record = (await response.json()) as SignatureRecord & { error?: { message?: string } };
    if (!response.ok || !record.signature) return { id, ok: false, error: `no NEAR AI signature: ${record.error?.message ?? `HTTP ${response.status}`}` };
    const signer = recoverSigner(record.text, record.signature).toLowerCase();
    if (signer !== record.signing_address.toLowerCase()) return { id, ok: false, signer, error: "signature does not recover to the reported signing address" };

    const parts = record.text.split(":");
    const kind = record.signature_kind ?? (parts.length === 3 ? "provider_tee" : "gateway");
    if (kind === "provider_tee") {
      const model = parts.slice(0, -2).join(":");
      const attested = (await attestations.get(model)).model;
      return { id, ok: attested.includes(signer), kind, model, signer, attested, ...(attested.includes(signer) ? {} : { error: "signer is not in the model's attestation report" }) };
    }
    const gateway = (await attestations.get(attestationModel)).gateway;
    const attested = gateway ? [gateway] : [];
    return { id, ok: gateway === signer, kind, signer, attested, ...(gateway === signer ? {} : { error: "signer is not NEAR AI's attested gateway" }) };
  } catch (error) {
    return { id, ok: false, error: (error as Error).message };
  }
}
