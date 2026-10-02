import {
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "./plugin-package-contract.ts";
import { pluginUiFailure, pluginUiFields } from "./plugin-ui-json.ts";

export type PluginUiLease = Readonly<{
  schemaVersion: "crewon.plugin-ui-lease.v1";
  /** An opaque host reference, never an authorization grant by itself. */
  mountRef: string;
  expiresAt: string;
  selectionRevision: number;
  packageDigest: string;
  descriptor: PluginPackageDescriptor;
  contributionId: string;
  /** Explicitly approved browser assets, not the mixed Node/UI inventory by default. */
  publicAssets: readonly string[];
}>;

/** Shape only. Current actor, profile, selection, epoch, trust and actual bytes require host checks. */
export function parsePluginUiLease(input: unknown): PluginUiLease {
  const fields = pluginUiFields(input, [
    "schemaVersion",
    "mountRef",
    "expiresAt",
    "selectionRevision",
    "packageDigest",
    "descriptor",
    "contributionId",
    "publicAssets",
  ]);
  if (fields.schemaVersion !== "crewon.plugin-ui-lease.v1")
    pluginUiFailure("plugin_ui_lease_schema_unsupported");
  if (
    typeof fields.mountRef !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(fields.mountRef)
  )
    pluginUiFailure("plugin_ui_mount_ref_invalid");
  if (
    typeof fields.packageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(fields.packageDigest)
  )
    pluginUiFailure("plugin_ui_package_digest_invalid");
  if (
    typeof fields.selectionRevision !== "number" ||
    !Number.isSafeInteger(fields.selectionRevision) ||
    fields.selectionRevision < 1
  )
    pluginUiFailure("plugin_ui_selection_revision_invalid");
  const expiresAt = fields.expiresAt;
  if (
    typeof expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt) ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    new Date(expiresAt).toISOString() !== expiresAt
  )
    pluginUiFailure("plugin_ui_expiry_invalid");
  const descriptor = parsePluginPackageDescriptor(fields.descriptor);
  const ui = descriptor.entrypoints.ui;
  if (!ui || ui.mode !== "trustedModule")
    pluginUiFailure("plugin_ui_mode_unsupported");
  const contribution = descriptor.contributions.find(
    (item) => item.id === fields.contributionId,
  );
  if (!contribution || contribution.kind !== "module")
    pluginUiFailure("plugin_ui_contribution_unsupported");
  const paths = fields.publicAssets;
  if (
    !Array.isArray(paths) ||
    Object.getPrototypeOf(paths) !== Array.prototype ||
    paths.length < 1 ||
    paths.length > 512 ||
    Reflect.ownKeys(paths).length !== paths.length + 1
  )
    pluginUiFailure("plugin_ui_public_assets_invalid");
  const inventory = new Set(descriptor.files.map((file) => file.path));
  const copied: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    const property = Object.getOwnPropertyDescriptor(paths, String(i));
    if (!property?.enumerable || !("value" in property))
      pluginUiFailure("plugin_ui_data_property_required");
    if (typeof property.value !== "string" || !inventory.has(property.value))
      pluginUiFailure("plugin_ui_public_asset_undeclared");
    if (copied.includes(property.value))
      pluginUiFailure("plugin_ui_public_asset_duplicate");
    copied.push(property.value);
  }
  if (!copied.includes(ui.path))
    pluginUiFailure("plugin_ui_public_entrypoint_missing");
  return Object.freeze({
    schemaVersion: "crewon.plugin-ui-lease.v1",
    mountRef: fields.mountRef,
    expiresAt,
    selectionRevision: fields.selectionRevision,
    packageDigest: fields.packageDigest,
    descriptor,
    contributionId: contribution.id,
    publicAssets: Object.freeze(copied),
  });
}
