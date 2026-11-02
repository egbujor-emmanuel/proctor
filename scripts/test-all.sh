#!/usr/bin/env bash
# Runs every PROCTOR test suite from a clean checkout:
#   grading core + exam runner, registry contract, MCP server, and (on Linux
#   and macOS, where the NEAR sandbox node runs) the end-to-end sandbox tests.
set -euo pipefail
cd "$(dirname "$0")/.."

# The Windows GNU toolchain needs a MinGW without spaces in its path.
if [[ "${OS:-}" == "Windows_NT" && -d /c/Users/Public/mingw64/bin ]]; then
  export PATH="/c/Users/Public/mingw64/bin:$PATH"
fi

step() { printf '\n== %s\n' "$1"; }

step "grading core, exam runner and benchmark"
cargo test --workspace

step "registry contract"
(cd contracts/registry && cargo test)

step "MCP server"
(cd mcp && npm ci --silent && npm run -s typecheck && npm test)

step "demo agent (Cloudflare Worker)"
(cd demo-agent && npm ci --silent && npm run -s typecheck && npm test)

step "surprise re-test picker"
node --test scripts/retest/pick.test.mjs

step "website"
(cd web && npm ci --silent && npm run -s typecheck && npm run -s lint && npm test && npm run -s build)

if [[ "${OS:-}" == "Windows_NT" ]]; then
  step "sandbox tests skipped: the NEAR sandbox node has no Windows build (CI runs them on Linux)"
else
  step "sandbox tests (registry on a local NEAR node)"
  bash scripts/build-contracts.sh
  (cd contracts/sandbox-tests && cargo test -- --test-threads=2)
fi

step "all suites passed"
