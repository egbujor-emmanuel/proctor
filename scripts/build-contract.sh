#!/usr/bin/env bash
# Builds a NEAR contract with source paths remapped, so the deployed code
# carries no local paths and its hash can be reproduced. CI builds deployed
# wasm with this on Linux (a Windows build keeps backslashes after the
# remapped prefix, so its hash differs) and checks it against the crate's
# RELEASE.sha256; compare it with the on-chain code hash.
#
#   scripts/build-contract.sh <crate dir> <wasm name>
set -euo pipefail
cd "$(dirname "$0")/.."
crate="${1:?usage: build-contract.sh <crate dir> <wasm name>}"
name="${2:?usage: build-contract.sh <crate dir> <wasm name>}"

repo="$(pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
# cargo-near ignores RUSTFLAGS from the environment and reads its own --env
# option, whose default is "-C link-arg=-s"; keep that and add the remaps.
# 0x1f-separated, so paths with spaces stay whole.
flags=(-C link-arg=-s "--remap-path-prefix=$repo=/proctor" "--remap-path-prefix=$cargo_home=/cargo")
encoded="$(IFS=$''; echo "${flags[*]}")"

(cd "$crate" && cargo near build non-reproducible-wasm --no-abi --env "CARGO_ENCODED_RUSTFLAGS=$encoded")
wasm="$crate/target/near/$name.wasm"
if grep -a -q -E '[A-Za-z]:.Users|/home/|/Users/' "$wasm"; then
  echo "error: $wasm still embeds a local path" >&2
  exit 1
fi
sha256sum "$wasm" | cut -d' ' -f1
