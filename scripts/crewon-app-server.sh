#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crewon_home="$repo_root/.crewon"

mkdir -p "$crewon_home"

if [[ -f "$crewon_home/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$crewon_home/.env"
  set +a
fi

if [[ -f "$crewon_home/auth.json" ]]; then
  auth_exports="$(python3 - "$crewon_home/auth.json" <<'PY'
import json
import sys

try:
    auth = json.load(open(sys.argv[1]))
except Exception:
    auth = {}

for key in ("OPENAI_API_KEY", "AICUICAN_API_KEY"):
    value = auth.get(key)
    if isinstance(value, str) and value:
        print(f"export {key}={json.dumps(value)}")
PY
)"
  if [[ -n "$auth_exports" ]]; then
    eval "$auth_exports"
  fi
fi

if [[ -z "${AICUICAN_API_KEY:-}" && -n "${OPENAI_API_KEY:-}" ]]; then
  export AICUICAN_API_KEY="$OPENAI_API_KEY"
fi

export CREWON_HOME="$crewon_home"
export CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG=1
app_server_host="${CREWON_DEV_BACKEND_HOST:-127.0.0.1}"
app_server_port="${CREWON_DEV_BACKEND_PORT:-6176}"

exec cargo run \
  --manifest-path "$repo_root/codex-rs/Cargo.toml" \
  -p crewon-app-server \
  --bin crewon-app-server \
  -- \
  --listen "ws://${app_server_host}:${app_server_port}"
