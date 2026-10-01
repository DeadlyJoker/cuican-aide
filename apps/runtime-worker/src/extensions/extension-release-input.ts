import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type {
  AgentVersionAsset,
  AgentVersionDeploymentCandidate,
} from "@crewon/application";
import {
  agentVersionDeploymentCandidates,
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "../runtime-binding-config.ts";
import { NodeSha256ContentDigester } from "../standalone-adapters.ts";
import { parseRuntimeWorkerSecurityMode } from "../runtime-provider-probe-environment.ts";
import {
  loadRuntimeExtensionSnapshot,
  runtimeExtensionTarget,
} from "./extension-runtime-config.ts";

export const EXTENSION_AGENT_VERSION_ASSETS_SCHEMA =
  "crewon.extension-agent-version-assets.v0";
const BINDINGS_PATH = "CREWON_EXTENSION_RUNTIME_BINDINGS_PATH";
const ASSETS_PATH = "CREWON_EXTENSION_AGENT_VERSION_ASSETS_PATH";
const MAX_PLUGIN_VERSIONS = 32;
const MAX_BINDINGS_BYTES = 1024 * 1024;
const MAX_ASSETS_BYTES = 32 * 1024 * 1024;

export type ExtensionAgentVersionAssetsFile = Readonly<{
  schemaVersion: typeof EXTENSION_AGENT_VERSION_ASSETS_SCHEMA;
  assets: readonly AgentVersionAsset[];
}>;
export type ExtensionReleaseInput = Readonly<{
  runtimeBindings: RuntimeBindingConfig;
  assets: readonly AgentVersionAsset[];
  versions: readonly CompiledAgentVersion[];
  deployments: readonly AgentVersionDeploymentCandidate[];
}>;

/** Operator-owned supplemental files; never compiles or selects an ambient model. */
export function loadExtensionReleaseInput(input: {
  environment: Readonly<Record<string, string | undefined>>;
  tenantId: string;
  defaultAgentVersionId: string;
}): ExtensionReleaseInput | null {
  const enabled = input.environment.CREWON_EXTENSIONS_ENABLED;
  if (enabled !== undefined && enabled !== "0" && enabled !== "1")
    throw new Error("CREWON_EXTENSION_CONFIGURATION_invalid");
  const bindingsValue = input.environment[BINDINGS_PATH];
  const assetsValue = input.environment[ASSETS_PATH];
  const pathsDeclared =
    bindingsValue !== undefined || assetsValue !== undefined;
  if (
    pathsDeclared &&
    (bindingsValue === undefined || assetsValue === undefined)
  )
    throw new Error("extension_release_configuration_incomplete");
  const bindingsPath =
    bindingsValue === undefined
      ? undefined
      : filePath(bindingsValue, `${BINDINGS_PATH}_invalid`);
  const assetsPath =
    assetsValue === undefined
      ? undefined
      : filePath(assetsValue, `${ASSETS_PATH}_invalid`);
  if (enabled !== "1") return null;
  if (
    parseRuntimeWorkerSecurityMode(
      input.environment.CREWON_CONTROL_SECURITY_MODE ?? "standalone",
    ) !== "standalone"
  )
    throw new Error("extension_release_security_mode_forbidden");
  if (bindingsPath === undefined || assetsPath === undefined) return null;
  const runtimeBindings = parseRuntimeBindingConfig(
    readJson(bindingsPath, MAX_BINDINGS_BYTES, `${BINDINGS_PATH}_invalid`),
  );
  if (
    runtimeBindings.bindings.length < 1 ||
    runtimeBindings.bindings.length > MAX_PLUGIN_VERSIONS ||
    runtimeBindings.bindings.some(
      (binding) => binding.extensionConfigPath === undefined,
    )
  )
    throw new Error("extension_runtime_bindings_invalid");
  if (
    runtimeBindings.bindings.some(
      (binding) => binding.tenantId !== input.tenantId,
    )
  )
    throw new Error("runtime_deployment_tenant_mismatch");
  if (
    runtimeBindings.bindings.some(
      (binding) => binding.agentVersionId === input.defaultAgentVersionId,
    )
  )
    throw new Error("extension_default_agent_override_forbidden");
  const assetsFile = readJson(
    assetsPath,
    MAX_ASSETS_BYTES,
    `${ASSETS_PATH}_invalid`,
  );
  if (
    assetsFile === null ||
    typeof assetsFile !== "object" ||
    Array.isArray(assetsFile)
  )
    throw new Error("extension_agent_version_assets_invalid");
  const record = assetsFile as Record<string, unknown>;
  if (record.schemaVersion !== EXTENSION_AGENT_VERSION_ASSETS_SCHEMA)
    throw new Error("extension_agent_version_assets_version_unsupported");
  if (
    Object.keys(record).sort().join() !== "assets,schemaVersion" ||
    !Array.isArray(record.assets) ||
    record.assets.length < 1 ||
    record.assets.length > MAX_PLUGIN_VERSIONS
  )
    throw new Error("extension_agent_version_assets_invalid");
  const digester = new NodeSha256ContentDigester();
  const assets = record.assets.map((entry: unknown) => {
    const asset = entry as AgentVersionAsset;
    const version = parseAgentVersionAsset(asset, digester);
    if (asset.tenantId !== input.tenantId)
      throw new Error("runtime_deployment_tenant_mismatch");
    if (version.agentVersionId === input.defaultAgentVersionId)
      throw new Error("extension_default_agent_override_forbidden");
    return Object.freeze({ asset: Object.freeze({ ...asset }), version });
  });
  const byId = new Map(
    assets.map((entry) => [entry.version.agentVersionId, entry]),
  );
  if (
    byId.size !== assets.length ||
    new Set(runtimeBindings.bindings.map((binding) => binding.agentVersionId))
      .size !== runtimeBindings.bindings.length
  )
    throw new Error("runtime_release_duplicate_agent_version");
  if (assets.length !== runtimeBindings.bindings.length)
    throw new Error("runtime_release_version_deployment_mismatch");
  const deployments = agentVersionDeploymentCandidates(runtimeBindings);
  for (const [index, binding] of runtimeBindings.bindings.entries()) {
    if (binding.provider.kind !== "directResponses")
      throw new Error("extension_execution_authority_unsupported");
    const matched = byId.get(binding.agentVersionId);
    if (matched === undefined)
      throw new Error("runtime_release_version_deployment_mismatch");
    if (
      matched.version.resources.workspaceRequired !==
      (binding.workspaceBindingId !== null)
    )
      throw new Error("agent_version_workspace_binding_mismatch");
    const snapshot = loadRuntimeExtensionSnapshot(
      filePath(
        binding.extensionConfigPath!,
        "extension_runtime_config_invalid",
      ),
    );
    runtimeExtensionTarget({
      snapshot,
      version: matched.version,
      binding,
      materializationDigest: deployments[index]!.materializationDigest,
    });
  }
  const basePath = input.environment.CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH;
  if (basePath !== undefined) {
    const reserved = filePath(
      basePath.trim(),
      "CREWON_AGENT_VERSION_RUNTIME_BINDINGS_PATH_invalid",
    );
    for (const path of [
      bindingsPath,
      assetsPath,
      ...runtimeBindings.bindings.map(
        (binding) => binding.extensionConfigPath!,
      ),
    ])
      assertSeparateFile(reserved, path);
  }
  return Object.freeze({
    runtimeBindings: freezeBindings(runtimeBindings),
    assets: Object.freeze(assets.map((entry) => entry.asset)),
    versions: Object.freeze(assets.map((entry) => entry.version)),
    deployments: Object.freeze(
      deployments.map((deployment) => Object.freeze(deployment)),
    ),
  });
}

/** Additive release input; duplicate IDs are never replaced or silently dropped. */
export function mergeExtensionReleaseInput(input: {
  extension: ExtensionReleaseInput;
  existingVersions: readonly CompiledAgentVersion[];
  existingDeployments: readonly AgentVersionDeploymentCandidate[];
  tenantId: string;
  defaultAgentVersionId: string;
}) {
  const additionalAgentVersions = [
    ...input.existingVersions,
    ...input.extension.versions,
  ];
  const agentVersionDeployments = [
    ...input.existingDeployments,
    ...input.extension.deployments,
  ];
  if (
    agentVersionDeployments.some(
      (deployment) => deployment.tenantId !== input.tenantId,
    )
  )
    throw new Error("runtime_deployment_tenant_mismatch");
  if (
    [...additionalAgentVersions, ...agentVersionDeployments].some(
      (entry) => entry.agentVersionId === input.defaultAgentVersionId,
    )
  )
    throw new Error("extension_default_agent_override_forbidden");
  for (const entries of [additionalAgentVersions, agentVersionDeployments]) {
    if (
      new Set(entries.map((entry) => entry.agentVersionId)).size !==
      entries.length
    )
      throw new Error("runtime_release_duplicate_agent_version");
  }
  return Object.freeze({
    additionalAgentVersions: Object.freeze(additionalAgentVersions),
    agentVersionDeployments: Object.freeze(agentVersionDeployments),
  });
}

function filePath(value: string, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value) > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(code);
  return value;
}

function readJson(path: string, maximum: number, code: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 2 || before.size > maximum)
      throw new Error(code);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(fd);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error(code);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
  } catch (cause) {
    throw new Error(code, { cause });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSeparateFile(basePath: string, pluginPath: string): void {
  const canonical = (path: string) => {
    try {
      return realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return join(realpathSync(dirname(resolve(path))), basename(path));
    }
  };
  let aliases = canonical(basePath) === canonical(pluginPath);
  try {
    const base = statSync(basePath);
    const plugin = statSync(pluginPath);
    aliases ||= base.dev === plugin.dev && base.ino === plugin.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (aliases) throw new Error("extension_runtime_bindings_path_conflict");
}

function freezeBindings(config: RuntimeBindingConfig): RuntimeBindingConfig {
  return Object.freeze({
    schemaVersion: config.schemaVersion,
    bindings: Object.freeze(
      config.bindings.map((binding) =>
        Object.freeze({
          ...binding,
          provider: Object.freeze(binding.provider),
        }),
      ),
    ),
  });
}
