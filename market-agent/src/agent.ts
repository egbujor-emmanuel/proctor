// One polling pass: deliver a PROCTOR check for every assignment in progress.

import type { Verdict } from "../../mcp/src/verdict";
import { candidatesIn, type Candidate } from "./brief";
import { renderReport } from "./report";

/** The fields of a marketplace assignment row this agent reads. */
export interface Assignment {
  assignment: { assignmentId: string; status: string; submittedAt: string | null };
  job: { title: string; description: string; tags: string[] };
  latestMessage: { body: string; senderSide: string } | null;
}

export interface MarketApi {
  list(): Promise<Assignment[]>;
  start(id: string): Promise<void>;
  progress(id: string, message: string): Promise<void>;
  submit(id: string, markdown: string): Promise<void>;
}

export interface Checker {
  candidate(id: string): Promise<Verdict>;
  market(handle: string): Promise<Verdict>;
}

export type Outcome = { assignment: string; candidates: number; delivered: boolean; error?: string };
type Where = { registry: string; site: string };

/** The candidates a row asks about: the brief, plus the buyer's feedback on a rework. */
function candidatesFor(row: Assignment): Candidate[] {
  // A rework (already submitted, back in progress) carries the buyer's feedback as the latest message.
  const msg = row.latestMessage;
  const feedback = row.assignment.submittedAt && msg && msg.senderSide !== "worker" ? msg.body : "";
  return candidatesIn([row.job.title, row.job.description, row.job.tags.join(" "), feedback].join("\n"));
}

async function deliver(row: Assignment, candidates: Candidate[], api: MarketApi, checker: Checker, where: Where): Promise<void> {
  const id = row.assignment.assignmentId;
  await api.start(id);
  await api.progress(id, `Reading the PROCTOR registry on NEAR for ${candidates.length} candidate(s)`);
  const verdicts = await Promise.all(candidates.map((c) => (c.kind === "market" ? checker.market(c.id) : checker.candidate(c.id))));
  await api.submit(id, renderReport(verdicts, { ...where, now: new Date() }));
}

/** Delivers every in-progress assignment; one failure never stops the others. */
export async function processAssignments(api: MarketApi, checker: Checker, where: Where): Promise<Outcome[]> {
  const rows = (await api.list()).filter((r) => r.assignment.status === "in_progress");
  const out: Outcome[] = [];
  for (const row of rows) {
    const assignment = row.assignment.assignmentId;
    const candidates = candidatesFor(row);
    try {
      await deliver(row, candidates, api, checker, where);
      out.push({ assignment, candidates: candidates.length, delivered: true });
    } catch (error) {
      out.push({ assignment, candidates: candidates.length, delivered: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
