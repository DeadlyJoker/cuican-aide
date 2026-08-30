#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
agent_platform_source="${CREWON_AGENT_PLATFORM_SOURCE_ROOT:-$repo_root/../agent-platform}"
agent_platform_revision="${CREWON_AGENT_PLATFORM_PROVIDER_REVISION:-3c5c346}"
agent_platform_root="${CREWON_AGENT_PLATFORM_ROOT:-$repo_root/.crewon/dev/agent-platform-provider-v3}"
replace_existing="${CREWON_AGENT_HARNESS_REPLACE:-0}"
agent_platform_port="${CREWON_AGENT_PLATFORM_PROVIDER_PORT:-8002}"
agent_platform_origin="http://127.0.0.1:$agent_platform_port"
runtime_environment="$repo_root/.crewon/dev/provider-runtime/agent-platform.env.sh"
log_root="$repo_root/.crewon/dev/logs"
owned_pids=()

port_listening() {
  python3 - "$1" <<'PY'
import socket
import sys

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.settimeout(0.25)
    raise SystemExit(0 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

wait_for_url() {
  local label="$1"
  local url="$2"
  local pid="$3"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label exited before becoming ready; see $log_root/${label}.log" >&2
      return 1
    fi
    sleep 1
  done
  echo "$label did not become ready at $url; see $log_root/${label}.log" >&2
  return 1
}

wait_for_route() {
  local label="$1"
  local url="$2"
  local pid="$3"
  local deadline=$((SECONDS + 30))
  local status
  while (( SECONDS < deadline )); do
    status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
      --request POST "$url" 2>/dev/null || true)"
    if [[ "$status" =~ ^[1-4][0-9][0-9]$ && "$status" != "404" ]]; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label exited before exposing $url; see $log_root/${label}.log" >&2
      return 1
    fi
    sleep 1
  done
  echo "$label did not expose $url; see $log_root/${label}.log" >&2
  return 1
}

listener_pids() {
  lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk 'substr($0, 1, 1) == "n" { print substr($0, 2); exit }'
}

stop_owned_listener() {
  local port="$1"
  local allowed_root="$2"
  local label="$3"
  local pids=()
  local pid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(listener_pids "$port")
  if (( ${#pids[@]} == 0 )); then
    return 0
  fi
  if [[ "$replace_existing" != "1" ]]; then
    echo "$label already owns port $port; set CREWON_AGENT_HARNESS_REPLACE=1 to replace a compatible local process." >&2
    exit 1
  fi
  for pid in "${pids[@]}"; do
    local cwd
    cwd="$(pid_cwd "$pid")"
    if [[ "$cwd" != "$allowed_root" && "$cwd" != "$allowed_root/"* ]]; then
      echo "Refusing to stop $label pid $pid outside $allowed_root (cwd: ${cwd:-unknown})." >&2
      exit 1
    fi
  done
  echo "Replacing local $label on port $port: ${pids[*]}"
  kill "${pids[@]}"
  local deadline=$((SECONDS + 15))
  while (( SECONDS < deadline )); do
    port_listening "$port" || return 0
    sleep 1
  done
  echo "$label did not release port $port" >&2
  exit 1
}

cleanup() {
  local index
  for ((index=${#owned_pids[@]} - 1; index >= 0; index--)); do
    local pid="${owned_pids[$index]}"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

if [[ ! -d "$agent_platform_source/.git" ]]; then
  echo "Agent Platform source checkout is missing: $agent_platform_source" >&2
  exit 1
fi
agent_platform_source="$(cd "$agent_platform_source" && pwd)"

if [[ ! -d "$agent_platform_root" ]]; then
  mkdir -p "$(dirname "$agent_platform_root")"
  git -C "$agent_platform_source" worktree prune
  git -C "$agent_platform_source" worktree add \
    --detach "$agent_platform_root" "$agent_platform_revision"
fi

python3 "$repo_root/scripts/setup-local-provider-runtime.py" \
  --repo-root "$repo_root" \
  --agent-platform-root "$agent_platform_root" \
  --agent-platform-url "$agent_platform_origin"
python3 "$repo_root/scripts/setup-local-provider-runtime.py" \
  --repo-root "$repo_root" \
  --agent-platform-root "$agent_platform_root" \
  --agent-platform-url "$agent_platform_origin" \
  --check

mkdir -p "$log_root"

backend_python="${CREWON_AGENT_PLATFORM_PYTHON:-$agent_platform_root/backend/.venv/bin/python}"
permission_python="${CREWON_PERMISSION_SERVICE_PYTHON:-$agent_platform_root/apps/permission-service/.venv/bin/python}"
if [[ ! -x "$backend_python" ]] || ! "$backend_python" -c 'import jose, jsonschema' 2>/dev/null; then
  uv sync --project "$agent_platform_root/backend" --locked
fi
if [[ ! -x "$permission_python" ]] || ! "$permission_python" -c 'import jose, sqlalchemy' 2>/dev/null; then
  uv sync --project "$agent_platform_root/apps/permission-service"
fi

if port_listening 5175 || port_listening 3210; then
  echo "The desktop UI or Control runtime is already running. Close it before starting the full harness." >&2
  exit 1
fi

stop_owned_listener 8010 "$agent_platform_root" "permission-service"

permission_database="$repo_root/.crewon/dev/permission-service.sqlite"
(
  set -a
  # shellcheck disable=SC1090
  source "$runtime_environment"
  set +a
  export DATABASE_URL="sqlite+aiosqlite:///$permission_database"
  cd "$agent_platform_root/apps/permission-service"
  exec "$permission_python" -m uvicorn src.main:app --host 127.0.0.1 --port 8010
) >"$log_root/permission-service.log" 2>&1 &
permission_pid="$!"
owned_pids+=("$permission_pid")
wait_for_url "permission-service" "http://127.0.0.1:8010/health/ready" "$permission_pid"

source_backend_environment="$agent_platform_source/backend/.env"
database_url=""
if [[ -f "$source_backend_environment" ]]; then
  database_url="$(python3 - "$source_backend_environment" <<'PY'
from pathlib import Path
import sys

value = ""
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if stripped.startswith("export "):
        stripped = stripped.removeprefix("export ").lstrip()
    if stripped.startswith("DATABASE_URL="):
        value = stripped.split("=", 1)[1].strip().strip("'\"")
print(value)
PY
)"
fi
if [[ "$database_url" == sqlite*":///"* ]]; then
  database_url="$(python3 - "$agent_platform_source/backend" "$database_url" <<'PY'
from pathlib import Path
import sys

scheme, relative = sys.argv[2].split(":///", 1)
if relative.startswith("/"):
    print(sys.argv[2])
else:
    print(f"{scheme}:///{(Path(sys.argv[1]) / relative).resolve()}")
PY
)"
fi

stop_owned_listener "$agent_platform_port" "$agent_platform_root" "agent-platform-provider-v3"
(
  if [[ -n "$database_url" ]]; then
    export DATABASE_URL="$database_url"
  fi
  set -a
  # shellcheck disable=SC1090
  source "$runtime_environment"
  set +a
  cd "$agent_platform_root/backend"
  exec "$backend_python" -m uvicorn app.main:app --host 127.0.0.1 --port "$agent_platform_port"
) >"$log_root/agent-platform.log" 2>&1 &
agent_platform_pid="$!"
owned_pids+=("$agent_platform_pid")
wait_for_url "agent-platform" "$agent_platform_origin/health" "$agent_platform_pid"
wait_for_route "agent-platform" "$agent_platform_origin/provider/v3/descriptor:read" "$agent_platform_pid"
wait_for_route "agent-platform" "$agent_platform_origin/identity/v1/principal-sessions:issue" "$agent_platform_pid"

case "${CREWON_AGENT_PLATFORM_BOOTSTRAP:-1}" in
  1)
    CREWON_AGENT_PLATFORM_BOOTSTRAP_USERNAME="${CREWON_AGENT_PLATFORM_BOOTSTRAP_USERNAME:-admin}" \
    CREWON_AGENT_PLATFORM_BOOTSTRAP_PASSWORD="${CREWON_AGENT_PLATFORM_BOOTSTRAP_PASSWORD:-Admin123!}" \
      python3 "$repo_root/scripts/initialize-local-agent-platform.py" \
        --origin "$agent_platform_origin"
    ;;
  0)
    echo "Skipping local Agent Platform identity bootstrap."
    ;;
  *)
    echo "CREWON_AGENT_PLATFORM_BOOTSTRAP must be 0 or 1." >&2
    exit 1
    ;;
esac

echo "Local Agent harness is ready; starting the desktop Control runtime."
echo "Run 'pnpm agent:smoke' in another terminal after the desktop opens."
export CREWON_AGENT_PLATFORM_TARGET="$agent_platform_origin"
export CREWON_APP_SERVER_DISABLED=1
cd "$repo_root"
pnpm --filter @crewon/ui desktop
