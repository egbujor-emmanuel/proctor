// Where the live data comes from. Everything here is public and read-only.

export const NETWORK = "testnet";
export const REGISTRY = "registry-v2.attrito.testnet";
export const RPC_URL = "https://rpc.testnet.fastnear.com";
// NEAR Rocks (FastNear): renders for people and for automated readers alike.
export const EXPLORER = "https://testnet.near.rocks";
export const RUNNER_RELEASE = "https://github.com/egbujor-emmanuel/proctor-runner/releases/tag/v0.2.0";

export function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function explorerAccount(account: string): string {
  return `${EXPLORER}/account/${account}`;
}

/** The transaction that issued certificate 0 on this registry. */
export const FIRST_CERT_TX = "4ewFE77FvYXLTzA5dfBWWanntAQeyfFEXAvZFo6LaoR1";
