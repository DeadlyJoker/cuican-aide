import { createHash } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseCompiledAgentVersion } from "@crewon/agent-version";
import { parseRuntimeBindingConfig } from "@crewon/agent-version/runtime-bindings";
import {
  parsePluginPackageDescriptor,
  PLUGIN_PACKAGE_DESCRIPTOR_PATH,
  PLUGIN_PACKAGE_LIMITS,
} from "@crewon/contracts/plugins";
import {
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
} from "@crewon/domain";
import type { InstalledPluginPeerCatalogEntry } from "@crewon/contracts/plugins";
import type { DesktopPluginBootstrapManifest } from "./desktopPluginBootstrap.ts";
import type { DesktopInstalledPluginExpectedCatalogEntry } from "./desktopInstalledPluginRuntime.ts";
import {
  captureDesktopInstalledPluginRuntimeArtifact,
  captureDesktopInstalledPluginRuntimeDirectory,
  captureDesktopInstalledPluginRuntimeDocument,
  desktopInstalledPluginExactKeys,
  desktopInstalledPluginInvalid as invalid,
  desktopInstalledPluginRecord as record,
  type DesktopInstalledPluginProviderBinding,
} from "./desktopInstalledPluginRuntimeConfiguration.ts";
type Snapshot = Readonly<{ assertCurrent(): void }>;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export function captureDesktopInstalledPluginRelease(
  input: unknown,
  bootstrap: DesktopPluginBootstrapManifest,
  environment: NodeJS.ProcessEnv,
  configuration: Readonly<{
    providerBinding: DesktopInstalledPluginProviderBinding;
    /** Only Native Main supplies its captured Key-discovered model set. Remote release validation remains single-model. */
    modelCatalog?: readonly string[];
  }>,
  authorityTokens: Readonly<Record<string, string>>,
  snapshots: Snapshot[],
): readonly DesktopInstalledPluginExpectedCatalogEntry[] {
  const value = record(input);
  desktopInstalledPluginExactKeys(value, [
    "schemaVersion",
    "tenantId",
    "defaultAgentVersionId",
    "entries",
  ]);
  if (
    value.schemaVersion !== "crewon.installed-plugin-release.v1" ||
    value.tenantId !== bootstrap.scope.tenantId ||
    value.defaultAgentVersionId !== environment.CREWON_AGENT_VERSION_ID ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 32
  )
    invalid("release");
  const versions = new Set<string>();
  const capturedPackages = new Set<string>();
  const packageModels = new Set<string>();
  const entries = value.entries.map(
    (raw): DesktopInstalledPluginExpectedCatalogEntry => {
      const entry = record(raw);
      desktopInstalledPluginExactKeys(entry, [
        "scope",
        "packageIdentity",
        "configuration",
        "approvalRequirement",
        "modelSource",
        "version",
        "target",
      ]);
      if (
        !isDeepStrictEqual(
          parsePluginProfileScope(entry.scope),
          bootstrap.scope,
        ) ||
        (entry.approvalRequirement !== "none" &&
          entry.approvalRequirement !== "perAction")
      )
        invalid("release_scope");
      const identity = record(entry.packageIdentity);
      desktopInstalledPluginExactKeys(identity, [
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
      ]);
      const source = bootstrap.sources.find(
        (candidate) =>
          candidate.pluginId === identity.pluginId &&
          candidate.publisherId === identity.publisherId &&
          candidate.version === identity.version &&
          candidate.packageDigest === identity.packageDigest,
      );
      if (!source) invalid("release_package_unapproved");
      const config = parseExtensionConfiguration(entry.configuration, digester);
      if (
        config.tenantId !== bootstrap.scope.tenantId ||
        config.spaceId !== bootstrap.scope.spaceId ||
        config.pluginId !== source.pluginId ||
        config.pluginVersion !== source.version
      )
        invalid("release_configuration");
      const modelSource = record(entry.modelSource);
      desktopInstalledPluginExactKeys(modelSource, [
        "executionAuthority",
        "runtimeBinding",
        "version",
        "deployment",
      ]);
      const binding = parseRuntimeBindingConfig({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [modelSource.runtimeBinding],
      }).bindings[0]!;
      const base = parseCompiledAgentVersion(
        JSON.stringify(modelSource.version),
        digester,
      );
      const provider = configuration.providerBinding;
      if (
        modelSource.executionAuthority !== "crewonKernel" ||
        binding.provider.kind !== "directResponses" ||
        binding.toolRuntimeMode !== "independent" ||
        binding.extensionConfigPath !== undefined ||
        binding.mcpStdioConfigPath !== null ||
        binding.deviceToolConfigPath !== null ||
        binding.remoteMcpConfigPath !== null ||
        binding.workspaceBindingId !== null ||
        binding.tenantId !== bootstrap.scope.tenantId ||
        binding.agentVersionId !== base.agentVersionId ||
        binding.contentDigest !== base.contentDigest ||
        binding.agentVersionId === value.defaultAgentVersionId ||
        binding.provider.endpoint !== provider.responsesEndpoint ||
        !(configuration.modelCatalog ?? [provider.modelId]).includes(
          base.model.modelId,
        ) ||
        (binding.provider.apiKeyEnvironment !== null) !==
          provider.credentialRequired
      )
        invalid("model_source");
      const key = binding.provider.apiKeyEnvironment;
      if (
        key !== null &&
        (Object.hasOwn(authorityTokens, key) || key !== "CREWON_MODEL_API_KEY")
      )
        invalid("model_credential_reference");
      const deployment = record(modelSource.deployment);
      if (
        deployment.tenantId !== bootstrap.scope.tenantId ||
        deployment.agentVersionId !== base.agentVersionId ||
        deployment.contentDigest !== base.contentDigest ||
        deployment.authorityId !== binding.authorityId ||
        deployment.workspaceBindingId !== binding.workspaceBindingId
      )
        invalid("model_deployment");
      const version = parseCompiledAgentVersion(
        JSON.stringify(entry.version),
        digester,
      );
      const target = parseExtensionExecutionTarget(entry.target);
      if (
        versions.has(version.agentVersionId) ||
        version.agentVersionId === value.defaultAgentVersionId ||
        version.agentVersionId === base.agentVersionId ||
        version.model.modelId !== base.model.modelId ||
        (configuration.modelCatalog !== undefined &&
          packageModels.has(
            JSON.stringify([identity.pluginId, version.model.modelId]),
          )) ||
        target.executionAuthority !== "crewonKernel" ||
        target.agentVersionId !== version.agentVersionId ||
        target.agentVersionContentDigest !== version.contentDigest ||
        target.runtimeGeneration !== version.runtimeGeneration ||
        target.policySnapshotId !== version.policySnapshotId
      )
        invalid("release_target");
      versions.add(version.agentVersionId);
      packageModels.add(
        JSON.stringify([identity.pluginId, version.model.modelId]),
      );
      if (!capturedPackages.has(source.packageDigest)) {
        capturePackage(
          join(
            bootstrap.installRoot,
            "packages",
            source.packageDigest.slice(7),
          ),
          source,
          snapshots,
        );
        capturedPackages.add(source.packageDigest);
      }
      return Object.freeze({
        identity: Object.freeze({
          pluginId: source.pluginId,
          publisherId: source.publisherId,
          version: source.version,
          packageDigest: source.packageDigest,
          manifestDigest: config.manifestDigest,
          implementationDigest: config.implementationDigest,
        }),
        configuration:
          config as unknown as InstalledPluginPeerCatalogEntry["configuration"],
        configuredTarget:
          target as unknown as InstalledPluginPeerCatalogEntry["configuredTarget"],
      });
    },
  );
  return Object.freeze(entries);
}
function capturePackage(
  directory: string,
  identity: DesktopPluginBootstrapManifest["sources"][number],
  snapshots: Snapshot[],
): void {
  snapshots.push(captureDesktopInstalledPluginRuntimeDirectory(directory));
  const file = captureDesktopInstalledPluginRuntimeDocument(
    join(directory, PLUGIN_PACKAGE_DESCRIPTOR_PATH),
    PLUGIN_PACKAGE_LIMITS.descriptorBytes,
    "package",
  );
  const descriptor = parsePluginPackageDescriptor(file.value);
  if (
    descriptor.pluginId !== identity.pluginId ||
    descriptor.publisherId !== identity.publisherId ||
    descriptor.version !== identity.version
  )
    invalid("package_identity");
  snapshots.push(file);
  let total = 0;
  for (const artifact of descriptor.files) {
    total += artifact.byteLength;
    if (artifact.byteLength > 32 * 1024 * 1024 || total > 128 * 1024 * 1024)
      invalid("package_limit");
    snapshots.push(
      captureDesktopInstalledPluginRuntimeArtifact(
        join(directory, artifact.path),
        artifact.byteLength,
      ),
    );
  }
}
