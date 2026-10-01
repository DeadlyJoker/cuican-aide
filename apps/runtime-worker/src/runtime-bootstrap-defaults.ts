import type { RuntimeBootstrapInputs } from "@crewon/contracts";

import {
  environmentOr,
  parseNonNegativeInteger,
  parsePositiveInteger,
  type RuntimeEnvironment,
} from "./runtime-environment-values.ts";

export const RUNTIME_BOOTSTRAP_DEFAULTS = Object.freeze({
  contextWindowTokens: 273_000,
  autoCompactAtTokens: 200_000,
  streamMaxRetries: 5,
  maxToolRounds: 32 as const,
  authorityId: "standalone-authority",
  runtimeGeneration: "ts-v0",
  agentVersionId: "default-agent-v1",
  policySnapshotId: "standalone-policy-v0",
});

export function resolveRuntimeBootstrapAgent(
  environment: RuntimeEnvironment,
): RuntimeBootstrapInputs["agent"] {
  return Object.freeze({
    instructions: environment.CREWON_AGENT_INSTRUCTIONS?.trim() || null,
    contextWindowTokens: parsePositiveInteger(
      environment.CREWON_MODEL_CONTEXT_WINDOW_TOKENS ??
        String(RUNTIME_BOOTSTRAP_DEFAULTS.contextWindowTokens),
      "CREWON_MODEL_CONTEXT_WINDOW_TOKENS_invalid",
    ),
    autoCompactAtTokens: parsePositiveInteger(
      environment.CREWON_AUTO_COMPACT_AT_TOKENS ??
        String(RUNTIME_BOOTSTRAP_DEFAULTS.autoCompactAtTokens),
      "CREWON_AUTO_COMPACT_AT_TOKENS_invalid",
    ),
    streamMaxRetries: parseNonNegativeInteger(
      environment.CREWON_RESPONSES_STREAM_MAX_RETRIES ??
        String(RUNTIME_BOOTSTRAP_DEFAULTS.streamMaxRetries),
      "CREWON_RESPONSES_STREAM_MAX_RETRIES_invalid",
    ),
    maxToolRounds: RUNTIME_BOOTSTRAP_DEFAULTS.maxToolRounds,
  });
}

export function resolveRuntimeBootstrapRoute(
  environment: RuntimeEnvironment,
): Omit<RuntimeBootstrapInputs["route"], "workspaceBindingId"> &
  Readonly<{ workspaceBindingId: string | null }> {
  return Object.freeze({
    authorityId: environmentOr(
      "CREWON_AUTHORITY_ID",
      RUNTIME_BOOTSTRAP_DEFAULTS.authorityId,
      environment,
    ),
    runtimeGeneration: environmentOr(
      "CREWON_RUNTIME_GENERATION",
      RUNTIME_BOOTSTRAP_DEFAULTS.runtimeGeneration,
      environment,
    ),
    agentVersionId: environmentOr(
      "CREWON_AGENT_VERSION_ID",
      RUNTIME_BOOTSTRAP_DEFAULTS.agentVersionId,
      environment,
    ),
    policySnapshotId: environmentOr(
      "CREWON_POLICY_SNAPSHOT_ID",
      RUNTIME_BOOTSTRAP_DEFAULTS.policySnapshotId,
      environment,
    ),
    workspaceBindingId: environment.CREWON_WORKSPACE_BINDING_ID?.trim() || null,
  });
}
