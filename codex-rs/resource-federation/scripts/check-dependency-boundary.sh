#!/usr/bin/env bash
set -euo pipefail

crate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$crate_dir/Cargo.toml"

for forbidden in reqwest sqlx crewon-app-server crewon-core; do
  if rg -n "^[[:space:]]*${forbidden}[[:space:]]*=" "$manifest" >/dev/null; then
    echo "forbidden dependency in crewon-resource-federation: ${forbidden}" >&2
    exit 1
  fi
done

if rg -n "use[[:space:]]+(reqwest|sqlx|crewon_app_server|crewon_core)(::|;)" "$crate_dir/src" >/dev/null; then
  echo "forbidden implementation dependency in crewon-resource-federation" >&2
  exit 1
fi

echo "resource federation dependency boundary: ok"
