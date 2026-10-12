#!/usr/bin/env bash
# Push whichever runtime secrets are set in the environment to the deployed Worker.
# Empty ones are skipped, so a missing Stripe key never wipes a live value.
# Used by .github/workflows/ci.yml; works locally too:  ADMIN_TOKEN=... bash scripts/sync-secrets.sh
set -euo pipefail

NAMES=(ADMIN_TOKEN IP_SALT EMAIL_API_KEY DELIVR_API_KEY DELIVR_API_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_STARTER STRIPE_PRICE_PRO CF_ACCESS_TEAM_DOMAIN CF_ACCESS_AUD INDEXNOW_KEY)
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

node -e '
  const names = process.argv.slice(1);
  const out = {};
  for (const n of names) if (process.env[n]) out[n] = process.env[n];
  process.stdout.write(JSON.stringify(out));
' "${NAMES[@]}" > "$TMP"

COUNT="$(node -e 'process.stdout.write(String(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).length))' "$TMP")"
if [ "$COUNT" = "0" ]; then
  echo "No runtime secrets set; nothing to sync."
  exit 0
fi
echo "Syncing $COUNT secret(s): $(node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))).join(", "))' "$TMP")"
npx wrangler secret bulk "$TMP"
