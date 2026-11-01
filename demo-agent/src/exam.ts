/**
 * What this agent will answer: PROCTOR exam questions, and nothing else.
 * The runner sends exactly two messages, the fixed instruction and one
 * question (see proctor-core ANSWER_INSTRUCTION and exam-runner's
 * build_request_body), so anything else is refused before NEAR AI is called.
 */

export const ANSWER_INSTRUCTION =
  "You are taking a test. Think as needed, then put your final answer alone on the last line in the form: ANSWER: <answer>";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_QUESTION_CHARS = 16 * 1024;
/** The runner's own cap; nothing here needs more. */
export const MAX_TOKENS = 4096;
const DEFAULT_TOKENS = 1024;

export type ExamRequest = { question: string; maxTokens: number; temperature?: number };

export type Parsed = { ok: true; request: ExamRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an OpenAI-style chat request against the PROCTOR exam shape. */
export function parseExamRequest(body: unknown): Parsed {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  const { messages, max_tokens: maxTokens, temperature } = body;
  if (!Array.isArray(messages) || messages.length !== 2) {
    return { ok: false, error: "expected exactly two messages: the PROCTOR instruction and one question" };
  }
  const [system, user] = messages as unknown[];
  if (!isRecord(system) || system.role !== "system" || system.content !== ANSWER_INSTRUCTION) {
    return { ok: false, error: "this agent only sits PROCTOR exams; the system message must be the PROCTOR instruction" };
  }
  if (!isRecord(user) || user.role !== "user" || typeof user.content !== "string" || user.content.trim() === "") {
    return { ok: false, error: "the second message must be the question, as user text" };
  }
  if (user.content.length > MAX_QUESTION_CHARS) {
    return { ok: false, error: `the question is longer than ${MAX_QUESTION_CHARS} characters` };
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
      question: user.content,
      maxTokens: Math.min((maxTokens as number | undefined) ?? DEFAULT_TOKENS, MAX_TOKENS),
      ...(temperature === undefined ? {} : { temperature: temperature as number }),
    },
  };
}
