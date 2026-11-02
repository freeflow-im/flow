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
  "APPLE_AUDIENCE APPLE_BUNDLE_ID"
  "R2_ACCESS_KEY_ID CLOUDFLARE_ACCESS_KEY_ID"
  "R2_SECRET_ACCESS_KEY CLOUDFLARE_SECRET_ACCESS_KEY"
  "R2_ENDPOINT CLOUDFLARE_S3_ENDPOINT"
  "R2_BUCKET FLOW_R2_BUCKET"
  "EMAIL_FROM FLOW_EMAIL_FROM"
  "INVITE_URL_BASE INVITE_URL_BASE"
)
for pair in "${PAIRS[@]}"; do
  read -r name param <<<"$pair"
  if [ "${1:-}" != --apply ]; then echo "would set $name from /flow/$param"; continue; fi
  aws ssm get-parameter --region $REGION --name "/flow/$param" --with-decryption --query Parameter.Value --output text \
    | tr -d '\n' | pnpm exec wrangler secret put "$name" >/dev/null
  echo "set $name"
done
