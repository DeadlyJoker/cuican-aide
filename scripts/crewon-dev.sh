#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_server_host="127.0.0.1"
app_server_port="6176"
app_server_url="ws://${app_server_host}:${app_server_port}"
ui_host="127.0.0.1"
ui_port="${CREWON_DEV_UI_PORT:-5175}"

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
  local timeout="${CREWON_DEV_BACKEND_READY_TIMEOUT:-360}"
  if [[ ! "$timeout" =~ ^[0-9]+$ ]]; then
    timeout="360"
  fi
  local deadline=$((SECONDS + timeout))
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

listening_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk 'substr($0, 1, 1) == "n" { print substr($0, 2); exit }'
}

is_repo_app_server_pid() {
  local pid="$1"
  local command
  local cwd
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  cwd="$(pid_cwd "$pid")"

  [[ "$cwd" == "$repo_root" && "$command" == *"crewon-app-server"* && "$command" == *"--listen ${app_server_url}"* ]]
}

is_repo_vite_pid() {
  local pid="$1"
  local command
  local cwd
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  cwd="$(pid_cwd "$pid")"

  [[ "$cwd" == "$repo_root/apps/crewon-ui" && "$command" == *"vite"* && "$command" == *"--host ${ui_host}"* ]]
}

stop_existing_ui_server() {
  local pids=("$@")

  if (( ${#pids[@]} == 0 )); then
    return 0
  fi

  for existing_pid in "${pids[@]}"; do
    if ! is_repo_vite_pid "$existing_pid"; then
      echo "Port ${ui_port} is already occupied by a non-CrewON UI process: pid ${existing_pid}" >&2
      echo "Stop that process first, or set CREWON_DEV_UI_PORT to another fixed port." >&2
      exit 1
    fi
  done

  echo "Stopping existing CrewON UI dev server on http://${ui_host}:${ui_port}: ${pids[*]}"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  local deadline=$((SECONDS + 12))
  while (( SECONDS < deadline )); do
    if ! port_listening "$ui_host" "$ui_port"; then
      return 0
    fi
    sleep 1
  done

  echo "CrewON UI dev server did not stop cleanly on http://${ui_host}:${ui_port}" >&2
  return 1
}

stop_existing_app_server() {
  local pids=("$@")

  if (( ${#pids[@]} == 0 )); then
    return 0
  fi

  echo "Restarting existing crewon-app-server on ${app_server_url}: ${pids[*]}"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done

  local deadline=$((SECONDS + 12))
  while (( SECONDS < deadline )); do
    if ! port_listening "$app_server_host" "$app_server_port"; then
      return 0
    fi
    sleep 1
  done

  echo "crewon-app-server did not stop cleanly on ${app_server_url}" >&2
  return 1
}

app_server_pid=""
app_server_owned="0"
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
  if [[ "$app_server_owned" == "1" ]] && [[ -n "$app_server_pid" ]] && kill -0 "$app_server_pid" 2>/dev/null; then
    kill "$app_server_pid" 2>/dev/null || true
    wait "$app_server_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

existing_ui_pids=()
while IFS= read -r existing_pid; do
  [[ -n "$existing_pid" ]] && existing_ui_pids+=("$existing_pid")
done < <(listening_pids "$ui_port")
if [[ -n "${existing_ui_pids[*]-}" ]]; then
  stop_existing_ui_server "${existing_ui_pids[@]}"
fi

monitor_app_server() {
  local lost_checks="0"
  local max_lost_checks="${CREWON_DEV_BACKEND_LOST_CHECKS:-6}"
  if [[ ! "$max_lost_checks" =~ ^[0-9]+$ ]] || (( max_lost_checks < 1 )); then
    max_lost_checks="6"
  fi

  while [[ -n "$vite_pid" ]] && kill -0 "$vite_pid" 2>/dev/null; do
    if port_listening "$app_server_host" "$app_server_port"; then
      lost_checks="0"
    else
      lost_checks=$((lost_checks + 1))
      if (( lost_checks >= max_lost_checks )); then
        echo "crewon-app-server stayed unavailable on ${app_server_url}; stopping UI dev server." >&2
        kill "$vite_pid" 2>/dev/null || true
        return 0
      fi
    fi
    sleep 2
  done
}

remember_existing_app_server_pid() {
  existing_app_server_pids=()
  while IFS= read -r existing_pid; do
    [[ -n "$existing_pid" ]] && existing_app_server_pids+=("$existing_pid")
  done < <(listening_pids "$app_server_port")

  if [[ -n "${existing_app_server_pids[*]-}" ]]; then
    app_server_pid="${existing_app_server_pids[0]}"
  fi
}

if port_listening "$app_server_host" "$app_server_port"; then
  existing_app_server_pids=()
  while IFS= read -r existing_pid; do
    [[ -n "$existing_pid" ]] && existing_app_server_pids+=("$existing_pid")
  done < <(listening_pids "$app_server_port")
  if [[ "${CREWON_DEV_REUSE_BACKEND:-0}" == "1" ]]; then
    if [[ -n "${existing_app_server_pids[*]-}" ]]; then
      echo "Reusing existing crewon-app-server on ${app_server_url}: ${existing_app_server_pids[*]}"
      app_server_pid="${existing_app_server_pids[0]}"
    else
      echo "Reusing existing crewon-app-server on ${app_server_url}: unknown pid"
    fi
  else
    if [[ -n "${existing_app_server_pids[*]-}" ]]; then
      for existing_pid in "${existing_app_server_pids[@]}"; do
        if ! is_repo_app_server_pid "$existing_pid"; then
          echo "Port ${app_server_port} is already occupied by a non-CrewON dev process: pid ${existing_pid}" >&2
          echo "Stop that process first, or set CREWON_DEV_REUSE_BACKEND=1 to reuse it intentionally." >&2
          exit 1
        fi
      done
      stop_existing_app_server "${existing_app_server_pids[@]}"
    fi
  fi
fi

if port_listening "$app_server_host" "$app_server_port"; then
  echo "crewon-app-server already listening on ${app_server_url}"
  if [[ -z "$app_server_pid" ]]; then
    remember_existing_app_server_pid
  fi
else
  echo "Starting crewon-app-server on ${app_server_url}"
  bash "$repo_root/scripts/crewon-app-server.sh" &
  app_server_pid="$!"
  app_server_owned="1"
  echo "Waiting up to ${CREWON_DEV_BACKEND_READY_TIMEOUT:-360}s for crewon-app-server to become ready."
  if ! wait_for_port "$app_server_host" "$app_server_port" "$app_server_pid"; then
    echo "crewon-app-server did not become ready on ${app_server_url}" >&2
    exit 1
  fi
fi

if ! port_listening 127.0.0.1 8000; then
  echo "agent-platform is not listening on http://127.0.0.1:8000; UI will show fallback resource entries."
fi

VITE_CREWON_DEFAULT_CWD="$repo_root" pnpm --filter @crewon/ui dev --port "$ui_port" --strictPort &
vite_pid="$!"

monitor_app_server &
monitor_pid="$!"

wait "$vite_pid"
