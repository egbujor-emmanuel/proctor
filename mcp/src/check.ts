// The hire decision, shared by the MCP tools and PROCTOR's Agent Market agent
// so both always give the same answer. Read-only: registry and market reads.

import type { MarketReader } from "./market.js";
import type { Certificate, RegistryReader } from "./near.js";
import {
  checkExam,
  countedExams,
  decide,
  marketCandidate,
  untrustedReason,
  withPriorRevocations,
  withTrust,
  type ExamCheck,
  type Verdict,
} from "./verdict.js";

/** How many earlier certificates a check scans for revocations under the same id. */
const HISTORY_LIMIT = 100;

/**
 * Checks the named exam, or every trusted exam when none is named. A named
 * exam that would not count by default is still checked, with a caution.
 */
export async function checkCandidate(registry: RegistryReader, trustedAuthors: readonly string[], candidate: string, examId?: string): Promise<ExamCheck[]> {
  const exams = await registry.listExams();
  const named = examId === undefined ? undefined : exams.find((e) => e.exam_id === examId);
  const checked = examId === undefined ? countedExams(exams, trustedAuthors) : [named ?? { exam_id: examId }];
  return Promise.all(
    checked.map(async (exam) => {
      const id = exam.exam_id;
      const cert = await registry.latestCertificate(candidate, id);
      // The contract filters by candidate and exam; checked again here, as the website does.
      const own = cert !== null && cert.candidate_model === candidate && cert.exam_id === id ? cert : null;
      let check = checkExam(id, own);
      if (examId !== undefined) check = withTrust(check, named ? untrustedReason(named, trustedAuthors) : "the registry has no such exam");
      return own ? withPriorRevocations(check, await countPriorRevocations(registry, own)) : check;
    }),
  );
}

/** Revoked certificates for the same candidate and exam among the HISTORY_LIMIT before `cert`. */
export async function countPriorRevocations(registry: RegistryReader, cert: Certificate): Promise<number> {
  const first = Math.max(0, cert.cert_id - HISTORY_LIMIT);
  const ids = Array.from({ length: cert.cert_id - first }, (_, i) => first + i);
  const earlier = await Promise.all(ids.map((certId) => registry.getCertificate(certId)));
  return earlier.filter(
    (c) => c !== null && c.candidate_model === cert.candidate_model && c.exam_id === cert.exam_id && "Revoked" in (c.status as object),
  ).length;
}

/** hire / do_not_hire for a model id or `agent:<owner>/<name>`. */
export async function checkCandidateDecision(registry: RegistryReader, trustedAuthors: readonly string[], candidate: string, examId?: string): Promise<Verdict> {
  return decide(candidate, await checkCandidate(registry, trustedAuthors, candidate, examId));
}

/** hire / do_not_hire for an Agent Market listing, found by its handle. */
export async function vetMarketAgent(
  registry: RegistryReader,
  market: MarketReader,
  trustedAuthors: readonly string[],
  handle: string,
  examId?: string,
): Promise<Verdict> {
  const agent = await market.findByHandle(handle);
  if (agent === null) {
    return { decision: "do_not_hire", candidate: `market:${handle}`, reasons: [`no Agent Market agent with the handle '${handle}' among the market's first 50 search results for it`], exams: [] };
  }
  const bound = marketCandidate(agent);
  if ("error" in bound) {
    return { ...decide(`market:${handle}`, [], agent), reasons: [bound.error] };
  }
  return decide(bound.id, await checkCandidate(registry, trustedAuthors, bound.id, examId), agent);
}
