/**
 * PROCTOR's demo agent: an OpenAI-compatible endpoint that sits PROCTOR exams
 * through NEAR AI with whichever model this deployment is set to. Redeploying
 * with MODE=weak is the "quiet model swap" that surprise re-tests must catch.
 *
 * NEAR AI's reply is passed through untouched, so the completion ids the
 * registry hashes are NEAR AI's own and stay verifiable. GET / says, in
 * public, which model is answering right now.
 */

import { ANSWER_INSTRUCTION, MAX_BODY_BYTES, parseExamRequest, type ExamRequest } from "./exam";

export interface Env {
  MODE: string;
  NEARAI_API_KEY: string;
  /** Workers Rate Limiting binding (wrangler.toml); absent in tests that don't need it. */
  LIMITER?: RateLimit;
  /**
   * Test deployments only: hold each exam request this many ms, then fail it
   * without calling NEAR AI, to show what a stalling endpoint does to a
   * sitting. Such a deployment needs no API key. Unset (the demo agent) means
   * no stall.
   */
  STALL_MS?: string;
}

/** The longest stall a test deployment may ask for. */
export const MAX_STALL_MS = 60_000;

/** The configured stall in ms, 0 when unset, or undefined when the value is invalid. */
export function stallOf(env: Pick<Env, "STALL_MS">): number | undefined {
  if (env.STALL_MS === undefined || env.STALL_MS === "") return 0;
  const ms = Number(env.STALL_MS);
  return Number.isInteger(ms) && ms >= 0 && ms <= MAX_STALL_MS ? ms : undefined;
}

export const MODELS = {
  strong: "anthropic/claude-sonnet-5-5",
  weak: "openai/gpt-5.4-nano",
} as const;

type Mode = keyof typeof MODELS;

const NEAR_AI_COMPLETIONS = "https://cloud-api.near.ai/v1/chat/completions";
const SOURCE = "https://github.com/egbujor-emmanuel/proctor/tree/master/demo-agent";
/** Under the runner's 165 s run deadline, so a slow model fails the call, not the run. */
const UPSTREAM_TIMEOUT_MS = 120_000;

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const fail = (status: number, message: string, headers?: HeadersInit) => json({ error: { message } }, status, headers);

function modeOf(env: Env): Mode | undefined {
  return env.MODE === "strong" || env.MODE === "weak" ? env.MODE : undefined;
}

function about(mode: Mode, stallMs: number): Response {
  return json({
    name: "proctor-demo-agent",
    purpose:
      "A demo candidate for PROCTOR. It is certified while it answers with the strong model; its owner then redeploys it with the weak one, and PROCTOR's surprise re-tests suspend and then revoke the certificate.",
    mode,
    model: MODELS[mode],
    ...(stallMs > 0 && { stall_ms: stallMs, note: "A test deployment: it holds every exam request this long, then fails it without answering." }),
    models: MODELS,
    endpoint: "POST /v1/chat/completions",
    accepts: "Only PROCTOR exam requests: the PROCTOR instruction as the system message and one question.",
    instruction: ANSWER_INSTRUCTION,
    source: SOURCE,
  });
}

/** Reads the body with a hard size cap, stopping as soon as it is exceeded. */
async function readCapped(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function answer(exam: ExamRequest, mode: Mode, apiKey: string): Promise<Response> {
  const upstream = await fetch(NEAR_AI_COMPLETIONS, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODELS[mode],
      messages: [
        { role: "system", content: ANSWER_INSTRUCTION },
        { role: "user", content: exam.question },
      ],
      max_tokens: exam.maxTokens,
      ...(exam.temperature === undefined ? {} : { temperature: exam.temperature }),
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  // Status and body pass through, so the runner sees NEAR AI's own errors
  // (its retry on a refused temperature depends on that) and completion ids.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
  });
}

async function completions(request: Request, env: Env, mode: Mode, stallMs: number): Promise<Response> {
  const text = await readCapped(request);
  if (text === undefined) return fail(413, `request body is larger than ${MAX_BODY_BYTES} bytes`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, "body is not valid JSON");
  }
  const parsed = parseExamRequest(body);
  if (!parsed.ok) return fail(400, parsed.error);
  if (stallMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, stallMs));
    return fail(504, `stalled for ${stallMs} ms on purpose (test deployment)`);
  }
  try {
    return await answer(parsed.request, mode, env.NEARAI_API_KEY);
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    console.error("NEAR AI call failed", e);
    return fail(timedOut ? 504 : 502, timedOut ? "the model took too long to answer" : "could not reach NEAR AI");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mode = modeOf(env);
    if (!mode) return fail(500, 'MODE must be "strong" or "weak"');
    const stallMs = stallOf(env);
    if (stallMs === undefined) return fail(500, `STALL_MS must be a whole number of ms from 0 to ${MAX_STALL_MS}`);
    if (!env.NEARAI_API_KEY && stallMs === 0) return fail(500, "NEARAI_API_KEY is not set");

    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "use GET", { allow: "GET, HEAD" });
      return about(mode, stallMs);
    }
    if (pathname === "/v1/chat/completions") {
      if (request.method !== "POST") return fail(405, "use POST", { allow: "POST" });
      const client = request.headers.get("cf-connecting-ip") ?? "unknown";
      // Fail closed: without the limiter this would be an open proxy to a paid key.
      if (!env.LIMITER) return fail(500, "rate limiter is not configured");
      if (!(await env.LIMITER.limit({ key: client })).success) {
        return fail(429, "too many requests from this client; try again in a minute", { "retry-after": "60" });
      }
      return completions(request, env, mode, stallMs);
    }
    return fail(404, "not found");
  },
} satisfies ExportedHandler<Env>;
