#!/usr/bin/env bash
# Smoke test for the collector. Starts wrangler dev, fetches the pixel, posts a sample
# visit, runs the resolution step, and prints /api/admin/visits. Needs: node, npm, curl.
#
#   npm run smoke            # or: bash scripts/smoke.sh
#   PORT=8790 bash scripts/smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/apps/collector"
PORT="${PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
SITE_KEY="${SITE_KEY:-TESTKEY}"
ORIGIN="${ORIGIN:-http://localhost:3000}"
LOG="$(mktemp -t yardsign-smoke.XXXXXX.log)"

if [ ! -f "$APP/.dev.vars" ]; then
  cp "$APP/.dev.vars.example" "$APP/.dev.vars"
  echo "Created apps/collector/.dev.vars from the example."
fi
ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$APP/.dev.vars" | cut -d= -f2-)"

cleanup() {
  if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Building the pixel"
(cd "$ROOT" && npm run build --silent -w @yardsign/pixel)

echo "==> Applying migrations to the local D1"
(cd "$APP" && npx wrangler d1 migrations apply yardsign-core --local >/dev/null)

echo "==> Starting wrangler dev on port $PORT (log: $LOG)"
(cd "$APP" && npx wrangler dev --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1) &
DEV_PID=$!

for i in $(seq 1 60); do
  if curl -sf "$BASE/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then echo "wrangler dev exited early; see $LOG"; cat "$LOG"; exit 1; fi
  sleep 1
done
curl -sf "$BASE/health" >/dev/null || { echo "collector never came up; see $LOG"; cat "$LOG"; exit 1; }

echo "==> GET /health"
curl -s "$BASE/health"; echo

echo "==> GET /p/$SITE_KEY.js (first 200 bytes)"
curl -sf "$BASE/p/$SITE_KEY.js" | head -c 200; echo; echo "..."

echo "==> POST /api/admin/hail/sync (load mock hail events)"
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/hail/sync"; echo

VISIT_ID="$(node -e 'console.log(crypto.randomUUID())')"
# This visitor id resolves with the mock provider; any UUID works, about 1 in 3 resolve.
VISITOR_ID="${VISITOR_ID:-00000002-0000-4000-8000-000000000000}"
NOW="$(node -e 'console.log(Date.now())')"
PAYLOAD="$(cat <<JSON
{"k":"$SITE_KEY","e":"view","id":"$VISIT_ID","vid":"$VISITOR_ID","sid":"smoke_session_01","u":"$ORIGIN/roof-repair","r":"https://www.google.com/","t":"Roof repair","s":{"w":1920,"h":1080,"vw":1600,"vh":900,"dpr":1},"tz":"America/Chicago","l":"en-US","ts":$NOW}
JSON
)"

echo "==> POST /collect (sample visit)"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/collect" \
  -H "Origin: $ORIGIN" -H "Content-Type: text/plain" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" \
  --data "$PAYLOAD")"
echo "status: $STATUS (expected 204)"

echo "==> POST /collect (unload beacon, 12s on page)"
UNLOAD="{\"k\":\"$SITE_KEY\",\"e\":\"unload\",\"id\":\"$VISIT_ID\",\"vid\":\"$VISITOR_ID\",\"sid\":\"smoke_session_01\",\"top\":12000,\"ts\":$NOW}"
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/collect" -H "Origin: $ORIGIN" -H "Content-Type: text/plain" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0 Safari/537.36" --data "$UNLOAD")"
echo "status: $STATUS (expected 204)"

echo "==> POST /api/admin/resolve (run the resolution step now instead of waiting for the cron)"
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/resolve"; echo

echo "==> GET /api/admin/visits?siteKey=$SITE_KEY&limit=5"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BASE/api/admin/visits?siteKey=$SITE_KEY&limit=5" | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const j=JSON.parse(s); console.log(JSON.stringify(j,null,2)); });'

echo "==> Done. Worker log is at $LOG"
