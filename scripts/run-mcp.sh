#!/usr/bin/env bash
# Start the grok-bot-relay MCP server after loading secrets from a chmod 600
# env file. Point Claude Code, Codex, Gemini CLI, or any mcp.json at this
# script so webhook keys and results tokens are not stored in CLI config.
set -euo pipefail

ENV_FILE="${GROK_RELAY_ENV:-$HOME/.config/grok-relay/env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Copy examples/env.example to that path, fill in values, and chmod 600 it." >&2
  exit 1
fi

mode="$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$ENV_FILE" 2>/dev/null || true)"
if [[ -n "$mode" && "$mode" != "0o600" && "$mode" != "0600" ]]; then
  echo "Warning: $ENV_FILE is mode $mode; chmod 600 is recommended." >&2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! -f "$ROOT/dist/server.js" ]]; then
  echo "dist/server.js is missing. Run npm ci && npm run build first." >&2
  exit 1
fi

exec node "$ROOT/dist/server.js"
