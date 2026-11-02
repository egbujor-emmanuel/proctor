import assert from "node:assert/strict";
import { test } from "node:test";

import { fromUnits, toYocto } from "./payout-quote.mjs";

test("converts NEAR to yoctoNEAR exactly, with no float rounding", () => {
  assert.equal(toYocto("2.5"), 2_500_000_000_000_000_000_000_000n);
  assert.equal(toYocto("0.000000000000000000000001"), 1n);
  assert.throws(() => toYocto("1e3"), /not a NEAR amount/);
  assert.throws(() => toYocto("0.0000000000000000000000001"), /not a NEAR amount/);
});

test("formats smallest units back to decimals", () => {
  assert.equal(fromUnits(10_631_711n, 6), "10.631711");
  assert.equal(fromUnits(2_500_000_000_000_000_000_000_000n, 24), "2.5");
  assert.equal(fromUnits(5n, 6), "0.000005");
  assert.equal(fromUnits(7_000_000n, 6), "7");
});
