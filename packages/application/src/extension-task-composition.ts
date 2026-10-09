import { parsePluginCompositionLock } from "@crewon/contracts/plugins";
import {
  parsePluginProfileScope,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ExtensionTaskApplicationDependencies } from "./extension-task-application-service.ts";

/** Only new installed generation tasks read a head; receipt replay exits before this helper. */
export async function prepareExtensionTaskComposition(
  dependencies: ExtensionTaskApplicationDependencies,
  pin: PluginTaskAdmissionPin | null,
) {
  if (pin === null || dependencies.pluginCompositions === undefined)
    return null;
  if (
    dependencies.extensions.compositionBindingVersion !==
      "crewon.extension-run-binding.v1" ||
    typeof dependencies.pluginCompositions.loadCurrent !== "function"
  )
    throw new ApplicationError(
      "conflict",
      "plugin_task_composition_port_unavailable",
    );
  const scope = parsePluginProfileScope({
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
  });
  const raw = await dependencies.pluginCompositions.loadCurrent({ scope });
  if (raw === null)
    throw new ApplicationError("conflict", "plugin_task_composition_missing");
  let lock;
  try {
    lock = parsePluginCompositionLock(raw, dependencies.digester);
  } catch (cause) {
    throw new ApplicationError("conflict", "plugin_task_composition_invalid", {
      cause,
    });
  }
  for (const field of ["tenantId", "spaceId", "profileId"] as const)
    if (lock.scope[field] !== scope[field])
      throw new ApplicationError(
        "authorization",
        "plugin_task_composition_scope_mismatch",
      );
  if (lock.scope.authorityEpoch !== pin.authorityEpoch)
    throw new ApplicationError(
      "conflict",
      "plugin_task_composition_epoch_mismatch",
    );
  const root = lock.nodes.find((node) => node.pluginId === pin.pluginId);
  if (
    !root ||
    root.publisherId !== pin.publisherId ||
    root.version !== pin.version ||
    root.packageDigest !== pin.packageDigest ||
    root.selectionRevision !== pin.selectionRevision
  )
    throw new ApplicationError(
      "conflict",
      "plugin_task_composition_root_mismatch",
    );
  return Object.freeze({
    profileId: scope.profileId,
    authorityEpoch: pin.authorityEpoch,
    revision: lock.revision,
    lockDigest: lock.lockDigest,
  });
}
