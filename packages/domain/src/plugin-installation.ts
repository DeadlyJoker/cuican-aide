import {
  pluginInstallationDigest,
  pluginInstallationFailure,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRecord,
  pluginInstallationRevision,
  pluginInstallationTimestamp,
  pluginInstallationVersion,
} from "./plugin-installation-validation.ts";

export type PluginProfileScope = Readonly<{
  tenantId: string;
  spaceId: string;
  profileId: string;
}>;

export type InstalledPluginPackage = PluginProfileScope &
  Readonly<{
    schemaVersion: "crewon.installed-plugin-package.v1";
    pluginId: string;
    version: string;
    publisherId: string;
    packageDigest: string;
    installedAt: string;
    installedByPrincipalId: string;
    installedByActorId: string;
  }>;

export type PluginSelection = PluginProfileScope &
  Readonly<{
    schemaVersion: "crewon.plugin-selection.v1";
    pluginId: string;
    publisherId: string;
    revision: number;
    state: "enabled" | "disabled" | "uninstalled";
    selectedPackageDigest: string | null;
    updatedAt: string;
    updatedByPrincipalId: string;
    updatedByActorId: string;
  }>;

const scopeFields = ["tenantId", "spaceId", "profileId"] as const;
const installedSchema = "crewon.installed-plugin-package.v1";
const selectionSchema = "crewon.plugin-selection.v1";

export function parsePluginProfileScope(input: unknown): PluginProfileScope {
  return scope(pluginInstallationRecord(input, scopeFields));
}

/** Package audit is immutable after persistence; parsing does not prove installation or trust. */
export function parseInstalledPluginPackage(
  input: unknown,
): InstalledPluginPackage {
  const value = pluginInstallationRecord(input, [
    "schemaVersion",
    ...scopeFields,
    "pluginId",
    "version",
    "publisherId",
    "packageDigest",
    "installedAt",
    "installedByPrincipalId",
    "installedByActorId",
  ]);
  if (value.schemaVersion !== installedSchema)
    pluginInstallationFailure("plugin_installation_package_schema_unsupported");
  return Object.freeze({
    schemaVersion: installedSchema,
    ...scope(value),
    pluginId: pluginInstallationNamespaceId(value.pluginId),
    version: pluginInstallationVersion(value.version),
    publisherId: pluginInstallationNamespaceId(value.publisherId),
    packageDigest: pluginInstallationDigest(value.packageDigest),
    installedAt: pluginInstallationTimestamp(value.installedAt),
    installedByPrincipalId: pluginInstallationOpaqueId(
      value.installedByPrincipalId,
    ),
    installedByActorId: pluginInstallationOpaqueId(value.installedByActorId),
  });
}

/** A persisted selection records intent; it does not claim a healthy or compatible Node instance. */
export function parsePluginSelection(input: unknown): PluginSelection {
  const value = pluginInstallationRecord(input, [
    "schemaVersion",
    ...scopeFields,
    "pluginId",
    "publisherId",
    "revision",
    "state",
    "selectedPackageDigest",
    "updatedAt",
    "updatedByPrincipalId",
    "updatedByActorId",
  ]);
  if (value.schemaVersion !== selectionSchema)
    pluginInstallationFailure(
      "plugin_installation_selection_schema_unsupported",
    );
  if (
    value.state !== "enabled" &&
    value.state !== "disabled" &&
    value.state !== "uninstalled"
  )
    pluginInstallationFailure("plugin_installation_selection_state_invalid");
  if (value.selectedPackageDigest === null && value.state !== "uninstalled")
    pluginInstallationFailure("plugin_installation_selection_package_missing");
  if (value.state === "uninstalled" && value.selectedPackageDigest !== null)
    pluginInstallationFailure("plugin_installation_selection_package_mismatch");
  return Object.freeze({
    schemaVersion: selectionSchema,
    ...scope(value),
    pluginId: pluginInstallationNamespaceId(value.pluginId),
    publisherId: pluginInstallationNamespaceId(value.publisherId),
    revision: pluginInstallationRevision(value.revision),
    state: value.state,
    selectedPackageDigest:
      value.selectedPackageDigest === null
        ? null
        : pluginInstallationDigest(value.selectedPackageDigest),
    updatedAt: pluginInstallationTimestamp(value.updatedAt),
    updatedByPrincipalId: pluginInstallationOpaqueId(
      value.updatedByPrincipalId,
    ),
    updatedByActorId: pluginInstallationOpaqueId(value.updatedByActorId),
  });
}

/** Accepts a strict scope or either known flat persisted record; compares all profile boundaries. */
export function assertPluginProfileScope(
  expected: PluginProfileScope,
  record: PluginProfileScope,
): void {
  const left = parsePluginProfileScope(expected);
  const right = scopeRecord(record);
  if (scopeFields.some((field) => left[field] !== right[field]))
    pluginInstallationFailure("plugin_installation_scope_mismatch");
}

/** A repeated install can carry a new audit proposal, but must reuse the original saved record. */
export function assertInstalledPluginPackageIdentity(
  saved: InstalledPluginPackage,
  requested: InstalledPluginPackage,
): void {
  const left = parseInstalledPluginPackage(saved);
  const right = parseInstalledPluginPackage(requested);
  assertPluginProfileScope(scope(left), right);
  if (
    left.pluginId !== right.pluginId ||
    left.version !== right.version ||
    left.publisherId !== right.publisherId ||
    left.packageDigest !== right.packageDigest
  )
    pluginInstallationFailure("plugin_installation_package_identity_conflict");
}

/** The Store must prove this package was actually saved in the same transaction. */
export function assertPluginSelectionPackage(
  input: Readonly<{
    selection: PluginSelection;
    package: InstalledPluginPackage | null;
  }>,
): void {
  const value = pluginInstallationRecord(input, ["selection", "package"]);
  const selection = parsePluginSelection(value.selection);
  const installed =
    value.package === null ? null : parseInstalledPluginPackage(value.package);
  if (selection.selectedPackageDigest === null) {
    if (installed !== null)
      pluginInstallationFailure(
        "plugin_installation_selection_package_mismatch",
      );
    return;
  }
  if (installed === null)
    pluginInstallationFailure("plugin_installation_selection_package_missing");
  assertPluginProfileScope(scope(selection), installed);
  if (
    selection.pluginId !== installed.pluginId ||
    selection.publisherId !== installed.publisherId ||
    selection.selectedPackageDigest !== installed.packageDigest
  )
    pluginInstallationFailure("plugin_installation_selection_package_mismatch");
}

function scope(value: Readonly<Record<string, unknown>>): PluginProfileScope {
  return Object.freeze({
    tenantId: pluginInstallationOpaqueId(value.tenantId),
    spaceId: pluginInstallationOpaqueId(value.spaceId),
    profileId: pluginInstallationOpaqueId(value.profileId),
  });
}

function scopeRecord(input: PluginProfileScope): PluginProfileScope {
  if (input !== null && typeof input === "object") {
    const schema = Object.getOwnPropertyDescriptor(input, "schemaVersion");
    if (schema && Object.hasOwn(schema, "value")) {
      if (schema.value === installedSchema)
        return scope(parseInstalledPluginPackage(input));
      if (schema.value === selectionSchema)
        return scope(parsePluginSelection(input));
    }
  }
  return parsePluginProfileScope(input);
}
