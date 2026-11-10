// Where the live data comes from. Everything here is public and read-only.

export const NETWORK = "testnet";
export const REGISTRY = "registry-v2.attrito.testnet";
/** Asked in parallel; the first good answer wins, so one slow node cannot stall the page. */
export const RPC_URLS = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"] as const;
// NEAR Rocks (FastNear): renders for people and for automated readers alike.
export const EXPLORER = "https://testnet.near.rocks";
export const RUNNER_RELEASES = "https://github.com/egbujor-emmanuel/proctor-runner/releases";
/** The sentinel Worker: hourly surprise re-tests, and re-tests ordered from this page (POST /retest). */
export const SENTINEL = "https://proctor-sentinel.attrito.workers.dev";
/** Released runner builds by SHA-256, as pinned on chain. */
const RUNNER_VERSIONS: Record<string, string> = {
  "9a41b2354d7c508536343dc3585e07cb3a8e579c358126ba3f01a88489b9dde4": "v0.2.0",
  "96abb4a702c2ec060604ef4040a54dce95b57bffc872b3a091016ab57cd5ddae": "v0.3.0",
  "4ee3e3359cd1f0d44ae2e47b3f9e287542449a19103ce56eab3ea0882a522ebe": "v0.4.0",
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
  2: "2gk5NcRM2b4DVewk6K9JhBqNzuj3SDsEH1MnXW3bw6Au",
  3: "5ZJcQyHHvYFtNwBE61nn99yWDNYwnN7dZsPVzYKV9UD1",
  4: "7fHjeDpb6ViT2gQkP4PoKLvwPfDyGb4NWo8Jyk16T68z",
  5: "7DbiRqHe9iKcLTzQS4DxL4YrgL4UL2Ndin4pJ2qbNdi9",
  6: "Adax52WqYVVEacpiHmsPCwHz9J2dgoWfGSvVWB6obJ8R",
  7: "EucYzJDspt2gB2goa9n9ffXc5Ttq9qfGr28aJJKKuoVg",
  8: "6Bk7545MsngUfcAi32Sg6ybANJ6pc7s98zCKHs6CJ9SN",
  9: "51z8MrLmKJmkXRnvXaVNTnYAnTMAUGkFwWeyVeZ672Ao",
  10: "8w7DkNWtNGVdWGwJU16nbFy1JqLDLzywAzL6ocdASC9w",
  11: "FNNyczZZFHz1gWfjXXPNHiwstmEYdQgJ6wb6Cs9rcmRU",
  12: "5PdE1geg4bRUjq8TxSHLUwKdFLomsFQ11nKfsqixWBgy",
  13: "DFpyNLNS9t43Z3g6bwizunQppC18GPRCxsvLGZhNZkhM",
  14: "J69FrsQ155dcPtv2vSeeZaAaFS8KrqNxZFacHdVKcJoj",
  15: "Bjco85X2T39BFPetQdpcErUmd2e8wdVowNXG98JRK3Gh",
};
