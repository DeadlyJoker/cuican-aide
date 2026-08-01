#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_platform_root=${AGENT_PLATFORM_ROOT:-"$repo_root/../agent-platform"}
verify_contract() {
    label=$1
    canonical=$2
    distribution=$3
    provenance=$4

    if [ ! -f "$canonical" ]; then
        echo "missing Agent Platform canonical $label contract: $canonical" >&2
        exit 1
    fi

    cmp "$canonical" "$distribution"

    actual_sha=$(shasum -a 256 "$canonical" | awk '{print $1}')
    expected_sha=$(sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p' "$provenance")

    if [ "$actual_sha" != "$expected_sha" ]; then
        echo "$label contract digest mismatch: expected $expected_sha, got $actual_sha" >&2
        exit 1
    fi

    echo "$label contract verified: $actual_sha"
}

verify_contract \
    "provider run" \
    "$agent_platform_root/contracts/provider/v3/provider_contract.v3.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_contract.v3.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_contract.source.json"

verify_contract \
    "provider discovery" \
    "$agent_platform_root/contracts/provider/v1/provider_discovery.v1.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_discovery.v1.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_discovery.source.json"

verify_contract \
    "provider dynamic execution" \
    "$agent_platform_root/contracts/provider/v3/provider_dynamic_execution.v3.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_dynamic_execution.v3.json" \
    "$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_dynamic_execution.source.json"
