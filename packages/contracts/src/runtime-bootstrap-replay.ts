import {
  parseRuntimeBootstrapInputs,
  type RuntimeBootstrapInputs,
} from "./runtime-bootstrap-inputs.ts";

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
  return environment;
}
