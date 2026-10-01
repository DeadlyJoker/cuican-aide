import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { CompiledAgentVersion } from "@crewon/agent-version";
import type {
  ExtensionExecutionAccessPort,
  ExtensionRegistration,
  ExtensionStore,
  ExternalOperationStore,
  RunStore,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  validateExtensionConfiguration,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type { ToolExecutionPolicy } from "@crewon/tool-broker";
import type { NetworkDnsResolver } from "../network-egress.ts";
import type { PinnedHttpPort } from "../pinned-node-http.ts";
import { bundledComfyRegistration } from "./comfyui-bundled-registration.ts";
import { BoundComfyToolRuntime } from "./comfyui-bound-runtime.ts";
import { comfyServiceUrl } from "./comfyui-http.ts";
import { comfyToolDefinitions } from "./comfyui-tool-catalog.ts";

const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export type RuntimeExtensionSnapshot = Readonly<{
  schemaVersion: "crewon.extension-runtime-config.v0";
  configuration: ExtensionConfiguration;
  approvalRequirement: ToolExecutionPolicy["approvalRequirement"];
  registration: ExtensionRegistration;
}>;
export type RuntimeExtensionDependencies = Readonly<{
  extensions: ExtensionStore;
  operations: ExternalOperationStore;
  runs: Pick<RunStore, "loadRun">;
  access: ExtensionExecutionAccessPort;
  dns?: NetworkDnsResolver;
  transport?: PinnedHttpPort;
  now?: () => Date;
}>;

/** Deployment-owned config file, not a path supplied by the model or a task request. */
export function loadRuntimeExtensionSnapshot(
  path: string,
): RuntimeExtensionSnapshot {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > 32 * 1024)
    throw new Error("extension_runtime_config_invalid");
  const bytes = readFileSync(path);
  if (bytes.byteLength > 32 * 1024)
    throw new Error("extension_runtime_config_invalid");
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !==
      ["approvalRequirement", "configuration", "schemaVersion"].join() ||
    input.schemaVersion !== "crewon.extension-runtime-config.v0" ||
    (input.approvalRequirement !== "none" &&
      input.approvalRequirement !== "perAction")
  )
    throw new Error("extension_runtime_config_invalid");
  const bundled = bundledComfyRegistration();
  const registration = Object.freeze({
    manifest: bundled.manifest,
    manifestDigest: bundled.manifestDigest,
    implementationDigest: bundled.implementationDigest,
  });
  const configuration = validateComfyConfiguration(
    input.configuration,
    registration,
  );
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    configuration,
    approvalRequirement: input.approvalRequirement,
    registration,
  });
}

/** Semantic validation only; no DNS, credentials, model allocation or provider request. */
export function validateComfyConfiguration(
  input: unknown,
  registration: ExtensionRegistration,
): ExtensionConfiguration {
  const configuration = parseExtensionConfiguration(input, digester);
  if (
    configuration.pluginId !== registration.manifest.pluginId ||
    configuration.pluginVersion !== registration.manifest.version ||
    configuration.manifestDigest !== registration.manifestDigest ||
    configuration.implementationDigest !== registration.implementationDigest ||
    configuration.credentialBindings.length !== 0
  )
    throw new Error("extension_implementation_unavailable");
  validateExtensionConfiguration(
    registration.manifest,
    configuration.parameters,
  );
  if (typeof configuration.parameters.baseUrl !== "string")
    throw new Error("comfy_configuration_invalid");
  comfyServiceUrl(configuration.parameters.baseUrl);
  return configuration;
}

export function runtimeExtensionTarget(input: {
  snapshot: RuntimeExtensionSnapshot;
  version: CompiledAgentVersion;
  binding: Readonly<{
    tenantId: string;
    agentVersionId: string;
    contentDigest: string;
    authorityId: string;
    workspaceBindingId: string | null;
  }>;
  materializationDigest: string;
}): ExtensionExecutionTarget {
  const { snapshot, version, binding } = input;
  const required = comfyToolDefinitions();
  if (
    snapshot.configuration.tenantId !== binding.tenantId ||
    version.agentVersionId !== binding.agentVersionId ||
    version.contentDigest !== binding.contentDigest ||
    version.instructions === null ||
    !version.instructions.includes(
      snapshot.registration.manifest.task.instructions,
    ) ||
    required.some(
      (definition) =>
        !version.tools.some(
          (tool) =>
            extensionCanonicalJson(tool) === extensionCanonicalJson(definition),
        ),
    )
  )
    throw new Error("extension_agent_version_mismatch");
  return {
    executionAuthority: "crewonKernel",
    agentVersionId: version.agentVersionId,
    agentVersionContentDigest: version.contentDigest,
    materializationDigest: input.materializationDigest,
    authorityId: binding.authorityId,
    runtimeGeneration: version.runtimeGeneration,
    policySnapshotId: version.policySnapshotId,
    workspaceBindingId: binding.workspaceBindingId,
  };
}

export function createRuntimeExtension(input: {
  snapshot: RuntimeExtensionSnapshot;
  target: ExtensionExecutionTarget;
  dependencies: RuntimeExtensionDependencies;
}): BoundComfyToolRuntime {
  return new BoundComfyToolRuntime({
    ...input.dependencies,
    configuration: input.snapshot.configuration,
    registration: input.snapshot.registration,
    approvalRequirement: input.snapshot.approvalRequirement,
    target: input.target,
  });
}
