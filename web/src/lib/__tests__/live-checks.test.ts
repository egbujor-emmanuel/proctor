import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { BUILDS, ESCROW, REGISTRY, SENTINEL } from "../config";
import { base58FromHex, runLiveChecks } from "../live-checks";

const repo = join(__dirname, "..", "..", "..", "..");
const released = (file: string) => readFileSync(join(repo, file), "utf8").split(/\s+/)[0];

describe("the build hashes the page checks against", () => {
  it("are exactly the hashes CI pins in RELEASE.sha256", () => {
    expect(BUILDS.registry).toBe(released("contracts/registry/RELEASE.sha256"));
    expect(BUILDS.escrow).toBe(released("contracts/escrow/RELEASE.sha256"));
    expect(BUILDS.runner).toBe(released("exam-runner/RELEASE.sha256"));
  });
});

describe("base58FromHex", () => {
  it("matches the code hashes NEAR reports for the deployed contracts", () => {
    expect(base58FromHex("c01cf8e781b33d8f933750478bff2d2ceeb2584e8e36e9a5a6c8210c60731de0")).toBe("DvvuGeetGuPtPQpnXh9izsYk9NCdw6STgJucAkrHRyFu");
    expect(base58FromHex("5fcb47b1cc3613956a0d3bb30299ff3a0bb7b8e337f473d261b42f9d660067dc")).toBe("7SwWmQUfHYTwckCuFuPAAC239NR9rEn5fkhEUdhC5qB9");
  });

  it("keeps leading zero bytes as 1s", () => {
    expect(base58FromHex("0000ff")).toBe("115Q");
  });
});

/** A fake NEAR RPC and sentinel: code hashes per account, the registry's config, and the sentinel's status. */
function world(opts: { registryCode?: string; escrowCode?: string; runner?: string; pending?: unknown; armed?: boolean; down?: boolean }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (opts.down) throw new TypeError("Failed to fetch");
    if (url.startsWith(SENTINEL)) return Response.json({ armed: opts.armed ?? true });
    const body = JSON.parse(String(init?.body));
    const p = body.params;
    if (p.request_type === "view_account") {
      const code = p.account_id === REGISTRY ? (opts.registryCode ?? base58FromHex(BUILDS.registry)) : p.account_id === ESCROW ? (opts.escrowCode ?? base58FromHex(BUILDS.escrow)) : "11111111111111111111111111111111";
      return Response.json({ result: { code_hash: code, amount: "1", locked: "0", storage_usage: 1 } });
    }
    const config = {
      owner: "attrito.testnet",
      outlayer_account: "outlayer.testnet",
      runner_hash: opts.runner ?? BUILDS.runner,
      pending_runner: opts.pending ?? null,
      exams: 2,
      certificates: 16,
      next_sitting_id: 90,
    };
    return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(config))] } });
  }) as unknown as typeof fetch;
}

describe("runLiveChecks", () => {
  it("passes every check when the chain matches the published builds", async () => {
    const checks = await runLiveChecks(world({}));
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ["registry-code", true],
      ["escrow-code", true],
      ["runner", true],
      ["timelock", true],
      ["sentinel", true],
    ]);
  });

  it("fails the registry check when the deployed code is not the CI build", async () => {
    const checks = await runLiveChecks(world({ registryCode: "AnotherHash111111111111111111111111111111111" }));
    const registry = checks.find((c) => c.id === "registry-code")!;
    expect(registry.ok).toBe(false);
    expect(registry.detail).toContain("AnotherHash");
  });

  it("fails the runner check when the registry grades with an unreleased build", async () => {
    const checks = await runLiveChecks(world({ runner: "ab".repeat(32) }));
    expect(checks.find((c) => c.id === "runner")!.ok).toBe(false);
  });

  it("shows a pending grader change with the time it can take effect", async () => {
    const proposed = 1_794_400_000_000_000_000;
    const checks = await runLiveChecks(world({ pending: { runner_hash: "cd".repeat(32), proposed_at_ns: proposed, effective_at_ns: proposed + 86_400e9 } }));
    const timelock = checks.find((c) => c.id === "timelock")!;
    expect(timelock.ok).toBe(true);
    expect(timelock.detail).toMatch(/proposed 24 hours before/i);
  });

  it("fails the timelock check when a proposed build could take effect in under 24 hours", async () => {
    const proposed = 1_794_400_000_000_000_000;
    const checks = await runLiveChecks(world({ pending: { runner_hash: "cd".repeat(32), proposed_at_ns: proposed, effective_at_ns: proposed + 3_600e9 } }));
    const timelock = checks.find((c) => c.id === "timelock")!;
    expect(timelock.ok).toBe(false);
    expect(timelock.detail).toContain("only 1 hours");
  });

  it("fails the sentinel check when it holds no key", async () => {
    const checks = await runLiveChecks(world({ armed: false }));
    expect(checks.find((c) => c.id === "sentinel")!.ok).toBe(false);
  });

  it("reports each check as unchecked, not failed, when the network is down", async () => {
    const checks = await runLiveChecks(world({ down: true }));
    expect(checks.every((c) => c.ok === null)).toBe(true);
  });
});
