#!/usr/bin/env bash
set -euo pipefail

crate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$crate_dir/Cargo.toml"

for forbidden in crewon-core crewon-app-server crewon-state sqlx reqwest; do
  if rg -n "^[[:space:]]*${forbidden}[[:space:]]*=" "$manifest" >/dev/null; then
    echo "forbidden dependency in crewon-task-runtime: ${forbidden}" >&2
    exit 1
  fi
done

if rg -n "use[[:space:]]+(crewon_core|crewon_app_server|crewon_state|sqlx|reqwest)(::|;)" "$crate_dir/src" >/dev/null; then
  echo "forbidden implementation dependency in crewon-task-runtime" >&2
  exit 1
fi

echo "task runtime dependency boundary: ok"
