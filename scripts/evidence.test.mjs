import assert from "node:assert/strict";
import { test } from "node:test";

import { eventLabels, extractTxHashes, summarize } from "./evidence.mjs";

const A = "Eokg4Rja1MzFuHDKo998LNrtJNuqSRk21H9qF22PkK4U";
const B = "HQx9am4QrjSEbptjvsJpfLkB87iB8U5Z491J25jVqgte";
const ev = (standard, event, data) => `EVENT_JSON:${JSON.stringify({ standard, version: "1", event, data: [data] })}`;

test("collects each linked transaction once, in order, across files", () => {
  const readme = `[x](https://testnet.near.rocks/tx/${A}) and [y](https://testnet.near.rocks/tx/${B})`;
  const claims = `again [x](https://testnet.near.rocks/tx/${A}) and an account https://testnet.near.rocks/account/foo.testnet`;
  assert.deepEqual(extractTxHashes(readme, claims), [A, B]);
});

test("labels a resolved sitting with its outcome and candidate, and ignores other contracts' logs", () => {
  const logs = [
    ev("proctor", "sitting_resolved", { sitting_id: 61, candidate_model: "openai/gpt-5.4-mini", outcome: { Suspended: { cert_id: 11 } } }),
    ev("nep171", "nft_mint", {}),
    "not an event",
    ev("proctor-escrow", "job_paid", { job_id: "0" }),
  ];
  assert.deepEqual(eventLabels(logs), ["sitting 61: Suspended (openai/gpt-5.4-mini)", "job_paid"]);
});

test("a transaction with a failed receipt is not OK", () => {
  const entry = {
    transaction: { hash: A, signer_id: "s.testnet", receiver_id: "r.testnet", actions: [{ FunctionCall: { method_name: "retest" } }] },
    receipts: [{ execution_outcome: { outcome: { status: { Failure: {} }, logs: [] } } }],
  };
  assert.equal(summarize(entry).ok, false);
  assert.equal(summarize(entry).method, "retest");
});

test("a transaction whose receipts all succeed is OK", () => {
  const entry = {
    transaction: { hash: B, signer_id: "s.testnet", receiver_id: "r.testnet", actions: ["CreateAccount"] },
    receipts: [{ execution_outcome: { outcome: { status: { SuccessValue: "" }, logs: [] } } }],
  };
  assert.deepEqual({ ok: summarize(entry).ok, method: summarize(entry).method }, { ok: true, method: "CreateAccount" });
});
