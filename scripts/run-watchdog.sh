#!/usr/bin/env bash
# Start the tunnel watchdog detached. Never waits for it. Does not print secrets.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="${GROK_RELAY_RUN_DIR:-$ROOT/run}"
mkdir -p "$RUN"
cd "$ROOT"

if [[ -f "$RUN/watchdog.pid" ]] && kill -0 "$(cat "$RUN/watchdog.pid")" 2>/dev/null; then
  echo "watchdog already running"
  exit 0
fi

export GROK_RELAY_ROOT="$ROOT"
export GROK_RELAY_RUN_DIR="$RUN"
if [[ -z "${GROK_RELAY_RESTART_TUNNEL_CMD:-}" && -x "$ROOT/run/restart-tunnel.sh" ]]; then
  export GROK_RELAY_RESTART_TUNNEL_CMD="$ROOT/run/restart-tunnel.sh"
fi

# setsid/nohup so this script never stays attached to the child.
if command -v setsid >/dev/null 2>&1; then
  setsid nohup python3 "$ROOT/scripts/tunnel-watchdog.py" >> "$RUN/watchdog.log" 2>&1 < /dev/null &
else
  nohup python3 "$ROOT/scripts/tunnel-watchdog.py" >> "$RUN/watchdog.log" 2>&1 < /dev/null &
fi
echo $! > "$RUN/watchdog.pid"
echo "watchdog started"
