import { createHash } from "node:crypto";
import { parseAgentVersionAsset } from "@crewon/agent-version";
import {
  ApplicationError,
  pluginTaskModelId,
  type ActorContext,
  type PluginTaskModelSelectionPort,
} from "@crewon/application";
import {
  extensionCanonicalJson,
  parseExtensionConfiguration,
  parsePluginTaskAdmissionPin,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import {
  pluginSecurityActor,
  pluginSecurityRecord,
} from "./plugin-security-validation.ts";
import type { DesktopNativePluginTaskBinding } from "./desktop-native-plugin-task-authority.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
/** Selects only Main-published installed siblings backed by actual immutable Store assets/deployments. */
type NativeModelContext = Readonly<{
  binding: DesktopNativePluginTaskBinding;
  assertRequestCurrent(actor: ActorContext): Promise<void>;
  assertCommitCurrent(actor: ActorContext): void;
}>;
export async function prepareDesktopNativePluginModel(
  context: NativeModelContext &
    Readonly<{
      input: Parameters<PluginTaskModelSelectionPort["prepareModel"]>[0];
    }>,
) {
  return prepare(context, "modelId");
}
/** Private persisted-plan lookup; HTTP and plugin task bodies never expose this entry point. */
export async function prepareDesktopNativePluginTarget(
  context: NativeModelContext &
    Readonly<{
      input: Parameters<
        NonNullable<PluginTaskModelSelectionPort["prepareTarget"]>
      >[0];
    }>,
) {
  return prepare(context, "target");
}
async function prepare(
  context: NativeModelContext &
    Readonly<{
      input:
        | Parameters<PluginTaskModelSelectionPort["prepareModel"]>[0]
        | Parameters<
            NonNullable<PluginTaskModelSelectionPort["prepareTarget"]>
          >[0];
    }>,
  field: "modelId" | "target",
) {
  const value = pluginSecurityRecord(context.input, [
      "actor",
      "pin",
      "configuration",
      field,
    ]),
    actor = pluginSecurityActor(value.actor),
    pin = parsePluginTaskAdmissionPin(value.pin),
    configuration = parseExtensionConfiguration(value.configuration, digester),
    modelId =
      field === "modelId" ? pluginTaskModelId(value.modelId) : undefined,
    requestedTarget =
      field === "target"
        ? parseExtensionExecutionTarget(value.target)
        : undefined,
    { binding } = context,
    scope = binding.configuration.scope;
  await context.assertRequestCurrent(actor);
  const entries = binding.nativeControl.publication.entries.filter(
    (entry) =>
      entry.identity.pluginId === pin.pluginId &&
      entry.identity.publisherId === pin.publisherId &&
      entry.identity.version === pin.version &&
      entry.identity.packageDigest === pin.packageDigest &&
      extensionCanonicalJson(entry.configuration) ===
        extensionCanonicalJson(configuration),
  );
  if (
    pin.action !== "project.execute" ||
    pin.contributionId !== "workbench" ||
    pin.tenantId !== scope.tenantId ||
    pin.spaceId !== scope.spaceId ||
    pin.profileId !== scope.profileId ||
    pin.principalId !== actor.principalId ||
    pin.actorId !== actor.actorId ||
    pin.authorityEpoch !== binding.configuration.authorityEpoch ||
    entries.length === 0 ||
    !binding.nativeControl.authority.packages.some(
      (pkg) =>
        pkg.pluginId === pin.pluginId &&
        pkg.publisherId === pin.publisherId &&
        pkg.version === pin.version &&
        pkg.packageDigest === pin.packageDigest,
    ) ||
    !binding.configuration.publications.some(
      (pkg) =>
        pkg.pluginId === pin.pluginId &&
        pkg.packageDigest === pin.packageDigest,
    )
  )
    denied();
  const assertActive = () => {
    context.assertCommitCurrent(actor);
    const selection = binding.store
      .pluginInstallationStore()
      .currentSelection({ scope, pluginId: pin.pluginId });
    if (
      selection === null ||
      selection.state !== "enabled" ||
      selection.revision !== pin.selectionRevision ||
      selection.selectedPackageDigest !== pin.packageDigest ||
      selection.publisherId !== pin.publisherId
    )
      denied();
  };
  assertActive();
  const candidates = await Promise.all(
    entries.map(async (entry) => {
      const locator = {
        tenantId: scope.tenantId,
        agentVersionId: entry.target.agentVersionId,
      };
      const [asset, deployment] = await Promise.all([
        binding.store.loadAgentVersion(locator),
        binding.store.loadAgentVersionDeployment(locator),
      ]);
      if (asset === null || deployment === null) denied();
      const version = parseAgentVersionAsset(asset, digester),
        target = entry.target;
      if (
        asset.tenantId !== scope.tenantId ||
        deployment.tenantId !== scope.tenantId ||
        version.contentDigest !== target.agentVersionContentDigest ||
        version.runtimeGeneration !== target.runtimeGeneration ||
        version.policySnapshotId !== target.policySnapshotId ||
        deployment.agentVersionId !== target.agentVersionId ||
        deployment.contentDigest !== target.agentVersionContentDigest ||
        deployment.materializationDigest !== target.materializationDigest ||
        deployment.authorityId !== target.authorityId ||
        deployment.workspaceBindingId !== target.workspaceBindingId
      )
        denied();
      const matches =
        field === "modelId"
          ? version.model.modelId === modelId
          : extensionCanonicalJson(target) ===
            extensionCanonicalJson(requestedTarget);
      return matches
        ? { entry, modelId: pluginTaskModelId(version.model.modelId) }
        : null;
    }),
  );
  await context.assertRequestCurrent(actor);
  assertActive();
  const matches = candidates.filter((entry) => entry !== null);
  if (matches.length !== 1)
    throw new ApplicationError(
      "conflict",
      "plugin_task_model_selection_unavailable",
    );
  return Object.freeze({
    modelId: matches[0]!.modelId,
    target: matches[0]!.entry.target,
    assertActive,
    assertCurrent: async () => {
      assertActive();
      await context.assertRequestCurrent(actor);
      assertActive();
    },
  });
}
function denied(): never {
  throw new ApplicationError(
    "authorization",
    "desktop_native_plugin_model_selection_invalid",
  );
}
