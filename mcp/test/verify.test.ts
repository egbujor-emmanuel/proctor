import { describe, expect, it, vi } from "vitest";

import { Attestations, checkAnswer, recoverSigner, responseIdsHash, sittingFromTransaction, type Transaction } from "../src/verify.js";

// A real NEAR AI signature: certificate 0 on registry-v2.attrito.testnet,
// answered by DeepSeek V4.1 Flash inside its TEE (2026-11-02).
const TEXT = "deepseek-ai/DeepSeek-V4.1-Flash-1017:b54b5a8462f911987a44eb64be6ede5379b1517717d1e68e4d9a2d12ae80bec3:85e3af3deb157d5fe7e1e130cfa4671e8ce9bda11203540c642f422582797483";
const SIGNATURE = "0xa0d27cf73f20dedd6c2a5c98e3acd624e691283a9289a01b65db7941ee6ba95317ae5a363e0e9ee2c3cdc3405939c7026bb9de04a1e591f10f1fdcf254ef09701c";
const MODEL_KEY = "0xfe0071895500a9755c18044948ab4f4e1a7f337e";
const GATEWAY_KEY = "0xb98a789cdc4817275f5155593ba73ef2a957e779";
const CERT0_IDS = [
  "chatcmpl-a59ca0e4-d473-4bd7-aebe-63f8b5653528",
  "chatcmpl-fa08ce0e-27e8-424b-8930-1eb63c80c5db",
  "chatcmpl-73ee13fd-4eb7-4337-bb42-2864904b0555",
  "chatcmpl-c3c89ad0-7a2a-47c1-8122-3bae6c4e976c",
  "chatcmpl-71769cf5-8b80-480a-8a48-f2045fc9a046",
];

describe("recoverSigner", () => {
  it("recovers the attested TEE key from a real NEAR AI signature", () => {
    expect(recoverSigner(TEXT, SIGNATURE)).toBe(MODEL_KEY);
  });

  it("recovers a different key if the signed text was altered", () => {
    expect(recoverSigner(TEXT.replace("b54b", "b54c"), SIGNATURE)).not.toBe(MODEL_KEY);
  });

  it("rejects a signature of the wrong length", () => {
    expect(() => recoverSigner(TEXT, "0x1234")).toThrow("65 bytes");
  });
});

describe("responseIdsHash", () => {
  it("matches the hash the registry stored for certificate 0", () => {
    expect(responseIdsHash(CERT0_IDS)).toBe("8a107b87b4f49db7d1b57cba320900f6fed60f3297c02f567478f2a11a67e985");
  });
});

describe("sittingFromTransaction", () => {
  const REGISTRY = "registry-v2.attrito.testnet";
  const OUTLAYER = "outlayer.testnet";
  const resolved = `EVENT_JSON:${JSON.stringify({ standard: "proctor", event: "sitting_resolved", data: [{ sitting_id: 0, exam_id: "e", candidate_model: "m", outcome: { Certified: { cert_id: 0, score_bps: 6000 } }, response_ids: CERT0_IDS }] })}`;
  const executed = `EVENT_JSON:${JSON.stringify({ standard: "near-outlayer", event: "execution_completed", data: [{ code_source: { WasmUrl: { url: "https://x/r.wasm", hash: "ab" } } }] })}`;
  const tx = (...receipts: Transaction["receipts"]): Transaction => ({ receiver: REGISTRY, receipts });

  it("reads the sitting from the registry and the runner from OutLayer", () => {
    const s = sittingFromTransaction(tx({ executor: OUTLAYER, logs: [executed], succeeded: true }, { executor: REGISTRY, logs: ["plain log", resolved], succeeded: true }), REGISTRY, OUTLAYER);
    expect(s).toMatchObject({ sittingId: 0, candidate: "m", examId: "e", responseIds: CERT0_IDS, runnerHash: "ab", runnerUrl: "https://x/r.wasm" });
  });

  it("ignores events another contract logs, so a forged sitting cannot pass", () => {
    const forged = tx({ executor: "evil.testnet", logs: [executed, resolved], succeeded: true });
    expect(() => sittingFromTransaction(forged, REGISTRY, OUTLAYER)).toThrow("found 0");
    const s = sittingFromTransaction(tx({ executor: "evil.testnet", logs: [executed], succeeded: true }, { executor: REGISTRY, logs: [resolved], succeeded: true }), REGISTRY, OUTLAYER);
    expect(s.runnerHash).toBeUndefined();
  });

  it("ignores logs from failed receipts and skips malformed events", () => {
    expect(() => sittingFromTransaction(tx({ executor: REGISTRY, logs: [resolved], succeeded: false }), REGISTRY, OUTLAYER)).toThrow("found 0");
    const s = sittingFromTransaction(tx({ executor: REGISTRY, logs: ["EVENT_JSON:{not json", resolved], succeeded: true }), REGISTRY, OUTLAYER);
    expect(s.sittingId).toBe(0);
  });

  it("refuses a transaction that resolved no sitting, or two", () => {
    expect(() => sittingFromTransaction(tx({ executor: REGISTRY, logs: [executed], succeeded: true }), REGISTRY, OUTLAYER)).toThrow("found 0");
    expect(() => sittingFromTransaction(tx({ executor: REGISTRY, logs: [resolved, resolved], succeeded: true }), REGISTRY, OUTLAYER)).toThrow("found 2");
  });

  it("reads unit outcomes such as Expired", () => {
    const expired = resolved.replace('{"Certified":{"cert_id":0,"score_bps":6000}}', '"Expired"');
    expect(sittingFromTransaction(tx({ executor: REGISTRY, logs: [expired], succeeded: true }), REGISTRY, OUTLAYER).outcome).toBe("Expired");
  });
});

/** A fake NEAR AI: signature records by id, and one attestation report. */
function nearAi(signatures: Record<string, unknown>, report = { model_attestations: [{ signing_address: MODEL_KEY }], gateway_attestation: { signing_address: GATEWAY_KEY } }) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/v1/attestation/report")) return Response.json(report);
    const id = decodeURIComponent(u.split("/v1/signature/")[1]!.split("?")[0]!);
    return id in signatures ? Response.json(signatures[id]) : Response.json({ error: { message: "Chat id not found or expired" } }, { status: 404 });
  }) as unknown as typeof fetch;
}

const record = { text: TEXT, signature: SIGNATURE, signing_address: MODEL_KEY, signing_algo: "ecdsa", signature_kind: "provider_tee" };

describe("checkAnswer", () => {
  it("passes a model-TEE signature whose signer the model's attestation names", async () => {
    const f = nearAi({ a: record });
    const check = await checkAnswer("a", "k", new Attestations("k", f), f);
    expect(check).toMatchObject({ ok: true, kind: "provider_tee", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", signer: MODEL_KEY });
  });

  it("fails an id NEAR AI never signed, such as one an agent made up", async () => {
    const f = nearAi({});
    const check = await checkAnswer("made-up", "k", new Attestations("k", f), f);
    expect(check.ok).toBe(false);
    expect(check.error).toContain("no NEAR AI signature");
  });

  it("fails when the attestation names a different key", async () => {
    const f = nearAi({ a: record }, { model_attestations: [{ signing_address: "0x0000000000000000000000000000000000000001" }], gateway_attestation: { signing_address: GATEWAY_KEY } });
    const check = await checkAnswer("a", "k", new Attestations("k", f), f);
    expect(check).toMatchObject({ ok: false, error: "signer is not in the model's attestation report" });
  });

  it("fails when the record's claimed signer is not who signed", async () => {
    const f = nearAi({ a: { ...record, signing_address: GATEWAY_KEY } });
    const check = await checkAnswer("a", "k", new Attestations("k", f), f);
    expect(check).toMatchObject({ ok: false, error: "signature does not recover to the reported signing address" });
  });

  it("fails a model candidate whose answer came from a different model's TEE", async () => {
    const f = nearAi({ a: record });
    const check = await checkAnswer("a", "k", new Attestations("k", f), f, { expectModel: "openai/gpt-5.4-nano" });
    expect(check).toMatchObject({ ok: false, error: "signed for deepseek-ai/DeepSeek-V4.1-Flash-1017, but the candidate is openai/gpt-5.4-nano" });
  });

  it("does not cache a failed attestation lookup", async () => {
    let calls = 0;
    const f = vi.fn(async () => (++calls === 1 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : Response.json({ model_attestations: [{ signing_address: MODEL_KEY }] }))) as unknown as typeof fetch;
    const attestations = new Attestations("k", f);
    await expect(attestations.get("m")).rejects.toThrow("busy");
    await expect(attestations.get("m")).resolves.toMatchObject({ model: [MODEL_KEY] });
  });

  it("labels a gateway signature as such and checks it against the gateway's key", async () => {
    // Same real signature, presented as a gateway record: its signer is the model key, not the gateway's.
    const f = nearAi({ g: { ...record, signature_kind: "gateway" } });
    const check = await checkAnswer("g", "k", new Attestations("k", f), f);
    expect(check).toMatchObject({ ok: false, kind: "gateway", error: "signer is not NEAR AI's attested gateway" });
  });
});
