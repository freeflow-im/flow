#!/bin/bash
# Copies the server's secrets from AWS Parameter Store to the Worker, under the names the Worker reads. Nothing is printed:
# each value goes straight from `aws` into `wrangler secret put`. Run from packages/edge, logged in to both:
#   bash scripts/put-secrets.sh            # lists what it would set
#   bash scripts/put-secrets.sh --apply
# CONNECTOR_KEY_BASE64 is a file on the instance, not a parameter; the runbook copies it separately.
set -euo pipefail
REGION=us-west-2
# Worker name <- parameter under /flow/
PAIRS=(
  "FLOW_DATA_KEY FLOW_DATA_KEY"
  "EMAIL_API_TOKEN CLOUDFLARE_API_KEY"
  "CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_ACCOUNT_ID"
  "GOOGLE_CLIENT_ID GOOGLE_CLIENT_ID"
  # Google Calendar's OAuth (src/calendar/google.ts): the same client's secret. Optional until /flow/ has it.
  "?GOOGLE_CLIENT_SECRET GOOGLE_CLIENT_SECRET"
  "APPLE_AUDIENCE APPLE_BUNDLE_ID"
  "R2_ACCESS_KEY_ID CLOUDFLARE_ACCESS_KEY_ID"
  "R2_SECRET_ACCESS_KEY CLOUDFLARE_SECRET_ACCESS_KEY"
  "R2_ENDPOINT CLOUDFLARE_S3_ENDPOINT"
  "R2_BUCKET FLOW_R2_BUCKET"
  "EMAIL_FROM FLOW_EMAIL_FROM"
  "INVITE_URL_BASE INVITE_URL_BASE"
  # Pushes (src/org/push) and huddles (LiveKit). A name starting with ? is skipped when /flow/ has no such parameter.
  "FLOW_PUSH_DRIVER FLOW_PUSH_DRIVER"
  "FLOW_APNS_KEY FLOW_APNS_KEY"
  "FLOW_APNS_KEY_ID FLOW_APNS_KEY_ID"
  "FLOW_APNS_TEAM_ID FLOW_APNS_TEAM_ID"
  "?FLOW_APNS_ENV FLOW_APNS_ENV"
  "?FLOW_APNS_TOPIC FLOW_APNS_TOPIC"
  "?FLOW_PUSH_BODY_PREVIEW FLOW_PUSH_BODY_PREVIEW"
  "LIVEKIT_API_KEY LIVEKIT_API_KEY"
  "LIVEKIT_API_SECRET LIVEKIT_API_SECRET"
  "LIVEKIT_URL LIVEKIT_URL"
)
# Only some names: bash scripts/put-secrets.sh --apply FLOW_APNS_KEY LIVEKIT_URL ...
ONLY=("${@:2}")
for pair in "${PAIRS[@]}"; do
  read -r name param <<<"$pair"
  optional=; [ "${name:0:1}" = '?' ] && { optional=1; name=${name:1}; }
  if [ ${#ONLY[@]} -gt 0 ] && [[ ! " ${ONLY[*]} " == *" $name "* ]]; then continue; fi
  if [ "${1:-}" != --apply ]; then echo "would set $name from /flow/$param${optional:+ (if it exists)}"; continue; fi
  if ! value=$(aws ssm get-parameter --region $REGION --name "/flow/$param" --with-decryption --query Parameter.Value --output text 2>/dev/null); then
    [ -n "$optional" ] && { echo "skipped $name (no /flow/$param)"; continue; }
    echo "missing /flow/$param" >&2; exit 1
  fi
  printf '%s' "$value" | pnpm exec wrangler secret put "$name" >/dev/null
  echo "set $name"
done
