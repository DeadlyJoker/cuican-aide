import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import {
  DirectResponsesTransport,
  type DirectResponsesTransportConfig,
} from "@crewon/agent-responses";
import { CloudAgentTransport } from "./cloud-agent-transport.ts";
import {
  createStdioMcpRuntimeGroup,
  parseMcpStdioConfig,
} from "@crewon/mcp-runtime";
import {
  CompositeToolRuntime,
  InMemoryToolBroker,
  type ToolRuntimePort,
} from "@crewon/tool-broker";

import {
  ConfiguredAgentVersionRuntimeFactory,
  type AgentVersionRuntimeBinding,
} from "./configured-agent-version-runtime-factory.ts";
import { loadDeviceToolRuntime } from "./device-tool-runtime-config.ts";
import { createConfiguredPimSandboxToolRuntime } from "./pim-sandbox-tool-runtime.ts";
import { loadRemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";
import type { RemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";
import {
  composeRemoteMcpRuntime,
  type RemoteMcpBindingIdentity,
  type RemoteMcpCompositionDependencies,
} from "./remote-mcp-composition.ts";

import {
  RuntimeCreationCleanup,
  createWithoutExternalAllocation,
  type RuntimeCreationOptions,
} from "./runtime-creation-cleanup.ts";

const MAX_BINDINGS = 1_000;
const MAX_CONFIG_BYTES = 1024 * 1024;

type RuntimeBindingConfig = Readonly<{
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
    toolRuntimeMode?: "independent" | "shared";
  }>[];
}>;

/** Reads a bounded open runtime manifest and creates independent HTTP/MCP bindings. */
export function loadAgentVersionRuntimeFactory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  remoteMcpDependencies?: RemoteMcpCompositionDependencies,
  nativeProviderApiKey?: string | null,
): ConfiguredAgentVersionRuntimeFactory {
  const input = readBoundedJson(
    path,
    MAX_CONFIG_BYTES,
    "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_invalid",
  );
  return new ConfiguredAgentVersionRuntimeFactory(
    runtimeBindings(
      parseRuntimeBindingConfig(input),
      environment,
      remoteMcpDependencies,
      nativeProviderApiKey,
    ),
  );
}

export type RemoteMcpManifestBinding = RemoteMcpBindingIdentity;

/** Reads the same pinned manifests used by the runtime factory, without credentials. */
export function loadRemoteMcpManifestBindings(
  path: string,
): readonly RemoteMcpManifestBinding[] {
  const input = readBoundedJson(
    path,
    MAX_CONFIG_BYTES,
    "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_invalid",
  );
  return parseRuntimeBindingConfig(input).bindings.flatMap((binding) => {
    if (binding.remoteMcpConfigPath === null) return [];
    const remoteMcpConfig = loadRemoteMcpRuntimeConfig(
      binding.remoteMcpConfigPath,
    );
    const materializationDigestValue = materializationDigest(binding, {
      remoteMcpConfig,
    });
    return remoteMcpConfig.servers.map((server) => ({
      mode: server.mode,
      tenantId: binding.tenantId,
      workspaceBindingId: binding.workspaceBindingId,
      agentVersionId: binding.agentVersionId,
      contentDigest: binding.contentDigest,
      materializationDigest: materializationDigestValue,
      serverBindingId: server.serverBindingId,
      credentialBindingId: server.credentialBindingId,
      endpoint: server.endpoint,
    }));
  });
}

/** Compiles release metadata without resolving or retaining Provider secrets. */
export function loadAgentVersionDeployments(
  path: string,
): readonly AgentVersionDeploymentCandidate[] {
  const input = readBoundedJson(
    path,
    MAX_CONFIG_BYTES,
    "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_invalid",
  );
  return parseRuntimeBindingConfig(input).bindings.map((binding) => ({
    schemaVersion: "crewon.agent-version-deployment.v0",
    tenantId: binding.tenantId,
    agentVersionId: binding.agentVersionId,
    contentDigest: binding.contentDigest,
    materializationDigest: materializationDigest(binding),
    authorityId: binding.authorityId,
    workspaceBindingId: binding.workspaceBindingId,
  }));
}

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
  if (
    !hasExactKeys(value, bindingKeys) &&
    !hasExactKeys(value, [...bindingKeys, "toolRuntimeMode"])
  ) {
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
      value.remoteMcpConfigPath !== null)
  ) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  if (
    provider.kind === "cloudAgent" &&
    (value.workspaceBindingId !== null ||
      value.mcpStdioConfigPath !== null ||
      value.deviceToolConfigPath !== null ||
      value.remoteMcpConfigPath !== null ||
      toolRuntimeMode === "shared")
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

function runtimeBindings(
  config: RuntimeBindingConfig,
  environment: Readonly<Record<string, string | undefined>>,
  remoteMcpDependencies: RemoteMcpCompositionDependencies | undefined,
  nativeProviderApiKey: string | null | undefined,
): readonly AgentVersionRuntimeBinding[] {
  return config.bindings.map((binding) => {
    const executionAuthority =
      binding.provider.kind === "cloudAgent"
        ? ("providerAgent" as const)
        : ("crewonKernel" as const);
    const apiKey = runtimeBindingApiKey(
      binding.provider,
      environment,
      nativeProviderApiKey,
    );
    const expectedMaterializationDigest = materializationDigest(binding);
    const createTransport = (() => {
      if (binding.provider.kind === "cloudAgent") {
        const provider = binding.provider;
        return (_version: CompiledAgentVersion) =>
          createCloudAgentTransport(provider, apiKey);
      }
      const provider = binding.provider;
      return (version: CompiledAgentVersion) =>
        directResponsesTransport(provider, version, apiKey);
    })();
    return {
      tenantId: binding.tenantId,
      agentVersionId: binding.agentVersionId,
      contentDigest: binding.contentDigest,
      authorityId: binding.authorityId,
      workspaceBindingId: binding.workspaceBindingId,
      materializationDigest: expectedMaterializationDigest,
      executionAuthority,
      toolRuntimeMode: binding.toolRuntimeMode,
      ...(binding.provider.kind === "directResponses"
        ? { transportOwnership: "request" as const }
        : {}),
      createTransport: (version, options = {}) =>
        createWithoutExternalAllocation(
          () => createTransport(version),
          options,
        ),
      createToolRuntime:
        executionAuthority === "providerAgent"
          ? () => new InMemoryToolBroker()
          : (version, options = {}) =>
              createBoundToolRuntime(
                binding,
                version,
                expectedMaterializationDigest,
                environment,
                remoteMcpDependencies,
                options,
              ),
    };
  });
}

function runtimeBindingApiKey(
  provider: RuntimeBindingConfig["bindings"][number]["provider"],
  environment: Readonly<Record<string, string | undefined>>,
  nativeProviderApiKey: string | null | undefined,
): string | null {
  if (provider.apiKeyEnvironment === null) return null;
  const configured = environment[provider.apiKeyEnvironment]?.trim();
  if (configured) return configured;
  if (provider.kind === "directResponses" && nativeProviderApiKey) {
    return nativeProviderApiKey;
  }
  return requiredEnvironment(environment, provider.apiKeyEnvironment);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function materializationDigest(
  binding: RuntimeBindingConfig["bindings"][number],
  snapshots?: Readonly<{ remoteMcpConfig: RemoteMcpRuntimeConfig | null }>,
): string {
  return sha256(
    stableJson({
      schemaVersion: "crewon.agent-version-materialization.v0",
      binding,
      mcpStdioConfig:
        binding.mcpStdioConfigPath === null
          ? null
          : readBoundedJson(
              binding.mcpStdioConfigPath,
              512 * 1024,
              "agent_version_materialization_config_invalid",
            ),
      deviceToolConfig:
        binding.deviceToolConfigPath === null
          ? null
          : readBoundedJson(
              binding.deviceToolConfigPath,
              512 * 1024,
              "agent_version_materialization_config_invalid",
            ),
      remoteMcpConfig:
        snapshots?.remoteMcpConfig ??
        (binding.remoteMcpConfigPath === null
          ? null
          : loadRemoteMcpRuntimeConfig(binding.remoteMcpConfigPath)),
    }),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("agent_version_materialization_config_invalid");
  }
  return encoded;
}

async function createBoundToolRuntime(
  binding: RuntimeBindingConfig["bindings"][number],
  version: CompiledAgentVersion,
  expectedMaterializationDigest: string,
  environment: Readonly<Record<string, string | undefined>>,
  remoteMcpDependencies: RemoteMcpCompositionDependencies | undefined,
  options: RuntimeCreationOptions,
): Promise<ToolRuntimePort> {
  const creation = new RuntimeCreationCleanup(options.failedCreationCleanup);
  try {
    const remoteMcpConfig =
      binding.remoteMcpConfigPath === null
        ? null
        : loadRemoteMcpRuntimeConfig(binding.remoteMcpConfigPath);
    if (
      materializationDigest(binding, { remoteMcpConfig }) !==
      expectedMaterializationDigest
    ) {
      throw new Error("agent_version_runtime_materialization_drift");
    }
    if (
      binding.remoteMcpConfigPath !== null &&
      remoteMcpDependencies === undefined
    ) {
      throw new Error("remote_mcp_runtime_not_composed");
    }
    const runtimes: ToolRuntimePort[] = [];
    const pimSandbox = createConfiguredPimSandboxToolRuntime(environment);
    if (pimSandbox !== undefined) {
      runtimes.push(creation.own(pimSandbox));
    }
    if (binding.mcpStdioConfigPath !== null) {
      runtimes.push(
        await creation.create((child) =>
          createConnectedMcpRuntime(binding.mcpStdioConfigPath!, child),
        ),
      );
    }
    if (binding.deviceToolConfigPath !== null) {
      runtimes.push(
        creation.own(
          loadDeviceToolRuntime(binding.deviceToolConfigPath, version.tools),
        ),
      );
    }
    if (binding.remoteMcpConfigPath !== null) {
      runtimes.push(
        await creation.create((child) =>
          composeRemoteMcpRuntime(
            remoteMcpConfig!,
            {
              tenantId: binding.tenantId,
              workspaceBindingId: binding.workspaceBindingId,
              agentVersionId: binding.agentVersionId,
              contentDigest: binding.contentDigest,
              materializationDigest: expectedMaterializationDigest,
            },
            remoteMcpDependencies!,
            child,
          ),
        ),
      );
    }
    const runtime =
      runtimes.length === 0
        ? new InMemoryToolBroker()
        : runtimes.length === 1
          ? runtimes[0]!
          : new CompositeToolRuntime(runtimes);
    creation.transfer();
    return runtime;
  } catch (error) {
    await creation.cleanup();
    throw error;
  }
}

function directResponsesTransport(
  provider: Extract<
    RuntimeBindingConfig["bindings"][number]["provider"],
    { kind: "directResponses" }
  >,
  version: CompiledAgentVersion,
  apiKey: string | null,
): DirectResponsesTransport {
  const config: DirectResponsesTransportConfig = {
    endpoint: provider.endpoint,
    apiKey,
    model: version.model.modelId,
    maxOutputTokens: version.model.maxOutputTokens,
    storeResponses: provider.storeResponses,
    requestProfile: provider.requestProfile,
    idleTimeoutMs: provider.idleTimeoutMs,
    sequencePolicy: provider.sequencePolicy,
  };
  return new DirectResponsesTransport(config, {
    identity: {
      adapterName: version.model.adapterName,
      adapterVersion: baseAdapterVersion(
        version.model.adapterVersion,
        provider.requestProfile,
      ),
    },
  });
}

/**
 * Creates a transport that forwards requests to a cloud Agent's invocation URL.
 *
 * Cloud Agents expose a custom streaming endpoint that accepts a `message` /
 * `history` payload and emits `message` / `done` / `error` SSE events. This
 * uses the dedicated {@link CloudAgentTransport} rather than the standard
 * Responses API transport.
 */
function createCloudAgentTransport(
  provider: Extract<
    RuntimeBindingConfig["bindings"][number]["provider"],
    { kind: "cloudAgent" }
  >,
  apiKey: string | null,
): CloudAgentTransport {
  return new CloudAgentTransport({
    invocationUrl: provider.invocationUrl,
    apiKey: apiKey ?? "",
    model: provider.modelId,
    agentId: provider.agentId,
    idleTimeoutMs: provider.idleTimeoutMs,
  });
}

async function createConnectedMcpRuntime(
  path: string,
  options: RuntimeCreationOptions,
): Promise<ToolRuntimePort> {
  const creation = new RuntimeCreationCleanup(options.failedCreationCleanup);
  try {
    const input = readBoundedJson(
      path,
      512 * 1024,
      "agent_version_mcp_config_invalid",
    );
    // Constructors only create local objects; no process starts until connect.
    const runtime = creation.own(
      createStdioMcpRuntimeGroup(parseMcpStdioConfig(input)),
    );
    await runtime.connect(new AbortController().signal);
    creation.transfer();
    return runtime;
  } catch (error) {
    await creation.cleanup();
    throw error;
  }
}

function baseAdapterVersion(
  adapterVersion: string,
  requestProfile: "standard" | "responsesLite",
): string {
  if (requestProfile === "standard") {
    return adapterVersion;
  }
  const suffix = "+responses-lite";
  if (!adapterVersion.endsWith(suffix)) {
    throw new Error("agent_version_runtime_adapter_profile_mismatch");
  }
  return adapterVersion.slice(0, -suffix.length);
}

function readBoundedJson(
  path: string,
  maxBytes: number,
  code: string,
): unknown {
  try {
    const normalized = bounded(path, 4096);
    const stat = statSync(normalized);
    if (!stat.isFile() || stat.size < 2 || stat.size > maxBytes) {
      throw new Error(code);
    }
    return JSON.parse(readFileSync(normalized, "utf8"));
  } catch (error) {
    if (error instanceof Error && error.message === code) {
      throw error;
    }
    throw new Error(code, { cause: error });
  }
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error("agent_version_runtime_provider_key_missing");
  }
  return value;
}

function bounded(value: unknown, maxLength: number): string {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
