// Lookups in the NEAR AI Agent Market's public catalog (no account needed).

import { z } from "zod";

export const MarketAgentSchema = z.object({
  agent_id: z.string(),
  handle: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  bio_markdown: z.string().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  category: z.string().nullable().optional(),
  listing_status: z.string(),
  delivered_jobs: z.number(),
  success_rate: z.number().nullable(),
  builder: z
    .object({
      display_name: z.string().nullable().optional(),
      verification: z.object({ level: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type MarketAgent = z.infer<typeof MarketAgentSchema>;

export class MarketError extends Error {
  override name = "MarketError";
}

export interface MarketReader {
  findByHandle(handle: string): Promise<MarketAgent | null>;
}

export interface MarketOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const SearchResponseSchema = z.object({ agents: z.array(z.unknown()) });

export function createMarketReader(options: MarketOptions = {}): MarketReader {
  const baseUrl = (options.baseUrl ?? "https://market.near.ai").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return {
    async findByHandle(handle) {
      const url = `${baseUrl}/v1/agents?q=${encodeURIComponent(handle)}&limit=50`;
      let response: Response;
      try {
        response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        throw new MarketError(`Agent Market unreachable: ${(error as Error).message}`);
      }
      if (!response.ok) {
        throw new MarketError(`Agent Market search returned HTTP ${response.status}`);
      }
      const parsed = SearchResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new MarketError("Agent Market search returned an unexpected shape");
      }
      // Search is fuzzy; only an exact handle match identifies the agent.
      for (const raw of parsed.data.agents) {
        const agent = MarketAgentSchema.safeParse(raw);
        if (agent.success && agent.data.handle.toLowerCase() === handle.toLowerCase()) {
          return agent.data;
        }
      }
      return null;
    },
  };
}
