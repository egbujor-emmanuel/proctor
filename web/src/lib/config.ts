// Where the live data comes from. Everything here is public and read-only.

export const NETWORK = "testnet";
export const REGISTRY = "registry.attrito.testnet";
export const RPC_URL = "https://rpc.testnet.fastnear.com";
export const EXPLORER = "https://explorer.testnet.near.org";
export const RUNNER_RELEASE = "https://github.com/egbujor-emmanuel/proctor-runner/releases/tag/v0.1.0";
export const MARKET = "https://market.near.ai";

export function explorerTx(hash: string): string {
  return `${EXPLORER}/transactions/${hash}`;
}

export function explorerAccount(account: string): string {
  return `${EXPLORER}/accounts/${account}`;
}

/** The transaction that issued certificate 0, the first PROCTOR certificate. */
export const FIRST_CERT_TX = "JAtLV29Xd6DDnomfUURN11R7iqvk6ya8F71baC6ww1Jp";
