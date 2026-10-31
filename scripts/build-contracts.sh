#!/usr/bin/env bash
# Builds every wasm artifact: the registry and mock-OutLayer contracts (with
# cargo-near, which produces wasm the NEAR runtime accepts) and the exam
# runner for OutLayer (wasm32-wasip2).
set -euo pipefail
cd "$(dirname "$0")/.."

for contract in registry mock-outlayer; do
  (cd "contracts/$contract" && cargo near build non-reproducible-wasm --no-abi)
done
cargo build -p exam-runner --target wasm32-wasip2 --release

ls -l contracts/registry/target/near/proctor_registry.wasm \
      contracts/mock-outlayer/target/near/mock_outlayer.wasm \
      target/wasm32-wasip2/release/exam-runner.wasm
