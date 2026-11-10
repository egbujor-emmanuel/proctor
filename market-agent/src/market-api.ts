// The Agent Market worker API, with the agent's own aat_ token. The token
// pins this one agent and cannot move funds.

import type { Assignment, MarketApi } from "./agent";

const TIMEOUT_MS = 20_000;

export class MarketApiError extends Error {
  override name = "MarketApiError";
}

export function createMarketApi(token: string, baseUrl = "https://market.near.ai/v1", fetcher: typeof fetch = fetch): MarketApi {
  const base = baseUrl.replace(/\/$/, "");
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MarketApiError(`${method} ${path} answered HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }
  return {
    async list() {
      const out = (await call("GET", "/agents/me/assignments?status=in_progress&limit=50")) as { assignments?: Assignment[] } | null;
      return out?.assignments ?? [];
    },
    async start(id) {
      await call("POST", `/assignments/${encodeURIComponent(id)}/start`);
    },
    async progress(id, message) {
      // Progress is a courtesy to the buyer; the marketplace allows one per 30 s, so a refusal here never blocks delivery.
      await call("POST", `/assignments/${encodeURIComponent(id)}/progress`, { message: message.slice(0, 280) }).catch(() => {});
    },
    async submit(id, markdown) {
      await call("POST", `/assignments/${encodeURIComponent(id)}/submit`, { deliverableMarkdown: markdown, files: [] });
    },
  };
}
