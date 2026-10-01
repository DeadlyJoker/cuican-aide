const MAX_BINDINGS = 1_000;

export type RuntimeBindingConfig = Readonly<{
  schemaVersion: "crewon.agent-version-runtime-bindings.v0";
  bindings: readonly Readonly<{
    tenantId: string;
    agentVersionId: string;
    contentDigest: string;
    authorityId: string;
    workspaceBindingId: string | null;
    provider: Readonly<
      | {
          kind: "directResponses";
          endpoint: string;
          apiKeyEnvironment: string | null;
          storeResponses: boolean;
          requestProfile: "standard" | "responsesLite";
          idleTimeoutMs: number;
          sequencePolicy: "required" | "whenPresent";
        }
      | {
          kind: "cloudAgent";
          invocationUrl: string;
          modelId: string;
          agentId: number;
          apiKeyEnvironment: string | null;
          storeResponses: boolean;
          requestProfile: "standard" | "responsesLite";
          idleTimeoutMs: number;
          sequencePolicy: "required" | "whenPresent";
        }
    >;
    mcpStdioConfigPath: string | null;
    deviceToolConfigPath: string | null;
    remoteMcpConfigPath: string | null;
    extensionConfigPath?: string;
    toolRuntimeMode?: "independent" | "shared";
  }>[];
}>;

export function parseRuntimeBindingConfig(
  input: unknown,
): RuntimeBindingConfig {
  if (
    !hasExactKeys(input, ["bindings", "schemaVersion"]) ||
    input.schemaVersion !== "crewon.agent-version-runtime-bindings.v0" ||
    !Array.isArray(input.bindings) ||
    input.bindings.length > MAX_BINDINGS
  ) {
    throw new Error("agent_version_runtime_bindings_invalid");
  }
  return {
    schemaVersion: input.schemaVersion,
    bindings: input.bindings.map(parseBinding),
  };
}

function parseBinding(
  value: unknown,
): RuntimeBindingConfig["bindings"][number] {
  const bindingKeys = [
    "agentVersionId",
    "authorityId",
    "contentDigest",
    "deviceToolConfigPath",
    "mcpStdioConfigPath",
    "provider",
    "remoteMcpConfigPath",
    "tenantId",
    "workspaceBindingId",
  ];
  const optionalKeys = isPlainObject(value)
    ? ["toolRuntimeMode", "extensionConfigPath"].filter((key) =>
        Object.hasOwn(value, key),
      )
    : [];
  if (!hasExactKeys(value, [...bindingKeys, ...optionalKeys])) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  const provider = parseProvider(value.provider);
  const toolRuntimeMode = value.toolRuntimeMode;
  if (
    toolRuntimeMode !== undefined &&
    toolRuntimeMode !== "independent" &&
    toolRuntimeMode !== "shared"
  ) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  if (
    toolRuntimeMode === "shared" &&
    (value.mcpStdioConfigPath !== null ||
      value.deviceToolConfigPath !== null ||
      value.remoteMcpConfigPath !== null ||
      value.extensionConfigPath !== undefined)
  ) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  if (
    provider.kind === "cloudAgent" &&
    (value.workspaceBindingId !== null ||
      value.mcpStdioConfigPath !== null ||
      value.deviceToolConfigPath !== null ||
      value.remoteMcpConfigPath !== null ||
      toolRuntimeMode === "shared" ||
      value.extensionConfigPath !== undefined)
  ) {
    throw new Error("agent_version_runtime_provider_authority_invalid");
  }
  return {
    tenantId: bounded(value.tenantId, 256),
    agentVersionId: bounded(value.agentVersionId, 512),
    contentDigest: digest(value.contentDigest),
    authorityId: bounded(value.authorityId, 512),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : bounded(value.workspaceBindingId, 512),
    provider,
    mcpStdioConfigPath:
      value.mcpStdioConfigPath === null
        ? null
        : bounded(value.mcpStdioConfigPath, 4096),
    deviceToolConfigPath:
      value.deviceToolConfigPath === null
        ? null
        : bounded(value.deviceToolConfigPath, 4096),
    remoteMcpConfigPath:
      value.remoteMcpConfigPath === null
        ? null
        : bounded(value.remoteMcpConfigPath, 4096),
    ...(value.extensionConfigPath === undefined
      ? {}
      : {
          extensionConfigPath: bounded(value.extensionConfigPath, 4096),
        }),
    ...(toolRuntimeMode === undefined ? {} : { toolRuntimeMode }),
  };
}

function parseProvider(
  value: unknown,
): RuntimeBindingConfig["bindings"][number]["provider"] {
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw new Error("agent_version_runtime_provider_invalid");
  }
  if (value.kind === "directResponses") {
    return parseDirectResponsesProvider(value);
  }
  if (value.kind === "cloudAgent") {
    return parseCloudAgentProvider(value);
  }
  throw new Error("agent_version_runtime_provider_invalid");
}

function parseDirectResponsesProvider(
  value: Record<string, unknown>,
): Extract<
  RuntimeBindingConfig["bindings"][number]["provider"],
  { kind: "directResponses" }
> {
  if (
    !hasExactKeys(value, [
      "apiKeyEnvironment",
      "endpoint",
      "idleTimeoutMs",
      "kind",
      "requestProfile",
      "sequencePolicy",
      "storeResponses",
    ]) ||
    typeof value.storeResponses !== "boolean" ||
    (value.requestProfile !== "standard" &&
      value.requestProfile !== "responsesLite") ||
    (value.sequencePolicy !== "required" &&
      value.sequencePolicy !== "whenPresent") ||
    !Number.isSafeInteger(value.idleTimeoutMs) ||
    Number(value.idleTimeoutMs) < 1 ||
    Number(value.idleTimeoutMs) > 300_000
  ) {
    throw new Error("agent_version_runtime_provider_invalid");
  }
  const apiKeyEnvironment =
    value.apiKeyEnvironment === null
      ? null
      : bounded(value.apiKeyEnvironment, 128);
  if (
    apiKeyEnvironment !== null &&
    !/^[A-Z][A-Z0-9_]*$/u.test(apiKeyEnvironment)
  ) {
    throw new Error("agent_version_runtime_provider_key_invalid");
  }
  return {
    kind: "directResponses",
    endpoint: bounded(value.endpoint, 2048),
    apiKeyEnvironment,
    storeResponses: value.storeResponses,
    requestProfile: value.requestProfile,
    idleTimeoutMs: Number(value.idleTimeoutMs),
    sequencePolicy: value.sequencePolicy,
  };
}

function parseCloudAgentProvider(
  value: Record<string, unknown>,
): Extract<
  RuntimeBindingConfig["bindings"][number]["provider"],
  { kind: "cloudAgent" }
> {
  if (
    !hasExactKeys(value, [
      "agentId",
      "apiKeyEnvironment",
      "idleTimeoutMs",
      "invocationUrl",
      "kind",
      "modelId",
      "requestProfile",
      "sequencePolicy",
      "storeResponses",
    ]) ||
    typeof value.storeResponses !== "boolean" ||
    (value.requestProfile !== "standard" &&
      value.requestProfile !== "responsesLite") ||
    (value.sequencePolicy !== "required" &&
      value.sequencePolicy !== "whenPresent") ||
    !Number.isSafeInteger(value.idleTimeoutMs) ||
    Number(value.idleTimeoutMs) < 1 ||
    Number(value.idleTimeoutMs) > 300_000 ||
    !Number.isSafeInteger(value.agentId) ||
    Number(value.agentId) < 1
  ) {
    throw new Error("agent_version_runtime_provider_invalid");
  }
  const apiKeyEnvironment =
    value.apiKeyEnvironment === null
      ? null
      : bounded(value.apiKeyEnvironment, 128);
  if (
    apiKeyEnvironment !== null &&
    !/^[A-Z][A-Z0-9_]*$/u.test(apiKeyEnvironment)
  ) {
    throw new Error("agent_version_runtime_provider_key_invalid");
  }
  return {
    kind: "cloudAgent",
    invocationUrl: bounded(value.invocationUrl, 2048),
    modelId: bounded(value.modelId, 256),
    agentId: Number(value.agentId),
    apiKeyEnvironment,
    storeResponses: value.storeResponses,
    requestProfile: value.requestProfile,
    idleTimeoutMs: Number(value.idleTimeoutMs),
    sequencePolicy: value.sequencePolicy,
  };
}

export function bounded(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  return value;
}

function digest(value: unknown): string {
  const parsed = bounded(value, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  return parsed;
}

function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
