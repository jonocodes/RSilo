#!/usr/bin/env bash
# Throwaway spike: RSilo's S3 backend (ADR-0005) pointed at `rclone serve s3`, so any
# rclone remote becomes RSilo storage. Runs the live S3Storage test and the remoteStorage
# spec-check (as .github/workflows/spec-check.yml does) against it.
#
#   ./spike.sh                      # a local directory (plumbing check)
#   ./spike.sh dropbox:rsilo-spike  # any rclone remote:path; bucket = a folder inside it
#
# Run in the main checkout's flox env (bun, node): flox activate -d ~/src/RSilo -- ./spike.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

REMOTE=${1:-/tmp/rclone-spike/root}
BUCKET=rsilo-spec
S3_PORT=${S3_PORT:-8334}
RS_PORT=${RS_PORT:-8790}
WORK=/tmp/rclone-spike
KEY=rsiloadmin SECRET=rsilo-secret-123
mkdir -p "$WORK"
rm -rf "$WORK/rsilo"

pids=()
trap 'kill "${pids[@]}" 2>/dev/null || true' EXIT

rclone mkdir "$REMOTE/$BUCKET"
rclone serve s3 "$REMOTE" --auth-key "$KEY,$SECRET" --addr "127.0.0.1:$S3_PORT" \
  --etag-hash auto ${RCLONE_FLAGS:-} > "$WORK/rclone.log" 2>&1 &
pids+=($!)
for _ in $(seq 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$S3_PORT/")" != 000 ] && break; sleep 1; done

echo "== live S3Storage test against rclone serve s3 ($REMOTE)"
RSILO_S3_LIVE_ENDPOINT=http://127.0.0.1:$S3_PORT RSILO_S3_LIVE_BUCKET=$BUCKET \
RSILO_S3_LIVE_ACCESS_KEY_ID=$KEY RSILO_S3_LIVE_SECRET_ACCESS_KEY=$SECRET \
  bunx vitest run test/s3-live.test.ts || echo "live test FAILED"

echo "== remoteStorage spec-check"
mkdir -p "$WORK/rsilo"
S3_ENDPOINT=http://127.0.0.1:$S3_PORT S3_BUCKET=$BUCKET S3_ACCESS_KEY_ID=$KEY S3_SECRET_ACCESS_KEY=$SECRET \
STORAGE_DIR=$WORK/rsilo/storage DB_PATH=$WORK/rsilo/db.sqlite PORT=$RS_PORT \
  bun run src/server-offline.ts > "$WORK/rsilo/server.log" 2>&1 &
pids+=($!)
for _ in $(seq 30); do curl -sf "http://localhost:$RS_PORT/health" > /dev/null && break; sleep 1; done
head -3 "$WORK/rsilo/server.log"

token() { DB_PATH=$WORK/rsilo/db.sqlite bun run dev-token alice "$1" | tail -1; }
RW=$(token 'api-test-suite:rw') RO=$(token 'api-test-suite:r') GL=$(token '*:rw')

SPEC=$WORK/spec-check
if [ ! -d "$SPEC" ]; then
  git clone -q https://github.com/0dataapp/spec-check "$SPEC"
  git -C "$SPEC" checkout -q e969675a41c8bbffa35dc8d8c0eea0e82846695b
  (cd "$SPEC" && npm install --no-audit --no-fund --silent)
fi
cat > "$SPEC/.env" <<EOF
SERVER_URL="http://localhost:$RS_PORT"
ACCOUNT_HANDLE="alice"
TOKEN_READ_WRITE="$RW"
TOKEN_READ_ONLY="$RO"
TOKEN_GLOBAL="$GL"
EOF
(cd "$SPEC" && npm test 2>&1) | tee "$WORK/spec-check.log" | tail -40
