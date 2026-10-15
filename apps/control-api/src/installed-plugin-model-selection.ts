import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  ApplicationError,
  pluginTaskModelId,
  type PluginTaskModelSelectionPort,
  type ContentDigester,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  extensionDigest,
  parseExtensionConfiguration,
  parseExtensionExecutionTarget,
  parsePluginProfileScope,
  parsePluginTaskAdmissionPin,
  pluginInstallationOpaqueId,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import type { PostgresDomainStore } from "@crewon/store";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";

export type InstalledPluginModelBinding = Readonly<{
  scope: ReturnType<typeof parsePluginProfileScope>;
  pluginId: string;
  publisherId: string;
  version: string;
  packageDigest: string;
  configurationDigest: string;
  modelId: string;
  target: ExtensionExecutionTarget;
}>;
export function parseInstalledPluginModelBindings(
  input: unknown,
): readonly InstalledPluginModelBinding[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) denied();
  const seen = new Set<string>();
  return Object.freeze(
    input.map((raw) => {
      const v = pluginSecurityRecord(raw, [
        "scope",
        "pluginId",
        "publisherId",
        "version",
        "packageDigest",
        "configurationDigest",
        "modelId",
        "target",
      ]);
      const result = Object.freeze({
        scope: parsePluginProfileScope(v.scope),
        pluginId: pluginInstallationOpaqueId(v.pluginId),
        publisherId: pluginInstallationOpaqueId(v.publisherId),
        version: pluginInstallationOpaqueId(v.version),
        packageDigest: extensionDigest(v.packageDigest),
        configurationDigest: extensionDigest(v.configurationDigest),
        modelId: pluginTaskModelId(v.modelId),
        target: parseExtensionExecutionTarget(v.target),
      });
      if (result.target.executionAuthority !== "crewonKernel") denied();
      const key = extensionCanonicalJson([
        result.scope,
        result.pluginId,
        result.packageDigest,
        result.configurationDigest,
        result.modelId,
      ]);
      if (seen.has(key)) denied();
      seen.add(key);
      return result;
    }),
  );
}

/** Select only explicitly deployed installed siblings, verified against original immutable SQL assets. */
export function createInstalledPluginModelSelection(
  owner: Readonly<{
    bindings: readonly InstalledPluginModelBinding[];
    store: Pick<
      PostgresDomainStore,
      "loadAgentVersion" | "loadAgentVersionDeployment"
    >;
    digester: ContentDigester;
    assertCurrent(): Promise<void>;
    currentSignal(): AbortSignal;
  }>,
): PluginTaskModelSelectionPort {
  const bindings = parseInstalledPluginModelBindings(owner.bindings);
  const prepare = async (
    input:
      | Parameters<PluginTaskModelSelectionPort["prepareModel"]>[0]
      | Parameters<
          NonNullable<PluginTaskModelSelectionPort["prepareTarget"]>
        >[0],
    field: "modelId" | "target",
  ) => {
    const v = pluginSecurityRecord(input, [
      "actor",
      "pin",
      "configuration",
      field,
    ]);
    const actor = pluginSecurityActor(v.actor),
      pin = parsePluginTaskAdmissionPin(v.pin),
      configuration = parseExtensionConfiguration(
        v.configuration,
        owner.digester,
      );
    if (
      ["tenantId", "spaceId", "principalId", "actorId"].some(
        (k) => actor[k as keyof typeof actor] !== pin[k as keyof typeof pin],
      )
    )
      denied();
    if (
      pin.action !== "project.execute" ||
      configuration.tenantId !== pin.tenantId ||
      configuration.spaceId !== pin.spaceId ||
      configuration.pluginId !== pin.pluginId ||
      configuration.pluginVersion !== pin.version
    )
      denied();
    const candidates = bindings.filter(
      (b) =>
        b.scope.tenantId === pin.tenantId &&
        b.scope.spaceId === pin.spaceId &&
        b.scope.profileId === pin.profileId &&
        b.pluginId === pin.pluginId &&
        b.publisherId === pin.publisherId &&
        b.version === pin.version &&
        b.packageDigest === pin.packageDigest &&
        b.configurationDigest === configuration.contentDigest &&
        (field === "modelId"
          ? b.modelId === pluginTaskModelId(v.modelId)
          : extensionCanonicalJson(b.target) ===
            extensionCanonicalJson(parseExtensionExecutionTarget(v.target))),
    );
    if (candidates.length !== 1) denied();
    const binding = candidates[0]!;
    const signal = owner.currentSignal();
    signal.throwIfAborted();
    await owner.assertCurrent();
    const locator = {
      tenantId: pin.tenantId,
      agentVersionId: binding.target.agentVersionId,
    };
    const [asset, deployment] = await Promise.all([
      owner.store.loadAgentVersion(locator),
      owner.store.loadAgentVersionDeployment(locator),
    ]);
    if (!asset || !deployment) denied();
    const version = parseAgentVersionAsset(asset, owner.digester),
      target = binding.target;
    if (
      asset.tenantId !== pin.tenantId ||
      version.agentVersionId !== target.agentVersionId ||
      deployment.tenantId !== pin.tenantId ||
      deployment.agentVersionId !== target.agentVersionId ||
      version.model.modelId !== binding.modelId ||
      version.contentDigest !== target.agentVersionContentDigest ||
      version.runtimeGeneration !== target.runtimeGeneration ||
      version.policySnapshotId !== target.policySnapshotId ||
      deployment.contentDigest !== target.agentVersionContentDigest ||
      deployment.materializationDigest !== target.materializationDigest ||
      deployment.authorityId !== target.authorityId ||
      deployment.workspaceBindingId !== target.workspaceBindingId
    )
      denied();
    await owner.assertCurrent();
    signal.throwIfAborted();
    return Object.freeze({
      modelId: binding.modelId,
      target,
      assertActive: () => signal.throwIfAborted(),
      assertCurrent: async () => {
        signal.throwIfAborted();
        await owner.assertCurrent();
        signal.throwIfAborted();
      },
    });
  };
  const selection: PluginTaskModelSelectionPort = {
    prepareModel: (input) => prepare(input, "modelId"),
    prepareTarget: (input) => prepare(input, "target"),
  };
  return Object.freeze(selection);
}
function denied(): never {
  throw new ApplicationError(
    "conflict",
    "plugin_task_model_selection_unavailable",
  );
}
