// "Check an agent": the same verdict the PROCTOR MCP server gives, computed
// in the browser from live registry reads. The rules live in one place,
// mcp/src/verdict.ts, which both the server and this site import.

import { agentCandidateId, checkExam, countedExams, decide, withPriorRevocations, type ExamCheck, type Verdict } from "../../../mcp/src/verdict";
import { registry, RegistryError, type Certificate, type Exam } from "./registry";

export type CandidateKind = "model" | "agent";

export interface CheckRequest {
  kind: CandidateKind;
  /** A NEAR AI model id, or an agent as <owner-account>/<name>. */
  value: string;
}

/** The registry's charset for candidate ids, and its length limit. */
const ID_PATTERN = /^[A-Za-z0-9._:/@+-]+$/;
const MAX_ID = 128;
/** <owner-account>/<name>, as the registry builds agent ids (agent names: 48 bytes, no "/"). */
const AGENT = /^([a-z0-9._-]+\.(?:near|testnet))\/([A-Za-z0-9._:@+-]{1,48})$/;

/** The registry's candidate id for a request, or an error message. */
export function candidateId(request: CheckRequest): { id: string } | { error: string } {
  const value = request.value.trim();
  if (!value) return { error: request.kind === "agent" ? "Enter the agent as owner-account/name." : "Enter a model id." };
  if (!ID_PATTERN.test(value)) return { error: "Ids may only use letters, digits and . _ : / @ + -" };
  let id = value;
  if (request.kind === "agent") {
    const match = AGENT.exec(value.replace(/^agent:/, ""));
    if (!match) return { error: "Agents are owner-account/name, such as attrito.testnet/demo-agent." };
    id = agentCandidateId(match[1]!, match[2]!);
  }
  if (id.length > MAX_ID) return { error: `Ids are at most ${MAX_ID} characters.` };
  return { id };
}

/**
 * The verdict from certificates already in hand (the page's registry read),
 * shown while the live check runs. Null when none of them is the candidate's,
 * since a newer certificate may exist that the read predates.
 */
export function snapshotVerdict(id: string, exams: Exam[], known: Certificate[]): Verdict | null {
  const checks: ExamCheck[] = [];
  let found = false;
  for (const exam of countedExams(exams)) {
    const mine = known.filter((c) => c.candidate_model === id && c.exam_id === exam.exam_id);
    const cert = mine.reduce<Certificate | null>((a, c) => (a === null || c.cert_id > a.cert_id ? c : a), null);
    if (cert) found = true;
    const revoked = mine.filter((c) => cert && c.cert_id < cert.cert_id && typeof c.status === "object" && "Revoked" in c.status).length;
    checks.push(cert ? withPriorRevocations(checkExam(exam.exam_id, cert), revoked) : checkExam(exam.exam_id, null));
  }
  return found ? decide(id, checks) : null;
}

/**
 * Checks the candidate against every trusted exam (see countedExams). `known`
 * is the registry's certificate list, used to flag earlier revocations.
 */
export async function runCheck(id: string, exams: Exam[], known: Certificate[] = [], f?: typeof fetch): Promise<Verdict> {
  const active = countedExams(exams);
  const checks: ExamCheck[] = await Promise.all(
    active.map(async (exam) => {
      const cert = await registry.latest(id, exam.exam_id, f);
      // The contract already filters by candidate and exam; a mismatch means
      // the read is wrong, so it is an error, never "no certificate".
      if (cert !== null && (cert.candidate_model !== id || cert.exam_id !== exam.exam_id)) {
        throw new RegistryError(`the registry returned a certificate for a different candidate or exam (${cert.candidate_model}, ${cert.exam_id})`);
      }
      if (cert === null) return checkExam(exam.exam_id, null);
      const revoked = known.filter(
        (c) => c.cert_id < cert.cert_id && c.candidate_model === id && c.exam_id === exam.exam_id && typeof c.status === "object" && "Revoked" in c.status,
      );
      return withPriorRevocations(checkExam(exam.exam_id, cert), revoked.length);
    }),
  );
  return decide(id, checks);
}

export type { Verdict, ExamCheck };
