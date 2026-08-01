#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

failed=0
production_globs=(
  --glob '!**/*.test.*'
  --glob '!**/*_tests.rs'
  --glob '!**/__snapshots__/**'
  --glob '!**/*.snap'
)

assert_no_matches() {
  local label="$1"
  local pattern="$2"
  shift 2
  local matches
  if matches="$(rg -n "$pattern" "${production_globs[@]}" "$@")"; then
    echo "[FAIL] $label"
    echo "$matches"
    failed=1
  else
    echo "[PASS] $label"
  fi
}

assert_no_matches \
  "old Agent Platform execution RPCs and notifications are absent" \
  'agentPlatform/(chat|run/cancel|session)' \
  codex-rs/app-server-protocol/src \
  codex-rs/app-server-protocol/schema \
  codex-rs/app-server/src \
  codex-rs/app-server-client/src \
  apps/crewon-ui/src

assert_no_matches \
  "old execution protocol types are absent" \
  'AgentPlatform(Chat|Run)[A-Z]|AgentPlatformSession(Params|ReadResponse|ClearResponse)|AgentPlatformResourceEvent' \
  codex-rs/app-server-protocol/src \
  codex-rs/app-server-protocol/schema \
  codex-rs/app-server/src \
  codex-rs/app-server-client/src \
  apps/crewon-ui/src

assert_no_matches \
  "old UI execution authority and in-memory run machinery are absent" \
  'agentPlatformAgentId|runAgentPlatformChat|agentPlatformRuns|agentPlatformRunByThread|orphanAgentPlatform|agentPlatformThreadHistory' \
  apps/crewon-ui/src

assert_no_matches \
  "Cloud Agent failures cannot fall back to another executor" \
  '(agent.?platform|cloud.?agent).{0,80}fallback|fallback.{0,80}(agent.?platform|cloud.?agent)' \
  codex-rs/app-server/src \
  codex-rs/core/src \
  codex-rs/state/src \
  apps/crewon-ui/src

raw_route_files="$(
  rg -l 'agent-platform:agents:' "${production_globs[@]}" apps/crewon-ui/src || true
)"
expected_raw_route_file='apps/crewon-ui/src/components/app/CommandWorkspaceViews.tsx'
if [[ "$raw_route_files" != "$expected_raw_route_file" ]]; then
  echo "[FAIL] raw Agent marker must be limited to the resource catalog card id"
  printf '%s\n' "$raw_route_files"
  failed=1
else
  echo "[PASS] raw Agent marker is display-only in the resource catalog"
fi

legacy_session_files="$(
  rg -l 'agent-platform-sessions' "${production_globs[@]}" codex-rs/app-server/src || true
)"
expected_legacy_session_file='codex-rs/app-server/src/task_control/cloud_agent_legacy_importer.rs'
if [[ "$legacy_session_files" != "$expected_legacy_session_file" ]]; then
  echo "[FAIL] legacy session storage reference escaped the bounded read-only importer"
  printf '%s\n' "$legacy_session_files"
  failed=1
else
  echo "[PASS] legacy session storage is referenced only by the bounded importer"
fi

for removed_path in \
  codex-rs/app-server/src/request_processors/agent_platform_processor/admission.rs \
  codex-rs/app-server/src/request_processors/agent_platform_processor/session.rs \
  codex-rs/app-server/src/request_processors/agent_platform_processor/stream.rs \
  apps/crewon-ui/src/lib/thread/agentPlatformThreadHistory.ts \
  apps/crewon-ui/src/components/app/commandAgentPlatformSync.ts; do
  if [[ -e "$removed_path" ]]; then
    echo "[FAIL] removed execution module still exists: $removed_path"
    failed=1
  else
    echo "[PASS] removed execution module is absent: $removed_path"
  fi
done

if ! rg -q 'provider-agent:' \
  apps/crewon-ui/src/lib/provider-resource/providerAgentExecutionTargets.ts; then
  echo "[FAIL] Provider Agent picker no longer emits opaque Provider targets"
  failed=1
else
  echo "[PASS] Provider Agent picker emits opaque Provider targets"
fi

if ! rg -q 'providerAgentResourceForTarget' \
  apps/crewon-ui/src/components/app/CommandWorkspace.tsx; then
  echo "[FAIL] command workspace is not resolving Provider Agent targets through Resource Binding"
  failed=1
else
  echo "[PASS] command workspace resolves Provider Agent targets through Resource Binding"
fi

if (( failed != 0 )); then
  exit 1
fi

echo "W3-01 Cloud Agent cutover scan passed."
