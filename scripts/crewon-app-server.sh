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

export CREWON_HOME="$crewon_home"
export CREWON_APP_SERVER_DISABLE_MANAGED_CONFIG=1

exec cargo run \
  --manifest-path "$repo_root/codex-rs/Cargo.toml" \
  -p crewon-app-server \
  --bin crewon-app-server \
  -- \
  --listen ws://127.0.0.1:6176
