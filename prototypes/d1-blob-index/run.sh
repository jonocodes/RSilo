#!/usr/bin/env bash
# PROTOTYPE — throwaway. Runs the pinned remoteStorage spec-check against RSilo
# with its tree in D1 (SQLite offline) and blobs in a BlobStore.
#
#   ./run.sh                 # blobs in a local directory
#   ./run.sh dropbox         # blobs in Dropbox under /rsilo-blobs, token from the
#                            # rclone remote `rsilo-dropbox` (RCLONE_REMOTE to change)
#
# Run in the main checkout's flox env: flox activate -d ~/src/RSilo -- ./run.sh
# MOCHA_TIMEOUT (ms, default 2000 as in CI). Logs: /tmp/d1-blob-index/.
set -euo pipefail
cd "$(dirname "$0")/../.."

MODE=${1:-dir}
PORT=${PORT:-8791}
WORK=/tmp/d1-blob-index
rm -rf "$WORK" && mkdir -p "$WORK"
export DB_PATH=$WORK/PROTOTYPE-wipe-me.db PORT BLOB_DIR=$WORK/blobs

if [ "$MODE" = dropbox ]; then
  remote=${RCLONE_REMOTE:-rsilo-dropbox}
  rclone about "$remote:" > /dev/null # refreshes the access token if it has expired
  export BLOB_STORE=dropbox
  DROPBOX_TOKEN=$(rclone config dump | jq -r --arg r "$remote" '.[$r].token' | jq -r .access_token)
  export DROPBOX_TOKEN
fi

trap 'kill $(jobs -p) 2>/dev/null || true' EXIT
bun run prototypes/d1-blob-index/server.ts > "$WORK/server.log" 2>&1 &
for _ in $(seq 30); do curl -sf "http://localhost:$PORT/health" > /dev/null && break; sleep 1; done
head -1 "$WORK/server.log"

token() { bun run dev-token alice "$1" | tail -1; }
RW=$(token 'api-test-suite:rw') RO=$(token 'api-test-suite:r') GL=$(token '*:rw')

SPEC=/tmp/rclone-spike/spec-check
if [ ! -d "$SPEC" ]; then
  git clone -q https://github.com/0dataapp/spec-check "$SPEC"
  git -C "$SPEC" checkout -q e969675a41c8bbffa35dc8d8c0eea0e82846695b
  (cd "$SPEC" && npm install --no-audit --no-fund --silent)
fi
cat > "$SPEC/.env" <<EOF
SERVER_URL="http://localhost:$PORT"
ACCOUNT_HANDLE="alice"
TOKEN_READ_WRITE="$RW"
TOKEN_READ_ONLY="$RO"
TOKEN_GLOBAL="$GL"
EOF
(cd "$SPEC" && npm test -- --timeout "${MOCHA_TIMEOUT:-2000}" 2>&1) > "$WORK/spec-check.log" || true
grep -E "passing|failing|pending" "$WORK/spec-check.log"

echo "== per-request (storage routes)"
grep '^\[req\]' "$WORK/server.log" | awk '{
  n++; split($4, t, "ms"); ms[n] = t[1]
  calls = ($5 == "dropbox=-") ? 0 : gsub(/:/, ":", $5); total += calls; by[$2] += calls; cnt[$2]++
} END {
  asort(ms); printf "requests %d, median %dms, p90 %dms, max %dms, dropbox calls %d\n", n, ms[int(n/2)+1], ms[int(n*0.9)], ms[n], total
  for (m in by) printf "  %-7s %3d requests, %.2f dropbox calls each\n", m, cnt[m], by[m]/cnt[m]
}'
echo "429 retries: $(grep -c 429 "$WORK/server.log" || true)"
{ grep '^\[gc\]' "$WORK/server.log" || true; } | awk '{n++; b += $2} END {printf "gc runs during the test: %d, %d blobs\n", n, b}'

echo "== consistency after a final gc"
curl -sf -X POST "http://localhost:$PORT/prototype/gc" > /dev/null
stats=$(curl -sf "http://localhost:$PORT/prototype/stats")
if [ "$MODE" = dropbox ]; then
  blobs=$(rclone lsf "$remote:rsilo-blobs" 2>/dev/null | wc -l)
else
  blobs=$(ls "$WORK/blobs" 2>/dev/null | wc -l)
fi
echo "index $stats; blobs stored $blobs (should equal indexed)"
