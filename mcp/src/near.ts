// Read-only access to the PROCTOR registry contract over NEAR JSON-RPC.
// View calls are free and need no keys, so this server never signs anything.

import { z } from "zod";

export const CertStatusSchema = z.union([
  z.literal("Active"),
  z.object({ Suspended: z.object({ reason: z.string(), at_ns: z.number() }) }),
  z.object({ Revoked: z.object({ reason: z.string(), at_ns: z.number() }) }),
]);

export const CertificateSchema = z.object({
  cert_id: z.number(),
  exam_id: z.string(),
  exam_commitment: z.string(),
  candidate_model: z.string(),
  /** For agents: the endpoint that answered; re-tests ask the same one. Absent on v1 registries. */
  candidate_endpoint: z.string().nullable().optional(),
  runner_hash: z.string(),
  score_bps: z.number(),
  correct: z.number(),
  total: z.number(),
  issued_at_ns: z.number(),
  last_verified_ns: z.number(),
  retests_passed: z.number(),
  status: CertStatusSchema,
  requested_by: z.string(),
  sitting_id: z.number(),
  response_ids_hash: z.string(),
  response_count: z.number(),
});

export const ExamSchema = z.object({
  exam_id: z.string(),
  author: z.string(),
  title: z.string(),
  commitment: z.string(),
  pass_mark_bps: z.number(),
  question_count: z.number(),
  active: z.boolean(),
  sittings: z.number(),
});

/** A sitting's outcome: `{"Certified": {...}}`, or a bare string for unit variants such as "Expired". */
export const SittingOutcomeSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
export type SittingOutcome = z.infer<typeof SittingOutcomeSchema>;

export type Certificate = z.infer<typeof CertificateSchema>;
export type Exam = z.infer<typeof ExamSchema>;

export class RegistryError extends Error {
  override name = "RegistryError";
}

export interface RegistryReader {
  readonly contractId: string;
  listExams(): Promise<Exam[]>;
  latestCertificate(candidate: string, examId: string): Promise<Certificate | null>;
  getCertificate(certId: number): Promise<Certificate | null>;
  /** The OutLayer account the registry calls (from get_config). */
  getOutlayerAccount(): Promise<string>;
  /** The registry's recorded outcome of a sitting, or null if it has none. */
  getOutcome(sittingId: number): Promise<SittingOutcome | null>;
}

export interface RegistryOptions {
  rpcUrl: string;
  contractId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const RpcResponseSchema = z.object({
  result: z.object({ result: z.array(z.number().int().min(0).max(255)) }).optional(),
  error: z.unknown().optional(),
});

const EXAM_PAGE = 100;

export function createRegistryReader(options: RegistryOptions): RegistryReader {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function view(method: string, args: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      id: "proctor-mcp",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: options.contractId,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    };
    let response: Response;
    try {
      response = await doFetch(options.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? `no answer within ${timeoutMs} ms` : error instanceof Error ? error.message : String(error);
      throw new RegistryError(`NEAR RPC unreachable (${options.rpcUrl}): ${reason}`);
    }
    if (!response.ok) {
      throw new RegistryError(`NEAR RPC returned HTTP ${response.status} for ${method}`);
    }
    const parsed = RpcResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new RegistryError(`unexpected NEAR RPC response for ${method}`);
    }
    if (parsed.data.error !== undefined || parsed.data.result === undefined) {
      throw new RegistryError(`registry ${options.contractId} rejected ${method}: ${JSON.stringify(parsed.data.error)}`);
    }
    const text = Buffer.from(parsed.data.result.result).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new RegistryError(`registry returned non-JSON for ${method}`);
    }
  }

  async function parsedView<T>(schema: z.ZodType<T>, method: string, args: Record<string, unknown>): Promise<T> {
    const result = schema.safeParse(await view(method, args));
    if (!result.success) {
      throw new RegistryError(`registry returned an unexpected shape for ${method}: ${result.error.message}`);
    }
    return result.data;
  }

  return {
    contractId: options.contractId,
    async listExams() {
      const exams: Exam[] = [];
      for (let from = 0; ; from += EXAM_PAGE) {
        const page = await parsedView(z.array(ExamSchema), "list_exams", { from_index: from, limit: EXAM_PAGE });
        exams.push(...page);
        if (page.length < EXAM_PAGE) return exams;
      }
    },
    latestCertificate(candidate, examId) {
      return parsedView(CertificateSchema.nullable(), "latest_certificate", {
        candidate_model: candidate,
        exam_id: examId,
      });
    },
    getCertificate(certId) {
      return parsedView(CertificateSchema.nullable(), "get_certificate", { cert_id: certId });
    },
    async getOutlayerAccount() {
      return (await parsedView(z.object({ outlayer_account: z.string() }), "get_config", {})).outlayer_account;
    },
    getOutcome(sittingId) {
      return parsedView(SittingOutcomeSchema.nullable(), "get_outcome", { sitting_id: sittingId });
    },
  };
}
