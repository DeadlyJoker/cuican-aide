import type { PluginInstallationStore } from "@crewon/application";
import {
  parsePluginProfileScope,
  parsePluginSelection,
  type PluginTaskAdmissionPin,
} from "@crewon/domain";
import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";
function fail(code: string): never {
  throw new InstalledPluginRunContextError(code);
}

export type InstalledPluginSelectionPin = Pick<
  PluginTaskAdmissionPin,
  | "tenantId"
  | "spaceId"
  | "profileId"
  | "pluginId"
  | "publisherId"
  | "packageDigest"
  | "selectionRevision"
>;
/** Same current-selection gate for the original root and captured dependency packages. */
export async function readInstalledPluginRunSelection(
  installations: PluginInstallationStore,
  admission: InstalledPluginSelectionPin,
  purpose: "submit" | "observe",
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const scope = parsePluginProfileScope({
    tenantId: admission.tenantId,
    spaceId: admission.spaceId,
    profileId: admission.profileId,
  });
  const raw = await installations.loadSelection({
    scope,
    pluginId: admission.pluginId,
  });
  signal.throwIfAborted();
  if (raw === null) fail("installed_plugin_selection_missing");
  const selection = parsePluginSelection(raw);
  for (const field of [
    "tenantId",
    "spaceId",
    "profileId",
    "pluginId",
    "publisherId",
  ] as const)
    if (selection[field] !== admission[field])
      fail("installed_plugin_selection_scope_mismatch");
  if (selection.revision < admission.selectionRevision)
    fail("installed_plugin_selection_revision_invalid");
  if (
    selection.revision === admission.selectionRevision &&
    (selection.state !== "enabled" ||
      selection.selectedPackageDigest !== admission.packageDigest)
  )
    fail("installed_plugin_selection_admission_mismatch");
  // Selection gates new operations, while the immutable admission still selects
  // the original package for recovery after upgrade or logical uninstall.
  if (purpose === "submit" && selection.state !== "enabled")
    fail("installed_plugin_generation_disabled");
  return selection;
}
