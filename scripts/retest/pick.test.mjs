import assert from "node:assert/strict";
import { test } from "node:test";

import { ineligibility, pick, RETEST_COOLDOWN_NS, SITTING_TIMEOUT_NS, stuckSittings } from "./pick.mjs";

const NOW = 1_793_579_454_969_950_425n;
const cert = (id, extra = {}) => ({ cert_id: id, candidate_model: `m${id}`, exam_id: "e", status: "Active", retest_in_flight: null, last_retest_requested_ns: null, ...extra });
const first = () => 0;

test("re-tests active and suspended certificates, never revoked ones", () => {
  assert.equal(ineligibility(cert(0), NOW), null);
  assert.equal(ineligibility(cert(0, { status: { Suspended: { reason: "r", at_ns: 1 } } }), NOW), null);
  assert.equal(ineligibility(cert(0, { status: { Revoked: { reason: "r", at_ns: 1 } } }), NOW), "revoked");
});

test("respects the contract's one-hour gap with a safety margin", () => {
  const justNow = String(NOW - RETEST_COOLDOWN_NS);
  assert.equal(ineligibility(cert(0, { last_retest_requested_ns: justNow }), NOW), "re-tested less than an hour ago");
  const longAgo = String(NOW - 2n * RETEST_COOLDOWN_NS);
  assert.equal(ineligibility(cert(0, { last_retest_requested_ns: longAgo }), NOW), null);
});

test("skips a certificate whose re-test is still running", () => {
  assert.equal(ineligibility(cert(0, { retest_in_flight: 7 }), NOW), "a re-test is already running");
});

test("picks uniformly among eligible certificates only", () => {
  const certs = [cert(0, { status: { Revoked: { reason: "r", at_ns: 1 } } }), cert(1), cert(2)];
  assert.deepEqual(pick(certs, NOW, first), { cert_id: 1, candidate: "m1", exam_id: "e", eligible: 2 });
  assert.equal(pick(certs, NOW, (n) => n - 1).cert_id, 2);
});

test("explains why nothing was picked", () => {
  assert.deepEqual(pick([], NOW, first), { skip: "no certificates yet" });
  assert.match(pick([cert(0, { retest_in_flight: 3 })], NOW, first).skip, /#0: a re-test is already running/);
  assert.deepEqual(pick([cert(0)], NOW, first, 9), { skip: "certificate 9 does not exist" });
});

test("can be forced onto one certificate", () => {
  assert.equal(pick([cert(0), cert(1)], NOW, first, 1).cert_id, 1);
});

test("finds re-tests stuck past the registry's expiry timeout", () => {
  const certs = [cert(0, { retest_in_flight: 7 }), cert(1, { retest_in_flight: 8 }), cert(2)];
  const requestedAt = new Map([[7, String(NOW - 2n * SITTING_TIMEOUT_NS)], [8, String(NOW - 60n * 1_000_000_000n)]]);
  assert.deepEqual(stuckSittings(certs, requestedAt, NOW), [7]);
});
