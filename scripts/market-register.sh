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
TOKEN="$(cat "$TOKEN_FILE")"

# One marketplace call. On any non-2xx it prints the marketplace's own error and stops.
api() {
  local method="$1" path="$2" data="${3:-}" out code
  local args=(-sS -X "$method" "$API$path" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -w $'\n%{http_code}')
  [[ -n "$data" ]] && args+=(-d "$data")
  out="$(curl "${args[@]}")"
  code="${out##*$'\n'}"
  if [[ "$code" != 2* ]]; then
    echo "error: $method $path answered HTTP $code: ${out%$'\n'*}" >&2
    exit 1
  fi
  printf '%s' "${out%$'\n'*}"
}

echo "== describing the listing"
# description is the listing card's tagline (at most 200 characters); bio_markdown is the full page.
LISTING="$(node -e '
const bio = [
  "Hire PROCTOR check before you hire anyone else. Name the candidates in the job brief:",
  "",
  "- NEAR AI model ids, such as `anthropic/claude-sonnet-5-5`",
  "- agents certified through their own endpoint, as `agent:<owner-account>/<name>`",
  "- Agent Market listings, as `@handle` or a `market.near.ai/a/<handle>` link",
  "",
  "You get a report saying, for each one, whether it holds a live PROCTOR certificate: it passed a secret exam sealed in an OutLayer TEE (Intel TDX), and every surprise re-test since. Every line is read from the PROCTOR registry on NEAR testnet, with the certificate and how to check it yourself.",
  "",
  "Site: https://proctor.attrito.workers.dev | Code: https://github.com/egbujor-emmanuel/proctor",
].join("\n");
const description = "Check an AI model or agent before you hire it: does it hold a live PROCTOR certificate? Read from the PROCTOR registry on NEAR.";
if (description.length > 200) { console.error("tagline over 200 characters"); process.exit(1); }
// Every character outside printable ASCII goes out as a JSON unicode escape, so the shell cannot mangle it on its way to curl.
const json = JSON.stringify({ description, bio_markdown: bio, tags: ["near", "ai-safety", "evaluation", "tee", "due-diligence", "proctor"] });
process.stdout.write(json.replace(/[^ -~]/g, (c) => String.fromCharCode(92) + "u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
')"
api PATCH "/agents/$AGENT_ID" "$LISTING" > /dev/null

echo "== pricing: $PRICE per check"
plans="$(api GET "/agents/$AGENT_ID/pricing-plans")"
if printf '%s' "$plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).length>0?0:1))'; then
  echo "   a plan exists already"
else
  api POST "/agents/$AGENT_ID/pricing-plans" "{\"model\":\"per_call\",\"price_amount\":\"$PRICE\",\"sla_seconds\":600,\"display_name\":\"One PROCTOR check\"}" > /dev/null
fi

# The listing goes live on its default plan, and only if that plan is live.
plan="$(api GET "/agents/$AGENT_ID/pricing-plans" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s)[0];if(!p){console.error("no pricing plan");process.exit(1)}console.log([p.pricing_plan_id,p.listing_status,p.is_default].join(" "))})')"
read -r PLAN_ID PLAN_STATUS PLAN_DEFAULT <<< "$plan"
if [[ "$PLAN_STATUS" != "live" ]]; then
  api PATCH "/pricing-plans/$PLAN_ID" '{"listing_status":"live"}' > /dev/null
fi
if [[ "$PLAN_DEFAULT" != "true" ]]; then
  api POST "/pricing-plans/$PLAN_ID/make-default" > /dev/null
fi
echo "   plan $PLAN_ID is live and the default"

echo "== going live"
api PATCH "/agents/$AGENT_ID" '{"listing_status":"live"}' > /dev/null

echo "== giving the token to the Worker and deploying it"
( cd market-agent && npx wrangler secret put AGENT_MARKET_TOKEN < "$TOKEN_FILE" && npx wrangler deploy )

echo "== adoption link (one-time; open it and sign in to market.near.ai to own the agent)"
api POST "/agents/me/adoption-code" | field adoptionUrl
echo
echo "Listing: https://market.near.ai/a/$HANDLE"
