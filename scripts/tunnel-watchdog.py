#!/usr/bin/env python3
"""Check the public results /health endpoint and restart the tunnel after failures.

Does not print or log secrets. A 530 from Cloudflare usually means the tunnel
lost its origin.

Environment:
  GROK_RELAY_ROOT          Install directory (default: parent of this script)
  GROK_RELAY_RUN_DIR       Directory for pid/url/log files (default: $ROOT/run)
  GROK_RELAY_ENV           Env file with GROK_RELAY_RESULTS_TOKEN (default: ~/.config/grok-relay/env)
  GROK_RELAY_WATCHDOG_INTERVAL    Seconds between checks (default: 60)
  GROK_RELAY_WATCHDOG_FAILURES    Consecutive failures before restart (default: 3)
  GROK_RELAY_RESTART_TUNNEL_CMD   Command to restart the forwarder and tunnel
  GROK_RELAY_RESULTS_TOKEN        Used if not present in the env file
  GROK_RELAY_WATCHDOG_LOG         Log path (default: $RUN/watchdog.log)
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

URL_RE_HINT = "https://"


def load_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("export "):
            s = s[7:]
        if "=" not in s:
            continue
        k, _, v = s.partition("=")
        k, v = k.strip(), v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if k:
            out[k] = v
    return out


def read_tunnel_url(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(errors="replace").splitlines():
        s = line.strip()
        if s.startswith("https://") or s.startswith("http://"):
            return s.rstrip("/")
    return None


def classify_health(status: int | None, error: str | None) -> str:
    """Return 'ok', 'config' (do not restart), or 'down' (count a failure)."""
    if error:
        return "down"
    if status == 200:
        return "ok"
    if status in (401, 403):
        return "config"
    return "down"


def http_health(url: str, token: str, timeout: float = 10.0) -> tuple[int | None, str | None]:
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {token}", "Accept": "text/plain"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
            return int(resp.status), None
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:
            pass
        return int(exc.code), None
    except Exception as exc:
        return None, type(exc).__name__


def log(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"{ts} {message}\n"
    with path.open("a", encoding="utf8") as fh:
        fh.write(line)
        fh.flush()


def should_restart(failures: int, threshold: int) -> bool:
    return failures >= threshold


def run_restart(cmd: str, cwd: Path, log_path: Path, timeout: int = 90) -> int:
    log(log_path, "restarting forwarder and tunnel")
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            cwd=str(cwd),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if proc.returncode != 0:
            err = (proc.stderr or b"").decode("utf8", "replace").strip().replace("\n", " ")
            # Do not copy possible secrets from stderr; only a short status.
            log(log_path, f"restart command exited {proc.returncode}")
            if err and "Bearer" not in err and "crsr_" not in err and "TOKEN" not in err:
                log(log_path, "restart stderr present (redacted from this log)")
        else:
            log(log_path, "restart command finished ok")
        return proc.returncode
    except subprocess.TimeoutExpired:
        log(log_path, "restart command timed out")
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Watch the grok-relay tunnel health.")
    parser.add_argument("--once", action="store_true", help="Run a single check and exit.")
    parser.add_argument("--interval", type=int, default=None)
    parser.add_argument("--failures", type=int, default=None)
    args = parser.parse_args(argv)

    root = Path(os.environ.get("GROK_RELAY_ROOT") or Path(__file__).resolve().parent.parent)
    run_dir = Path(os.environ.get("GROK_RELAY_RUN_DIR") or (root / "run"))
    run_dir.mkdir(parents=True, exist_ok=True)
    env_path = Path(os.environ.get("GROK_RELAY_ENV") or Path.home() / ".config/grok-relay/env")
    log_path = Path(os.environ.get("GROK_RELAY_WATCHDOG_LOG") or (run_dir / "watchdog.log"))
    interval = args.interval or int(os.environ.get("GROK_RELAY_WATCHDOG_INTERVAL") or "60")
    threshold = args.failures or int(os.environ.get("GROK_RELAY_WATCHDOG_FAILURES") or "3")
    restart_cmd = os.environ.get("GROK_RELAY_RESTART_TUNNEL_CMD") or str(
        root / "scripts/start-results-tunnel.sh"
    )
    url_file = run_dir / "tunnel-url.txt"

    file_env = load_env_file(env_path)
    token = os.environ.get("GROK_RELAY_RESULTS_TOKEN") or file_env.get("GROK_RELAY_RESULTS_TOKEN") or ""
    if not token:
        log(log_path, "no results token; cannot check public /health")
        return 1

    state_path = run_dir / "watchdog-failures.txt"

    def read_failures() -> int:
        try:
            return max(0, int(state_path.read_text().strip() or "0"))
        except (OSError, ValueError):
            return 0

    def write_failures(n: int) -> None:
        state_path.write_text(str(n) + "\n")

    log(log_path, f"watchdog starting interval={interval}s failures={threshold}")
    failures = read_failures()
    while True:
        origin = read_tunnel_url(url_file)
        if not origin:
            failures += 1
            write_failures(failures)
            log(log_path, f"missing tunnel url ({failures}/{threshold})")
        else:
            status, error = http_health(origin + "/health", token)
            kind = classify_health(status, error)
            if kind == "ok":
                if failures:
                    log(log_path, f"health ok ({origin})")
                failures = 0
                write_failures(0)
            elif kind == "config":
                log(log_path, f"health auth failed HTTP {status}; not restarting the tunnel")
                failures = 0
                write_failures(0)
            else:
                failures += 1
                write_failures(failures)
                detail = f"HTTP {status}" if status is not None else (error or "error")
                if status == 530:
                    detail += " (tunnel likely lost its origin)"
                log(log_path, f"health failed: {detail} ({failures}/{threshold}) origin={origin}")

        if should_restart(failures, threshold):
            run_restart(restart_cmd, root, log_path)
            new_origin = read_tunnel_url(url_file)
            if new_origin:
                log(log_path, f"new tunnel url {new_origin}")
            else:
                log(log_path, "restart finished but tunnel url is missing")
            write_failures(0)
            failures = 0

        if args.once:
            return 0
        time.sleep(max(1, interval))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
