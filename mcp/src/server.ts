// PROCTOR's MCP tools. Transport-independent: index.ts connects stdio, and
// the tests connect an in-memory client.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { MarketReader } from "./market.js";
import type { RegistryReader } from "./near.js";
import { checkExam, decide, marketCandidate, summarize, type ExamCheck } from "./verdict.js";

export interface ProctorDeps {
  registry: RegistryReader;
  market: MarketReader;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const MAX_ID = 128;

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "unexpected error";
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function guarded(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error: unknown) {
    return fail(error);
  }
}

/** Checks one exam, or every active exam when none is named. */
async function checkCandidate(registry: RegistryReader, candidate: string, examId?: string): Promise<ExamCheck[]> {
  const examIds = examId ? [examId] : (await registry.listExams()).filter((e) => e.active).map((e) => e.exam_id);
  return Promise.all(
    examIds.map(async (id) => {
      const cert = await registry.latestCertificate(candidate, id);
      // The contract filters by candidate and exam; checked again here, as the website does.
      return checkExam(id, cert !== null && cert.candidate_model === candidate && cert.exam_id === id ? cert : null);
    }),
  );
}

export function createProctorServer(deps: ProctorDeps): McpServer {
  const server = new McpServer({ name: "proctor", version: "0.1.0" });
  const { registry, market } = deps;

  server.registerTool(
    "proctor_list_exams",
    {
      title: "List PROCTOR exams",
      description:
        "Lists the secret exams registered in the PROCTOR registry on NEAR: id, title, author, pass mark, question count and how many times each was sat. The questions themselves are sealed in an OutLayer TEE and never revealed.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => guarded(async () => ({ registry: registry.contractId, exams: await registry.listExams() })),
  );

  server.registerTool(
    "proctor_check_candidate",
    {
      title: "Check a candidate's PROCTOR certification",
      description:
        "Checks whether a candidate (a NEAR AI model id such as 'deepseek-ai/DeepSeek-V4.1-Flash-1017', or 'agent:<owner-account>/<name>' for an agent certified through its own endpoint) holds a live PROCTOR certificate. Pass exam_id to check one exam, or omit it to check every active exam. Returns hire / do_not_hire with reasons. A certificate is live only if the candidate passed the secret exam and every surprise re-test since.",
      inputSchema: {
        candidate: z.string().min(1).max(MAX_ID).describe("Candidate id: a model id, or agent:<owner-account>/<name>"),
        exam_id: z.string().min(1).max(64).optional().describe("Exam to require; omit to check all active exams"),
      },
      annotations: READ_ONLY,
    },
    ({ candidate, exam_id }) => guarded(async () => decide(candidate, await checkCandidate(registry, candidate, exam_id))),
  );

  server.registerTool(
    "proctor_vet_market_agent",
    {
      title: "Vet an Agent Market agent before hiring",
      description:
        "Call this BEFORE hiring any agent on the NEAR AI Agent Market. Looks the agent up by its market handle and finds its PROCTOR certificate: the listing must name its NEAR account with 'proctor:<account>' in its tags or description, and that account must have certified an agent named after the handle (candidate id 'agent:<account>/<handle>'). Returns decision 'hire' only if the agent holds a live certificate; marketplace stats (jobs delivered, success rate, builder verification) are included as context but never override a missing, suspended or revoked certificate. If the decision is 'do_not_hire', do not hire the agent; tell the user why.",
      inputSchema: {
        handle: z.string().min(1).max(64).describe("The agent's Agent Market handle, e.g. 'dailybriefer'"),
        exam_id: z.string().min(1).max(64).optional().describe("Exam the job requires; omit to accept any active exam"),
      },
      annotations: READ_ONLY,
    },
    ({ handle, exam_id }) =>
      guarded(async () => {
        const agent = await market.findByHandle(handle);
        if (agent === null) {
          return { decision: "do_not_hire", candidate: `market:${handle}`, reasons: [`no Agent Market agent with the handle '${handle}' among the market's first 50 search results for it`], exams: [] };
        }
        const bound = marketCandidate(agent);
        if ("error" in bound) {
          return { ...decide(`market:${handle}`, [], agent), reasons: [bound.error] };
        }
        return decide(bound.id, await checkCandidate(registry, bound.id, exam_id), agent);
      }),
  );

  server.registerTool(
    "proctor_get_certificate",
    {
      title: "Get a PROCTOR certificate",
      description:
        "Returns one PROCTOR certificate by id: candidate, exam, score, status (active, suspended or revoked, with the reason), surprise re-tests passed, the exam-runner build hash, and a hash of the NEAR AI completion ids whose signatures back the score.",
      inputSchema: { cert_id: z.number().int().min(0).describe("Certificate id") },
      annotations: READ_ONLY,
    },
    ({ cert_id }) =>
      guarded(async () => {
        const cert = await registry.getCertificate(cert_id);
        if (cert === null) throw new Error(`no certificate with id ${cert_id}`);
        return { ...summarize(cert), candidate: cert.candidate_model, endpoint: cert.candidate_endpoint ?? null, exam_commitment: cert.exam_commitment, response_ids_hash: cert.response_ids_hash, sitting_id: cert.sitting_id };
      }),
  );

  return server;
}
