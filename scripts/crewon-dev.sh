#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

port_listening() {
  python3 - "$1" "$2" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.25)
    raise SystemExit(0 if sock.connect_ex((host, port)) == 0 else 1)
PY
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local pid="${3:-}"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if port_listening "$host" "$port"; then
      return 0
    fi
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 1
  done
  return 1
}

app_server_pid=""
vite_pid=""
monitor_pid=""

cleanup() {
  if [[ -n "$monitor_pid" ]] && kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null || true
  fi
  if [[ -n "$vite_pid" ]] && kill -0 "$vite_pid" 2>/dev/null; then
    kill "$vite_pid" 2>/dev/null || true
    wait "$vite_pid" 2>/dev/null || true
  fi
  if [[ -n "$app_server_pid" ]] && kill -0 "$app_server_pid" 2>/dev/null; then
    kill "$app_server_pid" 2>/dev/null || true
    wait "$app_server_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

monitor_app_server() {
  while kill -0 "$app_server_pid" 2>/dev/null; do
    sleep 2
  done

  if [[ -n "$vite_pid" ]] && kill -0 "$vite_pid" 2>/dev/null; then
    echo "crewon-app-server exited; stopping UI dev server." >&2
    kill "$vite_pid" 2>/dev/null || true
  fi
}

if port_listening 127.0.0.1 6176; then
  echo "crewon-app-server already listening on ws://127.0.0.1:6176"
else
  echo "Starting crewon-app-server on ws://127.0.0.1:6176"
  bash "$repo_root/scripts/crewon-app-server.sh" &
  app_server_pid="$!"
  if ! wait_for_port 127.0.0.1 6176 "$app_server_pid"; then
    echo "crewon-app-server did not become ready on ws://127.0.0.1:6176" >&2
    exit 1
  fi
fi

if ! port_listening 127.0.0.1 8000; then
  echo "agent-platform is not listening on http://127.0.0.1:8000; UI will show fallback resource entries."
fi

pnpm --filter @crewon/ui dev &
vite_pid="$!"

if [[ -n "$app_server_pid" ]]; then
  monitor_app_server &
  monitor_pid="$!"
fi

wait "$vite_pid"
