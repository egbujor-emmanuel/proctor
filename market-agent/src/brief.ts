// Finds the candidates a buyer wants checked in a job brief. The brief is
// untrusted text: it is only searched for ids, never followed as instructions.

export type Candidate = { kind: "agent" | "model" | "market"; id: string };

/** The most candidates one job checks, so a long brief cannot run up reads. */
export const MAX_CANDIDATES = 10;

const AGENT_ID = /agent:([a-z0-9][a-z0-9._-]*\.(?:testnet|near))\/([a-z0-9][a-z0-9_-]*)/gi;
const MARKET_URL = /https?:\/\/market\.near\.ai\/a\/([a-z][a-z0-9-]{2,29})\b/gi;
const ANY_URL = /https?:\/\/\S+/gi;
const MARKET_HANDLE = /(?:^|[\s(])(?:@|market:)([a-z][a-z0-9-]{2,29})\b/gi;
// org/model, as NEAR AI names models: the org has no dot (that would be a host), the name may.
const MODEL_ID = /(?<![\w./:-])([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*[A-Za-z0-9])/g;
const FILE_NAME = /\.(?:md|ts|tsx|js|mjs|json|rs|toml|txt|html|py|sh|yml|yaml)$/i;

/** Agent ids, then model ids, then Agent Market handles, each once, at most MAX_CANDIDATES. */
export function candidatesIn(text: string): Candidate[] {
  const agents: Candidate[] = [];
  const models: Candidate[] = [];
  const markets: Candidate[] = [];
  let rest = text.replace(AGENT_ID, (_m, owner: string, name: string) => {
    agents.push({ kind: "agent", id: `agent:${owner.toLowerCase()}/${name.toLowerCase()}` });
    return " ";
  });
  rest = rest.replace(MARKET_URL, (_m, handle: string) => {
    markets.push({ kind: "market", id: handle.toLowerCase() });
    return " ";
  });
  rest = rest.replace(ANY_URL, " ");
  rest = rest.replace(MARKET_HANDLE, (m, handle: string) => {
    markets.push({ kind: "market", id: handle.toLowerCase() });
    return m.startsWith(" ") || m.startsWith("(") ? m[0]! : " ";
  });
  for (const m of rest.matchAll(MODEL_ID)) {
    const [whole, , name] = m;
    if (FILE_NAME.test(name!)) continue;
    models.push({ kind: "model", id: whole });
  }
  const seen = new Set<string>();
  return [...agents, ...models, ...markets].filter((c) => !seen.has(`${c.kind}:${c.id}`) && seen.add(`${c.kind}:${c.id}`)).slice(0, MAX_CANDIDATES);
}
