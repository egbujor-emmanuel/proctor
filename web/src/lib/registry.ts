// Read-only view calls to the PROCTOR registry from the browser. NEAR RPC
// allows cross-origin requests, view calls need no keys, and every response
// is validated before the page shows it.

import { z } from "zod";

import { REGISTRY, RPC_URL } from "./config";

const StatusSchema = z.union([
  z.literal("Active"),
  z.object({ Suspended: z.object({ reason: z.string(), at_ns: z.number() }) }),
  z.object({ Revoked: z.object({ reason: z.string(), at_ns: z.number() }) }),
]);

export const CertificateSchema = z.object({
  cert_id: z.number(),
  exam_id: z.string(),
  exam_commitment: z.string(),
  candidate_model: z.string(),
  runner_hash: z.string(),
  score_bps: z.number(),
  correct: z.number(),
  total: z.number(),
  issued_at_ns: z.number(),
  last_verified_ns: z.number(),
  retests_passed: z.number(),
  status: StatusSchema,
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

export const ConfigSchema = z.object({
  owner: z.string(),
  outlayer_account: z.string(),
  runner_hash: z.string(),
  exams: z.number(),
  certificates: z.number(),
  next_sitting_id: z.number(),
});

export type Certificate = z.infer<typeof CertificateSchema>;
export type Exam = z.infer<typeof ExamSchema>;
export type RegistryConfig = z.infer<typeof ConfigSchema>;

export class RegistryError extends Error {
  override name = "RegistryError";
}

const RpcSchema = z.object({
  result: z.object({ result: z.array(z.number()) }).optional(),
  error: z.unknown().optional(),
});

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

export async function view<T>(
  schema: z.ZodType<T>,
  method: string,
  args: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "proctor-web",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: REGISTRY,
          method_name: method,
          args_base64: toBase64(JSON.stringify(args)),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RegistryError("Could not reach NEAR testnet. Check your connection and try again.");
  }
  if (!response.ok) throw new RegistryError(`NEAR RPC answered HTTP ${response.status}.`);
  const rpc = RpcSchema.safeParse(await response.json());
  if (!rpc.success || rpc.data.error !== undefined || !rpc.data.result) {
    throw new RegistryError(`The registry did not answer ${method}.`);
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(rpc.data.result.result)));
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RegistryError(`The registry returned an unexpected ${method} result.`);
  return parsed.data;
}

const PAGE = 100;

export const registry = {
  config: (f?: typeof fetch) => view(ConfigSchema, "get_config", {}, f),
  exams: (f?: typeof fetch) => view(z.array(ExamSchema), "list_exams", { from_index: 0, limit: PAGE }, f),
  certificates: (f?: typeof fetch) => view(z.array(CertificateSchema), "list_certificates", { from_index: 0, limit: PAGE }, f),
  latest: (candidate: string, examId: string, f?: typeof fetch) =>
    view(CertificateSchema.nullable(), "latest_certificate", { candidate_model: candidate, exam_id: examId }, f),
};
