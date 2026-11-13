#!/usr/bin/env bash
# Start the results/task server and a Cloudflare quick tunnel in front of it.
# Also starts the tunnel watchdog if it is not already running (detached).
#
# The public origin is written to "$GROK_RELAY_RUN_DIR/tunnel-url.txt"
# (default: ./run/tunnel-url.txt). That directory is gitignored. This script
# does not print secrets.
#
# A quick-tunnel URL changes whenever the tunnel restarts. For a stable
# address, use a named Cloudflare tunnel or Tailscale instead, and set
# GROK_RELAY_RESULTS_URL to that origin (no trailing slash, no /results suffix).
#
# Requires: node, curl, python3, and cloudflared
#   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
#
# cloudflared talks to the Cloudflare edge directly. Some sandboxed hosts
# need a custom HTTP CONNECT forwarder to reach the edge; that is
# environment-specific and is not included here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${GROK_RELAY_RUN_DIR:-$ROOT/run}"
mkdir -p "$RUN"
cd "$ROOT"

HOST="${GROK_RELAY_RESULTS_HOST:-127.0.0.1}"
PORT="${GROK_RELAY_RESULTS_PORT:-8787}"
ENV_FILE="${GROK_RELAY_ENV:-$HOME/.config/grok-relay/env}"
CLOUDFLARED="${CLOUDFLARED_BIN:-cloudflared}"

if ! command -v "$CLOUDFLARED" >/dev/null 2>&1; then
  echo "cloudflared not found. Install it, or set CLOUDFLARED_BIN." >&2
  exit 1
fi

if [[ ! -f dist/results-server.js ]]; then
  npx tsc
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

health() {
  curl -sS -o /dev/null --max-time 2 \
    -H "Authorization: Bearer ${GROK_RELAY_RESULTS_TOKEN:-}" \
    "http://${HOST}:${PORT}/health"
}

if ! health 2>/dev/null; then
  nohup node dist/results-server.js > "$RUN/results-server.log" 2>&1 &
  echo $! > "$RUN/results-server.pid"
  ready=0
  for _ in 1 2 3 4 5 6 7 8; do
    if health 2>/dev/null; then
      ready=1
      break
    fi
    sleep 0.4
  done
  if [[ "$ready" -ne 1 ]]; then
    echo "results server did not become ready; see $RUN/results-server.log" >&2
    exit 1
  fi
fi

if [[ -f "$RUN/tunnel.pid" ]] && kill -0 "$(cat "$RUN/tunnel.pid")" 2>/dev/null; then
  kill "$(cat "$RUN/tunnel.pid")" 2>/dev/null || true
  sleep 1
fi

: > "$RUN/tunnel.log"
nohup "$CLOUDFLARED" tunnel --no-autoupdate --url "http://${HOST}:${PORT}" \
  > "$RUN/tunnel.log" 2>&1 &
echo $! > "$RUN/tunnel.pid"

RUN_DIR="$RUN" python3 - << 'PY'
import os, re, sys, time
from pathlib import Path

run = Path(os.environ["RUN_DIR"])
log = run / "tunnel.log"
url_re = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
for _ in range(60):
    if log.exists():
        text = log.read_text(errors="replace")
        match = url_re.search(text)
        if match and "Registered tunnel connection" in text:
            (run / "tunnel-url.txt").write_text(match.group(0) + "\n")
            print("tunnel ready")
            print("Set GROK_RELAY_RESULTS_URL to the origin in run/tunnel-url.txt (no trailing slash).")
            sys.exit(0)
    time.sleep(0.4)
print("tunnel did not become ready; see run/tunnel.log", file=sys.stderr)
sys.exit(1)
PY

# Start the watchdog detached so this script does not stay attached to it.
if [[ -x "$ROOT/scripts/run-watchdog.sh" ]]; then
  GROK_RELAY_ROOT="$ROOT" GROK_RELAY_RUN_DIR="$RUN" \
    GROK_RELAY_RESTART_TUNNEL_CMD="$ROOT/scripts/start-results-tunnel.sh" \
    bash "$ROOT/scripts/run-watchdog.sh" >/dev/null || true
fi
