import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import type { CompiledAgentVersion } from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import {
  DirectResponsesTransport,
  type DirectResponsesTransportConfig,
} from "@crewon/agent-responses";
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
import { loadRemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";
import type { RemoteMcpRuntimeConfig } from "./remote-mcp-runtime-config.ts";
import {
  composeRemoteMcpRuntime,
  type RemoteMcpBindingIdentity,
  type RemoteMcpCompositionDependencies,
} from "./remote-mcp-composition.ts";

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
    provider: Readonly<{
      kind: "directResponses";
      endpoint: string;
      apiKeyEnvironment: string | null;
      storeResponses: boolean;
      requestProfile: "standard" | "responsesLite";
      idleTimeoutMs: number;
      sequencePolicy: "required" | "whenPresent";
    }>;
    mcpStdioConfigPath: string | null;
    deviceToolConfigPath: string | null;
    remoteMcpConfigPath: string | null;
  }>[];
}>;

/** Reads a bounded open runtime manifest and creates independent HTTP/MCP bindings. */
export function loadAgentVersionRuntimeFactory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  remoteMcpDependencies?: RemoteMcpCompositionDependencies,
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
    return remoteMcpConfig.servers.map(
      (server) => ({
        mode: server.mode,
        tenantId: binding.tenantId,
        agentVersionId: binding.agentVersionId,
        contentDigest: binding.contentDigest,
        materializationDigest: materializationDigestValue,
        serverBindingId: server.serverBindingId,
        credentialBindingId: server.credentialBindingId,
        endpoint: server.endpoint,
      }),
    );
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
  if (
    !hasExactKeys(value, [
      "agentVersionId",
      "authorityId",
      "contentDigest",
      "deviceToolConfigPath",
      "mcpStdioConfigPath",
      "provider",
      "remoteMcpConfigPath",
      "tenantId",
      "workspaceBindingId",
    ])
  ) {
    throw new Error("agent_version_runtime_binding_invalid");
  }
  const provider = parseProvider(value.provider);
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
  };
}

function parseProvider(
  value: unknown,
): RuntimeBindingConfig["bindings"][number]["provider"] {
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
    value.kind !== "directResponses" ||
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
    kind: value.kind,
    endpoint: bounded(value.endpoint, 2048),
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
): readonly AgentVersionRuntimeBinding[] {
  return config.bindings.map((binding) => {
    const apiKey =
      binding.provider.apiKeyEnvironment === null
        ? null
        : requiredEnvironment(environment, binding.provider.apiKeyEnvironment);
    const expectedMaterializationDigest = materializationDigest(binding);
    return {
      tenantId: binding.tenantId,
      agentVersionId: binding.agentVersionId,
      contentDigest: binding.contentDigest,
      authorityId: binding.authorityId,
      workspaceBindingId: binding.workspaceBindingId,
      materializationDigest: expectedMaterializationDigest,
      createTransport: (version) =>
        directResponsesTransport(binding.provider, version, apiKey),
      createToolRuntime: () =>
        createBoundToolRuntime(
          binding,
          expectedMaterializationDigest,
          remoteMcpDependencies,
        ),
    };
  });
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
  expectedMaterializationDigest: string,
  remoteMcpDependencies: RemoteMcpCompositionDependencies | undefined,
): Promise<ToolRuntimePort> {
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
  try {
    if (binding.mcpStdioConfigPath !== null) {
      runtimes.push(
        await createConnectedMcpRuntime(binding.mcpStdioConfigPath),
      );
    }
    if (binding.deviceToolConfigPath !== null) {
      runtimes.push(loadDeviceToolRuntime(binding.deviceToolConfigPath));
    }
    if (binding.remoteMcpConfigPath !== null) {
      runtimes.push(
        await composeRemoteMcpRuntime(
          remoteMcpConfig!,
          {
            tenantId: binding.tenantId,
            agentVersionId: binding.agentVersionId,
            contentDigest: binding.contentDigest,
            materializationDigest: expectedMaterializationDigest,
          },
          remoteMcpDependencies!,
        ),
      );
    }
    if (runtimes.length === 0) {
      return new InMemoryToolBroker();
    }
    return runtimes.length === 1
      ? runtimes[0]!
      : new CompositeToolRuntime(runtimes);
  } catch (error) {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close?.()));
    throw error;
  }
}

function directResponsesTransport(
  provider: RuntimeBindingConfig["bindings"][number]["provider"],
  version: CompiledAgentVersion,
  apiKey: string | null,
): DirectResponsesTransport {
  const config: DirectResponsesTransportConfig = {
    endpoint: provider.endpoint,
    apiKey,
    model: version.model.modelId,
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

async function createConnectedMcpRuntime(
  path: string,
): Promise<ToolRuntimePort> {
  const input = readBoundedJson(
    path,
    512 * 1024,
    "agent_version_mcp_config_invalid",
  );
  const runtime = createStdioMcpRuntimeGroup(parseMcpStdioConfig(input));
  try {
    await runtime.connect(new AbortController().signal);
    return runtime;
  } catch (error) {
    await runtime.close();
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
