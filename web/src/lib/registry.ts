// Read-only view calls to the PROCTOR registry from the browser. NEAR RPC
// allows cross-origin requests, view calls need no keys, and every response
// is validated before the page shows it.

// zod/mini: the same validation at about a quarter of zod's bundle size.
import * as z from "zod/mini";

import { REGISTRY, RPC_URLS } from "./config";

const RPC_TIMEOUT_MS = 10_000;
/** The contract's own page-size cap for list views. */
const PAGE = 100;

const count = z.int().check(z.nonnegative());
const u32 = z.int().check(z.nonnegative(), z.maximum(2 ** 32 - 1));
const bps = z.int().check(z.nonnegative(), z.maximum(10_000));
// u64 nanosecond timestamps (about 1.8e18 today) are above 2^53, so they are
// not "safe" integers and z.int() would reject them. They are accurate to
// well under a millisecond, which is all the site displays.
const timestampNs = z.number().check(z.nonnegative());

const StatusSchema = z.union([
  z.literal("Active"),
  z.object({ Suspended: z.object({ reason: z.string(), at_ns: timestampNs }) }),
  z.object({ Revoked: z.object({ reason: z.string(), at_ns: timestampNs }) }),
]);

export const CertificateSchema = z
  .object({
    cert_id: count,
    exam_id: z.string(),
    exam_commitment: z.string(),
    candidate_model: z.string(),
    // Agents only; absent on certificates from the first registry.
    candidate_endpoint: z.optional(z.nullable(z.string())),
    runner_hash: z.string(),
    score_bps: bps,
    correct: u32,
    total: z.int().check(z.minimum(1), z.maximum(2 ** 32 - 1)),
    issued_at_ns: timestampNs,
    last_verified_ns: timestampNs,
    retests_passed: u32,
    status: StatusSchema,
    requested_by: z.string(),
    sitting_id: count,
    response_ids_hash: z.string(),
    response_count: u32,
    retest_in_flight: z.optional(z.nullable(count)),
  })
  .check(z.refine((c) => c.correct <= c.total, "correct exceeds total"));

export const ExamSchema = z.object({
  exam_id: z.string(),
  author: z.string(),
  title: z.string(),
  commitment: z.string(),
  pass_mark_bps: bps,
  question_count: u32,
  active: z.boolean(),
  sittings: count,
});

export const ConfigSchema = z.object({
  owner: z.string(),
  outlayer_account: z.string(),
  runner_hash: z.string(),
  /** A proposed runner build waiting out the 24-hour timelock. */
  pending_runner: z.optional(z.nullable(z.object({ runner_hash: z.string(), effective_at_ns: timestampNs }))),
  exams: u32,
  certificates: u32,
  next_sitting_id: count,
});

export type Certificate = z.infer<typeof CertificateSchema>;
export type Exam = z.infer<typeof ExamSchema>;
export type RegistryConfig = z.infer<typeof ConfigSchema>;

export class RegistryError extends Error {
  override name = "RegistryError";
}

const RpcSchema = z.object({
  result: z.optional(
    z.object({
      result: z.optional(z.array(z.int().check(z.minimum(0), z.maximum(255)))),
      error: z.optional(z.string()),
    }),
  ),
  error: z.optional(z.looseObject({ name: z.optional(z.string()), message: z.optional(z.string()) })),
});

/** Base64 of the UTF-8 bytes, built in chunks so large arguments cannot overflow the call stack. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * POSTs `body` to the first RPC node, moving to the next only when one fails, so the fallback
 * nodes are touched only during an outage. Fails only when every node failed.
 */
async function postFirst(body: string, fetchImpl: typeof fetch): Promise<Response> {
  let first: unknown;
  for (const url of RPC_URLS) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) throw new RegistryError(`NEAR RPC answered HTTP ${response.status}.`);
      return response;
    } catch (error) {
      first ??= error;
    }
  }
  if (first instanceof RegistryError) throw first;
  const timedOut = first instanceof DOMException && first.name === "TimeoutError";
  throw new RegistryError(
    timedOut ? "NEAR testnet took too long to answer. Try again." : "Could not reach NEAR testnet. Check your connection and try again.",
    { cause: first },
  );
}

async function rpc(method: string, args: Record<string, unknown>, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await postFirst(
    JSON.stringify({
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
    fetchImpl,
  );

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new RegistryError("NEAR RPC sent a response that is not JSON.", { cause });
  }
  const envelope = RpcSchema.safeParse(body);
  if (!envelope.success) throw new RegistryError(`Unexpected NEAR RPC response to ${method}.`, { cause: envelope.error });
  const { result, error } = envelope.data;
  if (error) throw new RegistryError(`NEAR RPC refused ${method}: ${error.message ?? error.name ?? "unknown error"}.`, { cause: error });
  if (result?.error) throw new RegistryError(`The registry rejected ${method}: ${result.error}`);
  if (!result?.result) throw new RegistryError(`The registry returned nothing for ${method}.`);

  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
  } catch (cause) {
    throw new RegistryError(`The registry's ${method} result is not JSON.`, { cause });
  }
}

const AccountSchema = z.object({ result: z.optional(z.object({ code_hash: z.string() })), error: z.optional(z.looseObject({ message: z.optional(z.string()) })) });

/** The base58 SHA-256 of the code deployed on `accountId`, as NEAR reports it. */
export async function accountCodeHash(accountId: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await postFirst(
    JSON.stringify({ jsonrpc: "2.0", id: "proctor-web", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
    fetchImpl,
  );
  const parsed = AccountSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !parsed.data.result) {
    throw new RegistryError(`NEAR RPC did not return ${accountId}'s code hash${parsed.success && parsed.data.error?.message ? `: ${parsed.data.error.message}` : "."}`);
  }
  return parsed.data.result.code_hash;
}

/** One view call, validated against `schema`. */
export async function view<T>(
  schema: z.ZodMiniType<T>,
  method: string,
  args: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const parsed = schema.safeParse(await rpc(method, args, fetchImpl));
  if (!parsed.success) throw new RegistryError(`The registry returned an unexpected ${method} result.`, { cause: parsed.error });
  return parsed.data;
}

export interface Listing<T> {
  rows: T[];
  /** Rows the registry returned that failed validation and are not shown. */
  skipped: number;
}

/**
 * Every row of a paginated list view. Rows are validated one by one, so a
 * single malformed or newer-format row is counted and skipped instead of
 * blanking the whole list.
 */
async function listAll<T>(schema: z.ZodMiniType<T>, method: string, fetchImpl: typeof fetch): Promise<Listing<T>> {
  const rows: T[] = [];
  let skipped = 0;
  for (let from = 0; ; from += PAGE) {
    const page = await rpc(method, { from_index: from, limit: PAGE }, fetchImpl);
    if (!Array.isArray(page)) throw new RegistryError(`The registry's ${method} result is not a list.`);
    for (const raw of page) {
      const row = schema.safeParse(raw);
      if (row.success) rows.push(row.data);
      else skipped += 1;
    }
    if (page.length < PAGE) return { rows, skipped };
  }
}

export const registry = {
  config: (f: typeof fetch = fetch) => view(ConfigSchema, "get_config", {}, f),
  exams: (f: typeof fetch = fetch) => listAll(ExamSchema, "list_exams", f),
  certificates: (f: typeof fetch = fetch) => listAll(CertificateSchema, "list_certificates", f),
  latest: (candidate: string, examId: string, f: typeof fetch = fetch) =>
    view(z.nullable(CertificateSchema), "latest_certificate", { candidate_model: candidate, exam_id: examId }, f),
};
