#!/usr/bin/env bash
# Live end-to-end test against the real Grok Bot webhook.
# Requires GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY in the environment.
# Does not print either value.
set -euo pipefail

if [[ -z "${GROK_WEBHOOK_URL:-}" || -z "${GROK_WEBHOOK_KEY:-}" ]]; then
  echo "Set GROK_WEBHOOK_URL and GROK_WEBHOOK_KEY before running the live test." >&2
  echo "Do not pass the values on the command line; export them in the environment." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f dist/cli.js ]]; then
  npx tsc
fi

export GROK_RELAY_RESULTS_DIR="${GROK_RELAY_RESULTS_DIR:-$ROOT/results}"

echo "Posting a live test task and waiting up to 300s for a result..."
echo "The Grok Bot routine must write \$GROK_RELAY_RESULTS_DIR/<request_id>.json when it finishes."
exec node dist/cli.js ask --json --wait 300 "Live test of grok-bot-relay. Reply with exactly: grok-relay-ok"
