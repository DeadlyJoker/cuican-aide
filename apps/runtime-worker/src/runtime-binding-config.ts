import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  bounded,
  isPlainObject,
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "./runtime-binding-schema.ts";

export { parseRuntimeBindingConfig } from "./runtime-binding-schema.ts";
export type { RuntimeBindingConfig } from "./runtime-binding-schema.ts";

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
import {
  loadRuntimeExtensionSnapshot,
  runtimeExtensionTarget,
  createRuntimeExtension,
  type RuntimeExtensionSnapshot,
  type RuntimeExtensionDependencies,
} from "./extensions/extension-runtime-config.ts";
import { registerRuntimeExtensionMaterializations } from "./extensions/extension-runtime-proof.ts";
import { responsesCompatibilityProfile } from "./responses-runtime-configuration.ts";

const MAX_CONFIG_BYTES = 1024 * 1024;

export function loadRuntimeBindingConfig(path: string): RuntimeBindingConfig {
  return parseRuntimeBindingConfig(
    readBoundedJson(
      path,
      MAX_CONFIG_BYTES,
      "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_invalid",
    ),
  );
}

/** Reads a bounded open runtime manifest and creates independent HTTP/MCP bindings. */
export function loadAgentVersionRuntimeFactory(
  path: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  remoteMcpDependencies?: RemoteMcpCompositionDependencies,
  nativeProviderApiKey?: string | null,
  extensionDependencies?: RuntimeExtensionDependencies,
): ConfiguredAgentVersionRuntimeFactory {
  return createAgentVersionRuntimeFactory({
    config: loadRuntimeBindingConfig(path),
    environment,
    remoteMcpDependencies,
    nativeProviderApiKey,
    extensionDependencies,
  });
}

/** Materializes from one copied manifest, so validation and construction cannot read different files. */
export type AgentVersionRuntimeBindingsInput = {
  config: RuntimeBindingConfig;
  environment: Readonly<Record<string, string | undefined>>;
  remoteMcpDependencies?: RemoteMcpCompositionDependencies;
  nativeProviderApiKey?: string | null;
  extensionDependencies?: RuntimeExtensionDependencies;
};

export function createAgentVersionRuntimeFactory(
  input: AgentVersionRuntimeBindingsInput,
): ConfiguredAgentVersionRuntimeFactory {
  return new ConfiguredAgentVersionRuntimeFactory(
    createAgentVersionRuntimeBindings(input),
  );
}

/** Reuses the same materializers for an explicit installed release without allocating resources. */
export function createAgentVersionRuntimeBindings(
  input: AgentVersionRuntimeBindingsInput,
): readonly AgentVersionRuntimeBinding[] {
  return runtimeBindings(
    parseRuntimeBindingConfig(input.config),
    input.environment,
    input.remoteMcpDependencies,
    input.nativeProviderApiKey,
    input.extensionDependencies,
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
  return agentVersionDeploymentCandidates(loadRuntimeBindingConfig(path));
}

export function agentVersionDeploymentCandidates(
  config: RuntimeBindingConfig,
): readonly AgentVersionDeploymentCandidate[] {
  return parseRuntimeBindingConfig(config).bindings.map((binding) => ({
    schemaVersion: "crewon.agent-version-deployment.v0",
    tenantId: binding.tenantId,
    agentVersionId: binding.agentVersionId,
    contentDigest: binding.contentDigest,
    materializationDigest: materializationDigest(binding),
    authorityId: binding.authorityId,
    workspaceBindingId: binding.workspaceBindingId,
  }));
}

function runtimeBindings(
  config: RuntimeBindingConfig,
  environment: Readonly<Record<string, string | undefined>>,
  remoteMcpDependencies: RemoteMcpCompositionDependencies | undefined,
  nativeProviderApiKey: string | null | undefined,
  extensionDependencies: RuntimeExtensionDependencies | undefined,
): readonly AgentVersionRuntimeBinding[] {
  return config.bindings.map((binding) => {
    if (
      binding.extensionConfigPath !== undefined &&
      extensionDependencies === undefined
    )
      throw new Error("extension_runtime_not_composed");
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
                extensionDependencies,
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
  snapshots?: Readonly<{
    remoteMcpConfig: RemoteMcpRuntimeConfig | null;
    extension?: RuntimeExtensionSnapshot;
  }>,
): string {
  return sha256(
    stableJson({
      schemaVersion: "crewon.agent-version-materialization.v0",
      binding,
      ...(binding.extensionConfigPath === undefined
        ? {}
        : {
            extension:
              snapshots?.extension ??
              loadRuntimeExtensionSnapshot(binding.extensionConfigPath),
          }),
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
  extensionDependencies: RuntimeExtensionDependencies | undefined,
): Promise<ToolRuntimePort> {
  const creation = new RuntimeCreationCleanup(options.failedCreationCleanup);
  try {
    const remoteMcpConfig =
      binding.remoteMcpConfigPath === null
        ? null
        : loadRemoteMcpRuntimeConfig(binding.remoteMcpConfigPath);
    const extension =
      binding.extensionConfigPath === undefined
        ? undefined
        : loadRuntimeExtensionSnapshot(binding.extensionConfigPath);
    if (
      materializationDigest(binding, { remoteMcpConfig, extension }) !==
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
    const extensionTarget =
      extension === undefined
        ? undefined
        : runtimeExtensionTarget({
            snapshot: extension,
            version,
            binding,
            materializationDigest: expectedMaterializationDigest,
          });
    if (extension !== undefined) {
      if (extensionDependencies === undefined)
        throw new Error("extension_runtime_not_composed");
      runtimes.push(
        creation.own(
          createRuntimeExtension({
            snapshot: extension,
            target: extensionTarget!,
            dependencies: extensionDependencies,
          }),
        ),
      );
    }
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
    if (extension !== undefined)
      registerRuntimeExtensionMaterializations(runtime, [
        {
          configuration: extension.configuration,
          registration: extension.registration,
          target: extensionTarget!,
          approvalRequirement: extension.approvalRequirement,
        },
      ]);
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
    // Match explicit portable Standard response compatibility; other binding cases retain their policy.
    ...(provider.requestProfile === "standard" &&
    provider.sequencePolicy === "whenPresent" &&
    responsesCompatibilityProfile(undefined, provider.endpoint) !== null
      ? { identityPolicy: "terminalAuthoritative" as const }
      : {}),
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
