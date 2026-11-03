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
#   REGISTRY   registry contract [registry-v2.attrito.testnet]
#   NETWORK    testnet or mainnet [testnet]
#   NEARAI_API_KEY  key the runner uses to call NEAR AI (required)
#   RESEAL     set to 1 to only re-store the secret for the registry's current
#              runner (after apply_runner); the exam must already be on chain
#              with the same commitment, or nothing is stored
#
# The secret is locked to the registry's current runner build (--wasm-hash)
# and to calls that come through the registry (--via): any account may pay
# for a sitting, but nothing else can read the exam.
set -euo pipefail
cd "$(dirname "$0")/.."

exam_file="${1:?usage: register-exam.sh <exam.json> <secrets-profile> [title]}"
profile="${2:?usage: register-exam.sh <exam.json> <secrets-profile> [title]}"
author="${AUTHOR:-attrito.testnet}"
registry="${REGISTRY:-registry-v2.attrito.testnet}"
network="${NETWORK:-testnet}"
: "${NEARAI_API_KEY:?set NEARAI_API_KEY to the key the runner should use}"

if [[ "${OS:-}" == "Windows_NT" && -d /c/Users/Public/mingw64/bin ]]; then
  export PATH="/c/Users/Public/mingw64/bin:$PATH"
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# proctor-seal's errors (an invalid exam) stay visible on stderr.
summary="$(cargo run -q -p proctor-core --bin proctor-seal -- "$exam_file" "$workdir/exam.json")"
# A missing field is an error, never the string "undefined".
field() {
  node -e 'const v = JSON.parse(process.argv[1])[process.argv[2]]; if (v === undefined || v === null || v === "") { console.error(`proctor-seal gave no ${process.argv[2]}`); process.exit(1); } console.log(v)' "$summary" "$1"
}
exam_id="$(field exam_id)"
title="${3:-$exam_id}"

# view <method> <json-args> <field>: one field of a registry view call. A
# missing field (or an exam that does not exist) prints nothing.
view() {
  near contract call-function as-read-only "$registry" "$1" json-args "$2" \
    network-config "$network" now 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const start = s.indexOf("{");
        if (start < 0) return;
        const v = JSON.parse(s.slice(start, s.lastIndexOf("}") + 1))[process.argv[1]];
        if (v !== undefined && v !== null) console.log(v);
      });' "$3"
}

runner_hash="$(view get_config '{}' runner_hash)"
if [[ ! "$runner_hash" =~ ^[0-9a-f]{64}$ ]]; then
  echo "could not read the registry runner_hash" >&2
  exit 1
fi

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

if [[ "${RESEAL:-}" == "1" ]]; then
  # A secret whose bytes differ from the commitment fails every sitting with
  # "exam commitment mismatch" (CRLF line endings are the usual cause).
  on_chain="$(view get_exam "{\"exam_id\":\"$exam_id\"}" commitment)"
  if [[ "$on_chain" != "$(field commitment)" ]]; then
    echo "refusing to reseal: the on-chain commitment is '${on_chain:-<no such exam>}', this file seals to $(field commitment)" >&2
    exit 1
  fi
fi

echo "== storing the exam as an OutLayer secret (locked to the runner and the registry)"
outlayer secrets set --profile "$profile" --wasm-hash "$runner_hash" \
  --access allow-all --via "$registry" "$(cat "$workdir/secrets.json")"

if [[ "${RESEAL:-}" == "1" ]]; then
  echo "== resealed for runner $runner_hash; the exam is already registered"
  exit 0
fi

echo "== registering the exam on chain"
args="$(node -e '
  const s = JSON.parse(process.argv[1]);
  console.log(JSON.stringify({ exam_id: s.exam_id, title: process.argv[2], commitment: s.commitment,
    pass_mark_bps: s.pass_mark_bps, question_count: s.question_count, secrets_profile: process.argv[3] }));
' "$summary" "$title" "$profile")"
near contract call-function as-transaction "$registry" register_exam json-args "$args" \
  prepaid-gas '50.0 Tgas' attached-deposit '0.1 NEAR' sign-as "$author" \
  network-config "$network" sign-with-legacy-keychain send
