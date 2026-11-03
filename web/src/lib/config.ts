// Where the live data comes from. Everything here is public and read-only.

export const NETWORK = "testnet";
export const REGISTRY = "registry-v2.attrito.testnet";
/** Asked in parallel; the first good answer wins, so one slow node cannot stall the page. */
export const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"] as const;
// NEAR Rocks (FastNear): renders for people and for automated readers alike.
export const EXPLORER = "https://testnet.near.rocks";
export const RUNNER_RELEASES = "https://github.com/egbujor-emmanuel/proctor-runner/releases";
/** Released runner builds by SHA-256, as pinned on chain. */
const RUNNER_VERSIONS: Record<string, string> = {
  "9a41b2354d7c508536343dc3585e07cb3a8e579c358126ba3f01a88489b9dde4": "v0.2.0",
  "96abb4a702c2ec060604ef4040a54dce95b57bffc872b3a091016ab57cd5ddae": "v0.3.0",
};

/** The release name for a runner hash, if it is a known release. */
export function runnerVersion(hash: string): string | undefined {
  return RUNNER_VERSIONS[hash];
}

/** The release page for a runner hash, or the list of releases. */
export function runnerRelease(hash: string): string {
  const version = runnerVersion(hash);
  return version ? `${RUNNER_RELEASES}/tag/${version}` : RUNNER_RELEASES;
}

/** "3 Nov 2026, 11:58 UTC": the same on the server and in every browser, so hydration matches. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAccount(account: string): string {
  return `${EXPLORER}/account/${account}`;
}

/** The sitting transaction that issued each certificate on this registry. */
export const CERT_TXS: Record<number, string> = {
  0: "4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1",
  1: "9Jwx3jXp8We4a77VVBNv7qGLKpL48UC3zF8uf7CX9yT5",
};
