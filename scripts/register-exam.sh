#!/usr/bin/env bash
# Seals an exam, stores it as an OutLayer secret, and registers it on chain.
# Every on-chain value (exam id, commitment, question count, pass mark) comes
# from proctor-seal, read from the same bytes that are stored, so they cannot
# drift apart.
#
#   NEARAI_API_KEY=... scripts/register-exam.sh <exam.json> <secrets-profile> [title]
#
# Environment (defaults in brackets):
#   AUTHOR     account that owns the secret and the exam [attrito.testnet]
#   REGISTRY   registry contract [registry.attrito.testnet]
#   NETWORK    testnet or mainnet [testnet]
#   NEARAI_API_KEY  key the runner uses to call NEAR AI (required)
#
# The secret is locked to the registry's current runner build (--wasm-hash)
# and to calls that come through the registry (--via): any account may pay
# for a sitting, but nothing else can read the exam.
set -euo pipefail
cd "$(dirname "$0")/.."

exam_file="${1:?usage: register-exam.sh <exam.json> <secrets-profile> [title]}"
profile="${2:?usage: register-exam.sh <exam.json> <secrets-profile> [title]}"
author="${AUTHOR:-attrito.testnet}"
registry="${REGISTRY:-registry.attrito.testnet}"
network="${NETWORK:-testnet}"
: "${NEARAI_API_KEY:?set NEARAI_API_KEY to the key the runner should use}"

if [[ "${OS:-}" == "Windows_NT" && -d /c/Users/Public/mingw64/bin ]]; then
  export PATH="/c/Users/Public/mingw64/bin:$PATH"
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

summary="$(cargo run -q -p proctor-core --bin proctor-seal -- "$exam_file" "$workdir/exam.json" 2>/dev/null)"
field() { node -e 'console.log(JSON.parse(process.argv[1])[process.argv[2]])' "$summary" "$1"; }
exam_id="$(field exam_id)"
title="${3:-$exam_id}"

runner_hash="$(near contract call-function as-read-only "$registry" get_config json-args '{}' \
  network-config "$network" now 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const json = s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
      console.log(JSON.parse(json).runner_hash);
    });')"

echo "exam:     $exam_id ($(field question_count) questions, pass mark $(field pass_mark_bps) bps)"
echo "commit:   $(field commitment)"
echo "runner:   $runner_hash"
echo "registry: $registry ($network), author $author"

node -e '
  const fs = require("fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  payload.NEARAI_API_KEY = process.env.NEARAI_API_KEY;
  fs.writeFileSync(process.argv[2], JSON.stringify(payload));
' "$workdir/exam.json" "$workdir/secrets.json"

echo "== storing the exam as an OutLayer secret (locked to the runner and the registry)"
outlayer secrets set --profile "$profile" --wasm-hash "$runner_hash" \
  --access allow-all --via "$registry" "$(cat "$workdir/secrets.json")"

echo "== registering the exam on chain"
args="$(node -e '
  const s = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ exam_id: s.exam_id, title: process.argv[2], commitment: s.commitment,
    pass_mark_bps: s.pass_mark_bps, question_count: s.question_count, secrets_profile: process.argv[3] }));
' "$summary" "$title" "$profile")"
near contract call-function as-transaction "$registry" register_exam json-args "$args" \
  prepaid-gas '50.0 Tgas' attached-deposit '0.1 NEAR' sign-as "$author" \
  network-config "$network" sign-with-legacy-keychain send
