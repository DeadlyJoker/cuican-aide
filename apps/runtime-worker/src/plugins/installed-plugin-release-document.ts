import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import {
  parseCompiledAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import type { AgentVersionDeploymentCandidate } from "@crewon/application";
import {
  extensionDigest,
  extensionOpaqueId,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
  type ExtensionConfiguration,
  type ExtensionExecutionTarget,
  type PluginProfileScope,
} from "@crewon/domain";
import {
  parseRuntimeBindingConfig,
  type RuntimeBindingConfig,
} from "../runtime-binding-config.ts";
import { ioJson } from "./plugin-execution-io-network.ts";

export const INSTALLED_PLUGIN_RELEASE_SCHEMA =
  "crewon.installed-plugin-release.v1";
export const INSTALLED_PLUGIN_RELEASE_MAX_BYTES = 1024 * 1024;
export type InstalledPluginReleaseIdentity = Readonly<{
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
}>;
export type InstalledPluginReleaseModelSource = Readonly<{
  executionAuthority: "crewonKernel";
  runtimeBinding: RuntimeBindingConfig["bindings"][number];
  version: CompiledAgentVersion;
  deployment: AgentVersionDeploymentCandidate;
}>;
export type InstalledPluginReleaseEntry = Readonly<{
  scope: PluginProfileScope;
  packageIdentity: InstalledPluginReleaseIdentity;
  configuration: ExtensionConfiguration;
  approvalRequirement: "none" | "perAction";
  modelSource: InstalledPluginReleaseModelSource;
  version: CompiledAgentVersion;
  target: ExtensionExecutionTarget;
}>;
/** Explicit published identities; this document neither selects nor constructs a default Agent. */
export type InstalledPluginReleaseDocument = Readonly<{
  schemaVersion: typeof INSTALLED_PLUGIN_RELEASE_SCHEMA;
  tenantId: string;
  defaultAgentVersionId: string;
  entries: readonly InstalledPluginReleaseEntry[];
}>;
export const installedPluginReleaseDigester = Object.freeze({
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
});

export function installedPluginReleaseFailure(code: string): never {
  throw new Error(`installed_plugin_release_${code}`);
}

function exact(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    installedPluginReleaseFailure("document_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (field) => !field.enumerable || !Object.hasOwn(field, "value"),
    )
  )
    installedPluginReleaseFailure("document_invalid");
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, field]) => [key, field.value]),
  );
}

export function parseInstalledPluginReleaseDeployment(
  input: unknown,
): AgentVersionDeploymentCandidate {
  const value = exact(input, [
    "schemaVersion",
    "tenantId",
    "agentVersionId",
    "contentDigest",
    "materializationDigest",
    "authorityId",
    "workspaceBindingId",
  ]);
  if (value.schemaVersion !== "crewon.agent-version-deployment.v0")
    installedPluginReleaseFailure("deployment_invalid");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    tenantId: extensionOpaqueId(value.tenantId),
    agentVersionId: extensionOpaqueId(value.agentVersionId),
    contentDigest: extensionDigest(value.contentDigest),
    materializationDigest: extensionDigest(value.materializationDigest),
    authorityId: extensionOpaqueId(value.authorityId),
    workspaceBindingId:
      value.workspaceBindingId === null
        ? null
        : extensionOpaqueId(value.workspaceBindingId),
  });
}

/** Own data only and bounded before semantic parsers; plugin/caller getters are never evaluated. */
export function parseInstalledPluginReleaseDocument(
  input: unknown,
): InstalledPluginReleaseDocument {
  let copied: unknown;
  try {
    copied = ioJson(input, INSTALLED_PLUGIN_RELEASE_MAX_BYTES);
  } catch (error) {
    throw new Error("installed_plugin_release_document_invalid", {
      cause: error,
    });
  }
  const document = exact(copied, [
    "schemaVersion",
    "tenantId",
    "defaultAgentVersionId",
    "entries",
  ]);
  if (
    document.schemaVersion !== INSTALLED_PLUGIN_RELEASE_SCHEMA ||
    !Array.isArray(document.entries) ||
    document.entries.length < 1 ||
    document.entries.length > 32
  )
    installedPluginReleaseFailure("document_invalid");
  const tenantId = extensionOpaqueId(document.tenantId);
  const defaultAgentVersionId = extensionOpaqueId(
    document.defaultAgentVersionId,
  );
  const entries = document.entries.map((input) =>
    parseEntry(input, tenantId, defaultAgentVersionId),
  );
  const ids = new Set(entries.map((entry) => entry.version.agentVersionId));
  if (ids.size !== entries.length)
    installedPluginReleaseFailure("version_conflict");
  return deepFreeze({
    schemaVersion: INSTALLED_PLUGIN_RELEASE_SCHEMA,
    tenantId,
    defaultAgentVersionId,
    entries,
  });
}

function parseEntry(
  input: unknown,
  tenantId: string,
  defaultAgentVersionId: string,
): InstalledPluginReleaseEntry {
  const value = exact(input, [
    "scope",
    "packageIdentity",
    "configuration",
    "approvalRequirement",
    "modelSource",
    "version",
    "target",
  ]);
  const scope = parsePluginProfileScope(value.scope);
  const identity = exact(value.packageIdentity, [
    "pluginId",
    "publisherId",
    "version",
    "packageDigest",
  ]);
  const packageIdentity = {
    pluginId: extensionOpaqueId(identity.pluginId),
    publisherId: extensionOpaqueId(identity.publisherId),
    version: extensionOpaqueId(identity.version),
    packageDigest: extensionDigest(identity.packageDigest),
  };
  const configuration = parseExtensionConfiguration(
    value.configuration,
    installedPluginReleaseDigester,
  );
  if (
    value.approvalRequirement !== "none" &&
    value.approvalRequirement !== "perAction"
  )
    installedPluginReleaseFailure("approval_invalid");
  const model = exact(value.modelSource, [
    "executionAuthority",
    "runtimeBinding",
    "version",
    "deployment",
  ]);
  const runtimeBinding = parseRuntimeBindingConfig({
    schemaVersion: "crewon.agent-version-runtime-bindings.v0",
    bindings: [model.runtimeBinding],
  }).bindings[0]!;
  if (
    model.executionAuthority !== "crewonKernel" ||
    runtimeBinding.provider.kind !== "directResponses" ||
    runtimeBinding.extensionConfigPath !== undefined ||
    runtimeBinding.toolRuntimeMode === "shared"
  )
    installedPluginReleaseFailure("model_source_unsupported");
  const baseVersion = parseCompiledAgentVersion(
    JSON.stringify(model.version),
    installedPluginReleaseDigester,
  );
  const deployment = parseInstalledPluginReleaseDeployment(model.deployment);
  const version = parseCompiledAgentVersion(
    JSON.stringify(value.version),
    installedPluginReleaseDigester,
  );
  const target = parseExtensionExecutionTarget(value.target);
  if (
    scope.tenantId !== tenantId ||
    configuration.tenantId !== scope.tenantId ||
    configuration.spaceId !== scope.spaceId ||
    configuration.pluginId !== packageIdentity.pluginId ||
    configuration.pluginVersion !== packageIdentity.version ||
    runtimeBinding.tenantId !== tenantId ||
    deployment.tenantId !== tenantId ||
    deployment.agentVersionId !== baseVersion.agentVersionId ||
    runtimeBinding.agentVersionId !== baseVersion.agentVersionId ||
    runtimeBinding.contentDigest !== baseVersion.contentDigest ||
    deployment.contentDigest !== baseVersion.contentDigest ||
    runtimeBinding.authorityId !== deployment.authorityId ||
    runtimeBinding.workspaceBindingId !== deployment.workspaceBindingId ||
    baseVersion.resources.workspaceRequired !==
      (deployment.workspaceBindingId !== null) ||
    version.agentVersionId === defaultAgentVersionId ||
    version.agentVersionId === baseVersion.agentVersionId ||
    target.executionAuthority !== "crewonKernel" ||
    target.agentVersionId !== version.agentVersionId ||
    target.agentVersionContentDigest !== version.contentDigest ||
    target.runtimeGeneration !== version.runtimeGeneration ||
    target.policySnapshotId !== version.policySnapshotId ||
    target.workspaceBindingId !== deployment.workspaceBindingId
  )
    installedPluginReleaseFailure("identity_mismatch");
  return {
    scope,
    packageIdentity,
    configuration,
    approvalRequirement: value.approvalRequirement,
    modelSource: {
      executionAuthority: "crewonKernel",
      runtimeBinding,
      version: baseVersion,
      deployment,
    },
    version,
    target,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Snapshot one operator-owned file. No secrets or filesystem paths are exposed to plugin/UI code. */
export function readInstalledPluginReleaseDocument(
  path: string,
): InstalledPluginReleaseDocument {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    path.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    installedPluginReleaseFailure("path_invalid");
  const original = lstatSync(path);
  if (!original.isFile() || original.isSymbolicLink())
    installedPluginReleaseFailure("file_invalid");
  const canonical = realpathSync(path);
  const descriptor = openSync(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      typeof process.getuid !== "function" ||
      before.uid !== process.getuid() ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > INSTALLED_PLUGIN_RELEASE_MAX_BYTES ||
      before.dev !== original.dev ||
      before.ino !== original.ino
    )
      installedPluginReleaseFailure("file_invalid");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(
        descriptor,
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (read === 0) break;
      count += read;
    }
    const after = fstatSync(descriptor),
      current = lstatSync(path);
    if (
      count !== before.size ||
      after.size !== before.size ||
      after.nlink !== 1 ||
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.nlink !== 1 ||
      current.uid !== before.uid ||
      current.mode !== before.mode ||
      current.isSymbolicLink() ||
      realpathSync(path) !== canonical
    )
      installedPluginReleaseFailure("file_changed");
    return parseInstalledPluginReleaseDocument(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, count),
        ),
      ),
    );
  } finally {
    closeSync(descriptor);
  }
}
