#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_platform_root=${AGENT_PLATFORM_ROOT:-"$repo_root/../agent-platform"}
canonical="$agent_platform_root/contracts/identity/v1/provider_identity_source.v1.json"
distribution="$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_identity_source.v1.json"
provenance="$repo_root/codex-rs/app-server-protocol/schema/canonical/provider_identity_source.source.json"

if [ ! -f "$canonical" ]; then
    echo "missing Agent Platform canonical identity source contract: $canonical" >&2
    exit 1
fi

cmp "$canonical" "$distribution"

actual_sha=$(shasum -a 256 "$canonical" | awk '{print $1}')
expected_sha=$(sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p' "$provenance")

if [ "$actual_sha" != "$expected_sha" ]; then
    echo "identity source contract digest mismatch: expected $expected_sha, got $actual_sha" >&2
    exit 1
fi

echo "provider identity source contract verified: $actual_sha"
