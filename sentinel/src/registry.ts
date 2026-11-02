// Keyless reads from the registry over NEAR JSON-RPC.

export interface Certificate {
  cert_id: number;
  candidate_model: string;
  exam_id: string;
  status: unknown;
  retest_in_flight: number | null;
  /** Quoted to a string on read: nanosecond timestamps exceed 2^53. */
  last_retest_requested_ns: string | null;
}

const PAGE = 100;
// Nanosecond fields are re-quoted before JSON.parse so they keep every digit.
const NS_FIELDS = /("(?:last_retest_requested_ns|requested_at_ns)"\s*:\s*)(\d+)/g;

async function rpc(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proctor-sentinel", method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC returned HTTP ${response.status} for ${method}`);
  const body = (await response.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
  if (!body || body.error || body.result === undefined) throw new Error(`NEAR RPC ${method} failed: ${JSON.stringify(body?.error ?? "no result")}`);
  return body.result;
}

export async function view<T>(rpcUrl: string, registry: string, method: string, args: object): Promise<T> {
  const result = (await rpc(rpcUrl, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: registry,
    method_name: method,
    args_base64: btoa(JSON.stringify(args)),
  })) as { result?: number[]; error?: string };
  if (!Array.isArray(result.result)) throw new Error(`view ${method} failed: ${result.error ?? "no result"}`);
  const text = new TextDecoder().decode(new Uint8Array(result.result)).replace(NS_FIELDS, '$1"$2"');
  return JSON.parse(text) as T;
}

export async function listCertificates(rpcUrl: string, registry: string): Promise<Certificate[]> {
  const all: Certificate[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = await view<Certificate[]>(rpcUrl, registry, "list_certificates", { from_index: from, limit: PAGE });
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** The chain's own clock (final block), in nanoseconds. */
export async function chainNowNs(rpcUrl: string): Promise<bigint> {
  const block = (await rpc(rpcUrl, "block", { finality: "final" })) as { header?: { timestamp_nanosec?: string } };
  const ns = block.header?.timestamp_nanosec;
  if (!ns || !/^\d+$/.test(ns)) throw new Error("could not read the chain's time");
  return BigInt(ns);
}
