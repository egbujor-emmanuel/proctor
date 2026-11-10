#!/usr/bin/env bash
# Seeds the PROCTOR Index: sits each NEAR AI model on an exam, one at a time,
# and prints the transaction and outcome of each. The sentinel's surprise
# re-tests then keep every certificate honest.
#
#   scripts/index-sittings.sh [exam_id]        (default near-reasoning-pool-v1)
#
# Environment (defaults in brackets):
#   SIGNER     account that pays for the sittings [proctor-index.testnet]
#   REGISTRY   registry contract [registry-v2.attrito.testnet]
#   MODELS     space-separated model ids [the list below]
set -euo pipefail

exam="${1:-near-reasoning-pool-v1}"
signer="${SIGNER:-proctor-index.testnet}"
registry="${REGISTRY:-registry-v2.attrito.testnet}"
default_models=(
  anthropic/claude-opus-5-5 anthropic/claude-sonnet-5-5 anthropic/claude-haiku-5-5 anthropic/claude-fable-5-1
  openai/gpt-6-sol openai/gpt-6-luna openai/gpt-5.5 openai/gpt-5.4-mini openai/gpt-5.4-nano openai/o4-mini
  google/gemini-3.8-flash google/gemini-3.5-flash google/gemini-2.5-pro
  x-ai/grok-4.7 moonshotai/kimi-k3.1-pro moonshotai/kimi-k2.6 qwen/qwen3.7-max
  Qwen/Qwen3.8-27B z-ai/glm-5.3 z-ai/glm-5.3-flash deepseek-ai/DeepSeek-V4.1-Flash-1017 deepseek/deepseek-v3.2
)
read -r -a models <<< "${MODELS:-${default_models[*]}}"

for model in "${models[@]}"; do
  args="$(printf '{"exam_id":"%s","candidate_model":"%s"}' "$exam" "$model")"
  out="$(near contract call-function as-transaction "$registry" sit_exam json-args "$args" \
    prepaid-gas '300.0 Tgas' attached-deposit '0.1 NEAR' sign-as "$signer" \
    network-config testnet sign-with-legacy-keychain send 2>&1 || true)"
  tx="$(grep -oE 'Transaction ID: [A-Za-z0-9]+' <<< "$out" | head -1 | cut -d' ' -f3)"
  outcome="$(grep -oE '"outcome":\{[^}]*\}\}?' <<< "$out" | head -1)"
  error="$(grep -oE 'Smart contract panicked: [^"\\]*' <<< "$out" | head -1)"
  printf '%-40s %-46s %s\n' "$model" "${tx:-no-tx}" "${outcome:-${error:-see log}}"
done
