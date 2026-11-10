import { describe, expect, it, vi } from "vitest";

import type { Verdict } from "../../mcp/src/verdict";
import { candidatesIn, MAX_CANDIDATES } from "../src/brief";
import { renderReport } from "../src/report";
import { processAssignments, type Checker, type MarketApi, type Assignment } from "../src/agent";

describe("candidatesIn", () => {
  it("finds model ids, agent ids and Agent Market handles in a brief", () => {
    const text = `Before we hire, check anthropic/claude-sonnet-5-5 and agent:attrito.testnet/demo-agent.
      Also the listing at https://market.near.ai/a/ledgerline-audit and @dailybriefer.`;
    expect(candidatesIn(text)).toEqual([
      { kind: "agent", id: "agent:attrito.testnet/demo-agent" },
      { kind: "model", id: "anthropic/claude-sonnet-5-5" },
      { kind: "market", id: "ledgerline-audit" },
      { kind: "market", id: "dailybriefer" },
    ]);
  });

  it("does not mistake web addresses or file paths for models", () => {
    expect(candidatesIn("see https://github.com/egbujor-emmanuel/proctor and docs/README.md")).toEqual([]);
  });

  it("lists each candidate once, and at most MAX_CANDIDATES", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => `org/model-${i}`).join(" ");
    expect(candidatesIn(`${many} org/model-0`)).toHaveLength(MAX_CANDIDATES);
  });
});

const hire: Verdict = {
  decision: "hire",
  candidate: "anthropic/claude-sonnet-5-5",
  reasons: ["certified on near-reasoning-pool-v1: scored 10/10 (100.00%), last verified 2026-11-10T06:09:30.339Z, 0 surprise re-test(s) passed"],
  exams: [
    {
      exam_id: "near-reasoning-pool-v1",
      state: "active",
      certificate: { cert_id: 4, exam_id: "near-reasoning-pool-v1", state: "active", score: "10/10 (100.00%)", retests_passed: 0, last_verified: "2026-11-10T06:09:30.339Z", runner_hash: "4ee3e335" },
    },
  ],
};
const noHire: Verdict = { decision: "do_not_hire", candidate: "openai/gpt-5.4-nano", reasons: ["no PROCTOR certificate"], exams: [] };

describe("renderReport", () => {
  it("states each decision with its reasons and links the certificate", () => {
    const md = renderReport([hire, noHire], { registry: "registry-v2.attrito.testnet", site: "https://proctor.attrito.workers.dev", now: new Date("2026-11-10T12:00:00Z") });
    expect(md).toContain("anthropic/claude-sonnet-5-5");
    expect(md).toMatch(/Hire/);
    expect(md).toMatch(/Do not hire/);
    expect(md).toContain("certificate 4");
    expect(md).toContain("registry-v2.attrito.testnet");
    expect(md).toContain("node scripts/evidence.mjs");
  });

  it("explains what it accepts when the brief names no candidate", () => {
    const md = renderReport([], { registry: "r.testnet", site: "https://s", now: new Date(0) });
    expect(md).toMatch(/no candidate/i);
    expect(md).toContain("agent:<owner-account>/<name>");
  });
});

const assignment = (extra: Partial<Assignment["assignment"]> = {}, description = "check anthropic/claude-sonnet-5-5"): Assignment => ({
  assignment: { assignmentId: "A1", status: "in_progress", submittedAt: null, ...extra },
  job: { title: "Vet a model", description, tags: [] },
  latestMessage: null,
});

function fakeApi(rows: Assignment[]): MarketApi & { submitted: { id: string; markdown: string }[] } {
  const submitted: { id: string; markdown: string }[] = [];
  return {
    submitted,
    list: vi.fn(async () => rows),
    start: vi.fn(async () => {}),
    progress: vi.fn(async () => {}),
    submit: vi.fn(async (id: string, markdown: string) => void submitted.push({ id, markdown })),
  };
}
const checker: Checker = { candidate: vi.fn(async () => hire), market: vi.fn(async () => noHire) };
const opts = { registry: "registry-v2.attrito.testnet", site: "https://proctor.attrito.workers.dev" };

describe("processAssignments", () => {
  it("starts, reports progress, checks the candidates and delivers the report", async () => {
    const api = fakeApi([assignment()]);
    const result = await processAssignments(api, checker, opts);
    expect(api.start).toHaveBeenCalledWith("A1");
    expect(api.progress).toHaveBeenCalled();
    expect(api.submitted).toHaveLength(1);
    expect(api.submitted[0]!.markdown).toContain("anthropic/claude-sonnet-5-5");
    expect(result).toEqual([{ assignment: "A1", candidates: 1, delivered: true }]);
  });

  it("leaves assignments that are not in progress alone", async () => {
    const api = fakeApi([assignment({ status: "submitted" })]);
    await processAssignments(api, checker, opts);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it("reads the buyer's rework message for new candidates", async () => {
    const rework = { ...assignment({ submittedAt: "2026-11-10T11:00:00Z" }, "check a model"), latestMessage: { body: "please also check openai/gpt-5.4-nano", senderSide: "requester" } };
    const api = fakeApi([rework]);
    await processAssignments(api, checker, opts);
    expect(checker.candidate).toHaveBeenCalledWith("openai/gpt-5.4-nano");
  });

  it("keeps going when one assignment fails, and reports it", async () => {
    const api = fakeApi([assignment(), assignment({ assignmentId: "A2" })]);
    (api.submit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("HTTP 500"));
    const result = await processAssignments(api, checker, opts);
    expect(result).toEqual([
      { assignment: "A1", candidates: 1, delivered: false, error: "HTTP 500" },
      { assignment: "A2", candidates: 1, delivered: true },
    ]);
  });
});
