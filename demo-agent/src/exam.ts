/**
 * What this agent answers: one question per request, with an optional system
 * message, the way ordinary chat traffic arrives. PROCTOR's runner frames
 * each exam question differently and sends no fixed instruction (see
 * proctor-core's sitting module), so an honest agent cannot tell a sitting
 * from any other request, and neither does this one. Abuse is bounded by the
 * size and token caps here and the per-client rate limit in index.ts.
 */

export const ANSWER_INSTRUCTION =
  "You are taking a test. Think as needed, then put your final answer alone on the last line in the form: ANSWER: <answer>";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_QUESTION_CHARS = 16 * 1024;
/** The runner's own cap; nothing here needs more. */
export const MAX_TOKENS = 4096;
const DEFAULT_TOKENS = 1024;

export type ExamRequest = { system?: string; question: string; maxTokens: number; temperature?: number };

export type Parsed = { ok: true; request: ExamRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an OpenAI-style chat request: one user question, optionally after one system message. */
export function parseExamRequest(body: unknown): Parsed {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const { messages, max_tokens: maxTokens, temperature } = body;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 2) {
    return { ok: false, error: "expected one question, optionally after one system message" };
  }
  const list = messages as unknown[];
  const system = list.length === 2 ? list[0] : undefined;
  const user = list[list.length - 1];
  if (system !== undefined && (!isRecord(system) || system.role !== "system" || typeof system.content !== "string")) {
    return { ok: false, error: "the first of two messages must be a system message, as text" };
  }
  if (!isRecord(user) || user.role !== "user" || typeof user.content !== "string" || user.content.trim() === "") {
    return { ok: false, error: "the last message must be the question, as user text" };
  }
  const systemText = system === undefined ? undefined : (system.content as string);
  if (user.content.length > MAX_QUESTION_CHARS || (systemText?.length ?? 0) > MAX_QUESTION_CHARS) {
    return { ok: false, error: `a message is longer than ${MAX_QUESTION_CHARS} characters` };
  }
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) {
    return { ok: false, error: "max_tokens must be a positive integer" };
  }
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    return { ok: false, error: "temperature must be a number from 0 to 2" };
  }
  return {
    ok: true,
    request: {
      ...(systemText === undefined ? {} : { system: systemText }),
      question: user.content,
      maxTokens: Math.min((maxTokens as number | undefined) ?? DEFAULT_TOKENS, MAX_TOKENS),
      ...(temperature === undefined ? {} : { temperature: temperature as number }),
    },
  };
}
