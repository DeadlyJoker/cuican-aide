import {
  parseRuntimeBootstrapInputs,
  RUNTIME_BOOTSTRAP_INPUTS_SCHEMA,
  type RuntimeBootstrapInputs,
} from "@crewon/contracts";

import { parseDevelopmentAgentProfiles } from "./development-agent-profiles.ts";
import { resolveResponsesRuntimeConfiguration } from "./responses-runtime-configuration.ts";
import {
  resolveRuntimeBootstrapAgent,
  resolveRuntimeBootstrapRoute,
} from "./runtime-bootstrap-defaults.ts";
import {
  environmentOr,
  type RuntimeEnvironment,
} from "./runtime-environment-values.ts";
import { runtimeModelCatalog } from "./runtime-model-catalog.ts";

export type RuntimeBootstrapUnsupportedReason =
  | "runtime_bootstrap_model_adapter_unsupported"
  | "runtime_bootstrap_tooling_unsupported"
  | "runtime_bootstrap_workspace_unsupported"
  | "runtime_bootstrap_cloud_profiles_unsupported"
  | "runtime_bootstrap_configuration_unsupported";
export type RuntimeBootstrapCaptureResult =
  | Readonly<{ outcome: "eligible"; inputs: RuntimeBootstrapInputs }>
  | Readonly<{
      outcome: "unsupported";
      reasonCode: RuntimeBootstrapUnsupportedReason;
    }>;

/** Clear these parameters before applying replay; credentials and current process authority are supplied separately. */
export const RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES = Object.freeze([
  "CREWON_MODEL_ADAPTER",
  "CREWON_MODEL_ID",
  "CREWON_MODEL_CREDENTIAL_REQUIRED",
  "CREWON_RESPONSES_ENDPOINT",
  "CREWON_RESPONSES_MAX_OUTPUT_TOKENS",
  "CREWON_RESPONSES_STORE",
  "CREWON_RESPONSES_REQUEST_PROFILE",
  "CREWON_RESPONSES_IDLE_TIMEOUT_MS",
  "CREWON_RESPONSES_SEQUENCE_POLICY",
  "CREWON_RESPONSES_WEBSOCKET_ENABLED",
  "CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS",
  "CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES",
  "CREWON_AGENT_INSTRUCTIONS",
  "CREWON_MODEL_CONTEXT_WINDOW_TOKENS",
  "CREWON_AUTO_COMPACT_AT_TOKENS",
  "CREWON_RESPONSES_STREAM_MAX_RETRIES",
  "CREWON_AUTHORITY_ID",
  "CREWON_RUNTIME_GENERATION",
  "CREWON_AGENT_VERSION_ID",
  "CREWON_POLICY_SNAPSHOT_ID",
  "CREWON_WORKSPACE_BINDING_ID",
  "CREWON_MODEL_CATALOG_JSON",
  "CREWON_DEV_AGENT_PROFILES_JSON",
  "CREWON_MCP_STDIO_CONFIG_PATH",
  "CREWON_DESKTOP_WORKSPACE_ROOT",
  "CREWON_NATIVE_WORKSPACE_READ_ENABLED",
  "CREWON_DEVICE_TOOL_CONFIG_PATH",
  "CREWON_PIM_SANDBOX_BASE_URL",
  "CREWON_PIM_SANDBOX_USERNAME",
  "CREWON_PIM_SANDBOX_PASSWORD",
  "CREWON_PIM_SANDBOX_AGENT_ID",
] as const);

const TOOL_CONFIGURATION_NAMES = [
  "CREWON_MCP_STDIO_CONFIG_PATH",
  "CREWON_DEVICE_TOOL_CONFIG_PATH",
  "CREWON_PIM_SANDBOX_BASE_URL",
  "CREWON_PIM_SANDBOX_USERNAME",
  "CREWON_PIM_SANDBOX_PASSWORD",
  "CREWON_PIM_SANDBOX_AGENT_ID",
] as const;

/** Eligibility concerns automatic recovery only; normal startup never calls this gate. */
export function captureRuntimeBootstrapInputs(
  environment: RuntimeEnvironment,
): RuntimeBootstrapCaptureResult {
  // Check unsupported tool presence without copying its private credential values.
  if (TOOL_CONFIGURATION_NAMES.some((name) => environment[name]?.trim()))
    return unsupported("runtime_bootstrap_tooling_unsupported");
  // Capture only recognized nonsecret parameters, never the whole environment.
  const snapshot = Object.fromEntries(
    RUNTIME_BOOTSTRAP_ENVIRONMENT_CLEAR_NAMES.filter(
      (name) => !(TOOL_CONFIGURATION_NAMES as readonly string[]).includes(name),
    ).map((name) => [name, environment[name]]),
  );
  if (
    environmentOr("CREWON_MODEL_ADAPTER", "responses", snapshot) !== "responses"
  )
    return unsupported("runtime_bootstrap_model_adapter_unsupported");
  if (
    snapshot.CREWON_DESKTOP_WORKSPACE_ROOT?.trim() ||
    snapshot.CREWON_WORKSPACE_BINDING_ID?.trim() ||
    (snapshot.CREWON_NATIVE_WORKSPACE_READ_ENABLED !== undefined &&
      snapshot.CREWON_NATIVE_WORKSPACE_READ_ENABLED !== "0")
  )
    return unsupported("runtime_bootstrap_workspace_unsupported");
  try {
    const profiles = parseDevelopmentAgentProfiles(
      snapshot.CREWON_DEV_AGENT_PROFILES_JSON,
    );
    if (profiles.some((profile) => profile.cloudAgent !== undefined))
      return unsupported("runtime_bootstrap_cloud_profiles_unsupported");
    const resolved = resolveResponsesRuntimeConfiguration(snapshot);
    const route = resolveRuntimeBootstrapRoute(snapshot);
    const catalog = runtimeModelCatalog(
      snapshot.CREWON_MODEL_CATALOG_JSON,
      resolved.config.model,
    );
    const inputs = parseRuntimeBootstrapInputs({
      schemaVersion: RUNTIME_BOOTSTRAP_INPUTS_SCHEMA,
      model: {
        endpoint: resolved.config.endpoint,
        modelId: resolved.config.model,
        credentialRequired: snapshot.CREWON_MODEL_CREDENTIAL_REQUIRED !== "0",
        maxOutputTokens: resolved.config.maxOutputTokens ?? null,
        storeResponses: resolved.config.storeResponses,
        requestProfile: resolved.config.requestProfile,
        idleTimeoutMs: resolved.config.idleTimeoutMs,
        sequencePolicy: resolved.config.sequencePolicy,
        identityPolicy: resolved.config.identityPolicy,
        outputDeltaFlushBytes: resolved.config.outputDeltaFlushBytes ?? null,
        websocket: resolved.websocket,
      },
      agent: resolveRuntimeBootstrapAgent(snapshot),
      route,
      modelCatalog:
        snapshot.CREWON_MODEL_CATALOG_JSON === undefined ? null : catalog,
      profiles,
      tooling: {
        mcpStdioConfigPath: null,
        desktopWorkspaceRoot: null,
        nativeWorkspaceReadCatalog: "disabled",
      },
    });
    return Object.freeze({ outcome: "eligible", inputs });
  } catch {
    // A fixed code cannot leak a secret from a caller's error or malformed input.
    return unsupported("runtime_bootstrap_configuration_unsupported");
  }
}

/** Returns only nonsecret parameters. Clear the exported list, apply these values, then supply current trusted credentials/authority. */
export function replayRuntimeBootstrapInputs(
  input: RuntimeBootstrapInputs,
): Readonly<Record<string, string>> {
  const inputs = parseRuntimeBootstrapInputs(input);
  const model = inputs.model;
  const environment = Object.freeze({
    CREWON_MODEL_ADAPTER: "responses",
    CREWON_MODEL_ID: model.modelId,
    CREWON_MODEL_CREDENTIAL_REQUIRED: model.credentialRequired ? "1" : "0",
    CREWON_RESPONSES_ENDPOINT: model.endpoint,
    ...(model.maxOutputTokens === null
      ? {}
      : { CREWON_RESPONSES_MAX_OUTPUT_TOKENS: String(model.maxOutputTokens) }),
    CREWON_RESPONSES_STORE: String(model.storeResponses),
    CREWON_RESPONSES_REQUEST_PROFILE: model.requestProfile,
    CREWON_RESPONSES_IDLE_TIMEOUT_MS: String(model.idleTimeoutMs),
    CREWON_RESPONSES_SEQUENCE_POLICY: model.sequencePolicy,
    CREWON_RESPONSES_WEBSOCKET_ENABLED: String(model.websocket !== null),
    ...(model.websocket === null
      ? {}
      : {
          CREWON_RESPONSES_WEBSOCKET_CONNECT_TIMEOUT_MS: String(
            model.websocket.connectTimeoutMs,
          ),
          CREWON_RESPONSES_WEBSOCKET_MAX_RETRIES: String(
            model.websocket.maxRetries,
          ),
        }),
    ...(inputs.agent.instructions === null
      ? {}
      : { CREWON_AGENT_INSTRUCTIONS: inputs.agent.instructions }),
    CREWON_MODEL_CONTEXT_WINDOW_TOKENS: String(
      inputs.agent.contextWindowTokens,
    ),
    CREWON_AUTO_COMPACT_AT_TOKENS: String(inputs.agent.autoCompactAtTokens),
    CREWON_RESPONSES_STREAM_MAX_RETRIES: String(inputs.agent.streamMaxRetries),
    CREWON_AUTHORITY_ID: inputs.route.authorityId,
    CREWON_RUNTIME_GENERATION: inputs.route.runtimeGeneration,
    CREWON_AGENT_VERSION_ID: inputs.route.agentVersionId,
    CREWON_POLICY_SNAPSHOT_ID: inputs.route.policySnapshotId,
    ...(inputs.modelCatalog === null
      ? {}
      : { CREWON_MODEL_CATALOG_JSON: JSON.stringify(inputs.modelCatalog) }),
    CREWON_DEV_AGENT_PROFILES_JSON: JSON.stringify(inputs.profiles),
    CREWON_NATIVE_WORKSPACE_READ_ENABLED: "0",
  });
  const recaptured = captureRuntimeBootstrapInputs(environment);
  if (
    recaptured.outcome !== "eligible" ||
    JSON.stringify(recaptured.inputs) !== JSON.stringify(inputs)
  )
    throw new Error("runtime_bootstrap_inputs_unreplayable");
  return environment;
}

function unsupported(
  reasonCode: RuntimeBootstrapUnsupportedReason,
): RuntimeBootstrapCaptureResult {
  return Object.freeze({ outcome: "unsupported", reasonCode });
}
