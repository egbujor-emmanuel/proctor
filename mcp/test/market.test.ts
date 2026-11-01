import { describe, expect, it, vi } from "vitest";

import { createMarketReader, MarketError } from "../src/market.js";
import { marketAgent } from "./fixtures.js";

function reader(fetchImpl: typeof fetch) {
  return createMarketReader({ baseUrl: "https://market.example/", fetch: fetchImpl });
}

describe("createMarketReader", () => {
  it("searches the public catalog and returns the exact handle", async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ agents: [marketAgent({ handle: "dailybriefer-pro" }), marketAgent({ handle: "DailyBriefer" })] }),
    );
    const agent = await reader(fetchMock as unknown as typeof fetch).findByHandle("dailybriefer");
    expect(agent?.handle).toBe("DailyBriefer");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://market.example/v1/agents?q=dailybriefer&limit=50");
  });

  it("returns null when only near-matches come back", async () => {
    const fetchMock = (async () => Response.json({ agents: [marketAgent({ handle: "dailybriefer-pro" })] })) as unknown as typeof fetch;
    expect(await reader(fetchMock).findByHandle("dailybriefer")).toBeNull();
  });

  it("encodes the handle in the query", async () => {
    const fetchMock = vi.fn(async (_url: string) => Response.json({ agents: [] }));
    await reader(fetchMock as unknown as typeof fetch).findByHandle("a b&c");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("q=a%20b%26c");
  });

  it("reports failures instead of saying the agent does not exist", async () => {
    const http503 = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(reader(http503).findByHandle("x")).rejects.toThrow(MarketError);
    const odd = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    await expect(reader(odd).findByHandle("x")).rejects.toThrow("unexpected shape");
  });
});
