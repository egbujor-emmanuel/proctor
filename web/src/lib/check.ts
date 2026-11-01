// "Check an agent": the same verdict the PROCTOR MCP server gives, computed
// in the browser from live registry reads. The rules live in one place,
// mcp/src/verdict.ts, which both the server and this site import.

import { checkExam, decide, marketCandidateId, type ExamCheck, type Verdict } from "../../../mcp/src/verdict";
import { registry, type Exam } from "./registry";

export type CandidateKind = "model" | "market";

export interface CheckRequest {
  kind: CandidateKind;
  /** A NEAR AI model id, or an Agent Market handle. */
  value: string;
}

const ID_PATTERN = /^[A-Za-z0-9._:/@+-]{1,128}$/;

/** The registry's candidate id for a request, or an error message. */
export function candidateId(request: CheckRequest): { id: string } | { error: string } {
  const value = request.value.trim();
  if (!value) return { error: "Enter a model id or an Agent Market handle." };
  if (!ID_PATTERN.test(value)) return { error: "Ids may only use letters, digits and . _ : / @ + -" };
  return { id: request.kind === "market" ? marketCandidateId(value.replace(/^market:/, "")) : value };
}

/** Checks the candidate against every active exam. */
export async function runCheck(id: string, exams: Exam[], f?: typeof fetch): Promise<Verdict> {
  const active = exams.filter((e) => e.active);
  const checks: ExamCheck[] = await Promise.all(
    active.map(async (exam) => checkExam(exam.exam_id, await registry.latest(id, exam.exam_id, f))),
  );
  return decide(id, checks);
}

export type { Verdict, ExamCheck };
