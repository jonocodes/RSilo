#!/usr/bin/env bash
# Edge deploy against R2's S3 API. Reads the Cloudflare API token and account ID from
# ~/.config/secrets. R2's S3 credentials derive from the token: access key ID is the
# token's ID, secret is the SHA-256 of its value (the token needs R2 read/write).
#
#   ./r2.sh setup      create the bucket, deploy, set the S3 secrets
#   ./r2.sh teardown   delete the Worker and the bucket
#
# Run inside the flox env: `flox activate -d . -- ./r2.sh setup`.
set -euo pipefail
cd "$(dirname "$0")"

BUCKET=opendal-proto
WORKER=opendal-worker-proto-r2
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/secrets/cloudflare-api-token)
export CLOUDFLARE_ACCOUNT_ID=$(cat ~/.config/secrets/cloudflare-account)
API=https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID
cf() { curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }
wrangler() { npx -y wrangler@4 "$@"; }

case ${1:-} in
setup)
  cf "$API/r2/buckets/$BUCKET" >/dev/null || cf -X POST -H 'Content-Type: application/json' \
    -d "{\"name\":\"$BUCKET\"}" "$API/r2/buckets" >/dev/null
  token_id=$(cf "$API/tokens/verify" | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p')
  wrangler deploy --env r2
  printf %s "https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com" | wrangler secret put STORAGE_ENDPOINT --env r2
  printf %s "$token_id" | wrangler secret put STORAGE_ACCESS_KEY_ID --env r2
  printf %s "$CLOUDFLARE_API_TOKEN" | sha256sum | cut -d' ' -f1 | tr -d '\n' |
    wrangler secret put STORAGE_SECRET_ACCESS_KEY --env r2
  echo "Now: ./smoke.sh https://$WORKER.<subdomain>.workers.dev"
  ;;
teardown)
  wrangler delete --name "$WORKER" --force
  # R2 only deletes empty buckets. A full smoke.sh run removes what it wrote.
  cf -X DELETE "$API/r2/buckets/$BUCKET" >/dev/null ||
    echo "Couldn't delete bucket $BUCKET (not empty?); empty it in the dashboard, then rerun teardown."
  ;;
*) echo "usage: $0 setup|teardown" >&2; exit 2 ;;
esac
