#!/usr/bin/env bash
# Builds the exam runner for OutLayer reproducibly: source paths are remapped,
# so the wasm (and its SHA-256, which the registry pins) does not depend on
# where the repo or the cargo registry live, or whose machine built it.
# CI rebuilds with this script and checks the hash against the release.
set -euo pipefail
cd "$(dirname "$0")/.."

RUSTC_VERSION="1.99.1"
# A toolchain name for rustup; override it to pick a host (for example
# RUNNER_TOOLCHAIN=stable-x86_64-pc-windows-gnu) as long as it is $RUSTC_VERSION.
toolchain="${RUNNER_TOOLCHAIN:-$RUSTC_VERSION}"
if ! rustc "+$toolchain" -V | grep -q "^rustc $RUSTC_VERSION "; then
  echo "error: toolchain $toolchain is not rustc $RUSTC_VERSION; the hash would differ" >&2
  exit 1
fi
repo="$(pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
remaps=("$repo=/proctor" "$cargo_home=/cargo")
# On Windows rustc sees native paths (C:\Users\...), so remap those too.
if command -v cygpath >/dev/null; then
  remaps+=("$(cygpath -w "$repo")=/proctor" "$(cygpath -w "$cargo_home")=/cargo")
fi
# Paths may contain spaces, so pass flags 0x1f-separated rather than in RUSTFLAGS.
flags=()
for remap in "${remaps[@]}"; do flags+=("--remap-path-prefix=$remap"); done
CARGO_ENCODED_RUSTFLAGS="$(IFS=$''; echo "${flags[*]}")"
export CARGO_ENCODED_RUSTFLAGS
unset RUSTFLAGS

cargo "+$toolchain" build -p exam-runner --target wasm32-wasip2 --release --locked
wasm=target/wasm32-wasip2/release/exam-runner.wasm
if grep -a -q -E '[A-Za-z]:.Users|/home/|/Users/' "$wasm"; then
  echo "error: $wasm still embeds a local path" >&2
  exit 1
fi
sha256sum "$wasm" | cut -d' ' -f1
