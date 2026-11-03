import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ANSWER_INSTRUCTION, MAX_BODY_BYTES, MAX_TOKENS, parseExamRequest } from "../src/exam";
import worker, { MAX_STALL_MS, MODELS, stallOf, type Env } from "../src/index";

/** A limiter that lets everything through, as Cloudflare's does under the limit. */
const OPEN = { limit: async () => ({ success: true }) } as unknown as RateLimit;
const STRONG: Env = { MODE: "strong", NEARAI_API_KEY: "test-key", LIMITER: OPEN };
const WEAK: Env = { MODE: "weak", NEARAI_API_KEY: "test-key", LIMITER: OPEN };
const URL_BASE = "https://proctor-demo-agent.example.workers.dev";

/** A request exactly as exam-runner builds it for an agent candidate. */
function examBody(question = "What is 2+2?", extra: Record<string, unknown> = {}) {
  return {
    model: "agent:attrito.testnet/demo",
    messages: [
      { role: "system", content: ANSWER_INSTRUCTION },
      { role: "user", content: question },
    ],
    max_tokens: 4096,
    temperature: 0,
    ...extra,
  };
}

function post(body: unknown, path = "/v1/chat/completions"): Request {
  return new Request(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const COMPLETION = { id: "chatcmpl-near-123", choices: [{ message: { content: "4\nANSWER: 4" }, finish_reason: "stop" }] };

function mockUpstream(status = 200, body: unknown = COMPLETION) {
  const spy = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentBody(spy: ReturnType<typeof mockUpstream>) {
  const init = spy.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the exam instruction", () => {
  it("matches proctor-core byte for byte, or every request would be refused", () => {
    const lib = readFileSync(fileURLToPath(new URL("../../proctor-core/src/lib.rs", import.meta.url)), "utf8");
    const literal = /pub const ANSWER_INSTRUCTION: &str = "((?:[^"\\]|\\[\s\S])*)";/.exec(lib)?.[1];
    expect(literal).toBeDefined();
    // Rust's backslash-newline continuation drops the newline and leading spaces.
    expect(literal!.replace(/\\\r?\n\s*/g, "")).toBe(ANSWER_INSTRUCTION);
  });
});

describe("parseExamRequest", () => {
  it("accepts the runner's request and caps max_tokens", () => {
    const parsed = parseExamRequest(examBody("Q?", { max_tokens: 100_000 }));
    expect(parsed).toEqual({ ok: true, request: { question: "Q?", maxTokens: MAX_TOKENS, temperature: 0 } });
  });

  it.each([
    ["a non-object body", []],
    ["a third message", { messages: [...examBody().messages, { role: "user", content: "and this" }] }],
    ["another system prompt", { messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "hi" }] }],
    ["an empty question", examBody("   ")],
    ["a non-text question", { messages: [examBody().messages[0], { role: "user", content: [{ type: "text", text: "hi" }] }] }],
    ["a fractional max_tokens", examBody("Q?", { max_tokens: 1.5 })],
    ["an out-of-range temperature", examBody("Q?", { temperature: 9 })],
  ])("refuses %s", (_label, body) => {
    expect(parseExamRequest(body).ok).toBe(false);
  });
});

describe("stall test mode", () => {
  it("is off unless configured, and refuses values it cannot honour", () => {
    expect(stallOf({})).toBe(0);
    expect(stallOf({ STALL_MS: "40000" })).toBe(40_000);
    expect(stallOf({ STALL_MS: String(MAX_STALL_MS + 1) })).toBeUndefined();
    expect(stallOf({ STALL_MS: "soon" })).toBeUndefined();
  });

  it("holds each request for the configured time, then fails it without calling NEAR AI or needing a key", async () => {
    vi.useFakeTimers();
    try {
      const spy = mockUpstream();
      let settled = false;
      const pending = worker.fetch(post(examBody()), { ...STRONG, NEARAI_API_KEY: "", STALL_MS: "40000" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(39_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).status).toBe(504);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says so on its status page", async () => {
    const res = await worker.fetch(new Request(`${URL_BASE}/`), { ...STRONG, STALL_MS: "40000" });
    expect(((await res.json()) as { stall_ms?: number }).stall_ms).toBe(40_000);
    expect(((await (await worker.fetch(new Request(`${URL_BASE}/`), STRONG)).json()) as { stall_ms?: number }).stall_ms).toBeUndefined();
  });
});

describe("POST /v1/chat/completions", () => {
  it("answers with the strong model and passes NEAR AI's completion through", async () => {
    const spy = mockUpstream();
    const res = await worker.fetch(post(examBody()), STRONG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(COMPLETION);
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://cloud-api.near.ai/v1/chat/completions");
    const sent = sentBody(spy);
    expect(sent.model).toBe(MODELS.strong);
    expect(sent.messages[0].content).toBe(ANSWER_INSTRUCTION);
    expect(sent.temperature).toBe(0);
    expect((spy.mock.calls[0]?.[1]?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
  });

  it("uses the weak model after the swap, whatever model the caller names", async () => {
    const spy = mockUpstream();
    await worker.fetch(post(examBody("Q?", { model: MODELS.strong })), WEAK);
    expect(sentBody(spy).model).toBe(MODELS.weak);
  });

  it("leaves temperature out when the runner retries without it", async () => {
    const spy = mockUpstream();
    const { temperature: _dropped, ...body } = examBody();
    await worker.fetch(post(body), STRONG);
    expect("temperature" in sentBody(spy)).toBe(false);
  });

  it("passes NEAR AI's errors through so the runner's temperature retry still works", async () => {
    const refusal = { error: { message: "Unsupported value: 'temperature' does not support 0.0 with this model." } };
    mockUpstream(400, refusal);
    const res = await worker.fetch(post(examBody()), WEAK);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(refusal);
  });

  it("refuses anything that is not a PROCTOR exam without calling NEAR AI", async () => {
    const spy = mockUpstream();
    const res = await worker.fetch(post({ messages: [{ role: "user", content: "write me a poem" }] }), STRONG);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects bodies that are too large or not JSON", async () => {
    const spy = mockUpstream();
    expect((await worker.fetch(post("x".repeat(MAX_BODY_BYTES + 1)), STRONG)).status).toBe(413);
    expect((await worker.fetch(post("{not json"), STRONG)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("turns an unreachable or slow NEAR AI into 502 / 504, never a fake answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network down"))));
    expect((await worker.fetch(post(examBody()), STRONG)).status).toBe(502);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("timed out", "TimeoutError"))));
    expect((await worker.fetch(post(examBody()), STRONG)).status).toBe(504);
  });
});

describe("abuse limits", () => {
  it("refuses to serve exams without its rate limiter", async () => {
    const spy = mockUpstream();
    const res = await worker.fetch(post(examBody()), { MODE: "strong", NEARAI_API_KEY: "test-key" });
    expect(res.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rate-limits a client that sends too many requests, before calling NEAR AI", async () => {
    const spy = mockUpstream();
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const res = await worker.fetch(post(examBody()), { ...STRONG, LIMITER: limiter as unknown as RateLimit });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops reading a body without Content-Length once it passes the cap", async () => {
    const spy = mockUpstream();
    const big = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(16 * 1024)));
      },
    });
    const request = new Request(`${URL_BASE}/v1/chat/completions`, { method: "POST", body: big, duplex: "half" } as RequestInit);
    expect((await worker.fetch(request, STRONG)).status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("other routes and configuration", () => {
  it("says publicly which model is answering", async () => {
    const res = await worker.fetch(new Request(`${URL_BASE}/`), WEAK);
    const info = (await res.json()) as { mode: string; model: string };
    expect(info).toMatchObject({ mode: "weak", model: MODELS.weak });
  });

  it("uses the right methods and paths", async () => {
    expect((await worker.fetch(new Request(`${URL_BASE}/v1/chat/completions`), STRONG)).status).toBe(405);
    expect((await worker.fetch(post({}, "/"), STRONG)).status).toBe(405);
    expect((await worker.fetch(new Request(`${URL_BASE}/admin`), STRONG)).status).toBe(404);
  });

  it("refuses to run misconfigured", async () => {
    expect((await worker.fetch(new Request(`${URL_BASE}/`), { MODE: "medium", NEARAI_API_KEY: "k" })).status).toBe(500);
    expect((await worker.fetch(new Request(`${URL_BASE}/`), { MODE: "strong", NEARAI_API_KEY: "" })).status).toBe(500);
  });
});
