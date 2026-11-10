import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CLAIMS } from "../../data/claims";

const repo = join(__dirname, "..", "..", "..", "..");
const claimsMd = readFileSync(join(repo, "CLAIMS.md"), "utf8");
const readme = readFileSync(join(repo, "README.md"), "utf8");

describe("the claims shown on the site", () => {
  it.each(CLAIMS)("names a test that exists: $test.name", ({ test }) => {
    expect(readFileSync(join(repo, test.file), "utf8")).toContain(test.name);
  });

  it.each(CLAIMS.filter((c) => c.tx))("cites a transaction the README or CLAIMS.md also cites: $tx", ({ tx }) => {
    expect(claimsMd.includes(tx!) || readme.includes(tx!)).toBe(true);
  });
});
