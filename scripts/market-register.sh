#!/usr/bin/env bash
# Lists PROCTOR's agent on the NEAR AI Agent Market and connects the Worker
# that delivers its jobs (market-agent/). Safe to run again: it registers
# only once, keeping the agent's token in $SECRETS, outside the repository.
#
#   scripts/market-register.sh
#
# Environment (defaults in brackets):
#   HANDLE   the agent's handle, immutable once registered [proctor-check]
#   PRICE    price per check, as a decimal string [1.00]
#   SECRETS  where the token and agent id are kept [~/near-hackathon/secrets]
#
# At the end it prints a one-time adoption link: open it, sign in to
# market.near.ai, and the agent moves to your account (and into Discover).
set -euo pipefail
cd "$(dirname "$0")/.."

API="https://market.near.ai/v1"
HANDLE="${HANDLE:-proctor-check}"
PRICE="${PRICE:-1.00}"
SECRETS="${SECRETS:-$HOME/near-hackathon/secrets}"
TOKEN_FILE="$SECRETS/market-agent.token"
AGENT_FILE="$SECRETS/market-agent.id"
mkdir -p "$SECRETS"
chmod 700 "$SECRETS"

# Reads one field from the JSON on stdin; fails loudly if it is missing.
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];if(v===undefined||v===null){console.error("missing "+process.argv[1]+" in: "+s.slice(0,300));process.exit(1)}process.stdout.write(String(v))})' "$1"; }

if [[ ! -s "$TOKEN_FILE" ]]; then
  echo "== registering @$HANDLE"
  resp="$(curl -sS -X POST "$API/agents/register" -H 'content-type: application/json' \
    -d "{\"handle\":\"$HANDLE\",\"name\":\"PROCTOR check\",\"category\":\"dev_tools\",\"sla_seconds\":600}")"
  ( umask 077; printf '%s' "$resp" | field apiToken > "$TOKEN_FILE" )
  printf '%s' "$resp" | field agentId > "$AGENT_FILE"
  echo "   agent $(cat "$AGENT_FILE"); token saved to $TOKEN_FILE (not printed)"
else
  echo "== already registered: agent $(cat "$AGENT_FILE")"
fi
AGENT_ID="$(cat "$AGENT_FILE")"
auth=(-H "authorization: Bearer $(cat "$TOKEN_FILE")" -H 'content-type: application/json')

echo "== describing the listing"
curl -sS -f -X PATCH "$API/agents/$AGENT_ID" "${auth[@]}" -d @- > /dev/null <<'JSON'
{
  "description": "Check an AI model or agent before you hire it. Name model ids (anthropic/claude-sonnet-5-5), agents (agent:<owner>/<name>) or Agent Market handles (@handle) in the brief, and get a report on whether each holds a live PROCTOR certificate: passed a secret exam sealed in an OutLayer TEE and every surprise re-test since, read from the PROCTOR registry on NEAR testnet.",
  "tags": ["near", "ai-safety", "evaluation", "tee", "due-diligence", "proctor"]
}
JSON

echo "== pricing: $PRICE per check"
plans="$(curl -sS -f "$API/agents/$AGENT_ID/pricing-plans" "${auth[@]}")"
if printf '%s' "$plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.plans??j.pricing_plans??[]);process.exit(a.length>0?0:1)})'; then
  echo "   a plan exists already"
else
  curl -sS -f -X POST "$API/agents/$AGENT_ID/pricing-plans" "${auth[@]}" \
    -d "{\"model\":\"per_call\",\"price_amount\":\"$PRICE\",\"sla_seconds\":600,\"display_name\":\"One PROCTOR check\"}" > /dev/null
fi

# The listing goes live on its default plan, and only if that plan is live.
plan="$(curl -sS -f "$API/agents/$AGENT_ID/pricing-plans" "${auth[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s)[0];if(!p){console.error("no pricing plan");process.exit(1)}console.log([p.pricing_plan_id,p.listing_status,p.is_default].join(" "))})')"
read -r PLAN_ID PLAN_STATUS PLAN_DEFAULT <<< "$plan"
if [[ "$PLAN_STATUS" != "live" ]]; then
  curl -sS -f -X PATCH "$API/pricing-plans/$PLAN_ID" "${auth[@]}" -d '{"listing_status":"live"}' > /dev/null
fi
if [[ "$PLAN_DEFAULT" != "true" ]]; then
  curl -sS -f -X POST "$API/pricing-plans/$PLAN_ID/make-default" "${auth[@]}" > /dev/null
fi
echo "   plan $PLAN_ID is live and the default"

echo "== going live"
curl -sS -f -X PATCH "$API/agents/$AGENT_ID" "${auth[@]}" -d '{"listing_status":"live"}' > /dev/null

echo "== giving the token to the Worker and deploying it"
( cd market-agent && npx wrangler secret put AGENT_MARKET_TOKEN < "$TOKEN_FILE" && npx wrangler deploy )

echo "== adoption link (one-time; open it and sign in to market.near.ai to own the agent)"
curl -sS -f -X POST "$API/agents/me/adoption-code" "${auth[@]}" | field adoptionUrl
echo
echo "Listing: https://market.near.ai/a/$HANDLE"
