#!/usr/bin/env bash
# Builds the registry contract with source paths remapped, so the deployed
# code carries no local paths and its hash can be reproduced. CI builds the
# deployed wasm with this script on Linux and checks the hash against
# contracts/registry/RELEASE.sha256; compare it with the on-chain code hash.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="$(pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
case "$repo$cargo_home" in
  *" "*) echo "error: paths contain spaces; build on Linux (CI) instead" >&2; exit 1 ;;
esac
# cargo-near adds its own flags to RUSTFLAGS, so the remaps go there too.
export RUSTFLAGS="--remap-path-prefix=$repo=/proctor --remap-path-prefix=$cargo_home=/cargo"

(cd contracts/registry && cargo near build non-reproducible-wasm --no-abi)
wasm=contracts/registry/target/near/proctor_registry.wasm
if grep -a -q -E '[A-Za-z]:\Users|/home/|/Users/' "$wasm"; then
  echo "error: $wasm still embeds a local path" >&2
  exit 1
fi
sha256sum "$wasm" | cut -d' ' -f1
