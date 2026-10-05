import { pluginUiActionInputMaximumBytes } from "@crewon/contracts/project-texts-ui";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginSelection,
  pluginInstallationDigest,
  pluginInstallationNamespaceId,
  pluginInstallationOpaqueId,
  pluginInstallationRevision,
  pluginInstallationTimestamp,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { ApplicationError } from "./application-error.ts";
import type { ActorContext } from "./authorization-port.ts";
import {
  installationActor,
  installationProfile,
  installationRecord,
} from "./plugin-installation-application-support.ts";
import type {
  PluginUiPackageContext,
  PluginUiVerifiedPackage,
} from "./plugin-ui-ports.ts";

export const PLUGIN_UI_MAX_MOUNTS = 128;
export const PLUGIN_UI_MAX_TTL_MS = 5 * 60 * 1000;
export const PLUGIN_UI_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const uiRecord = installationRecord;
export const uiActor = installationActor;
export const uiProfile = installationProfile;

export function uiInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("validation", "plugin_ui_input_invalid", {
      cause: error,
    });
  }
}
export function uiOutput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new ApplicationError("internal", "plugin_ui_output_invalid", {
      cause: error,
    });
  }
}
export async function uiOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("internal", "plugin_ui_unavailable", {
      cause: error,
    });
  }
}
export function uiRef(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(input))
    throw new Error("plugin_ui_reference_invalid");
  return input;
}
export function uiEpoch(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input))
    throw new Error("plugin_ui_epoch_invalid");
  return input;
}
export function uiLimit(input: unknown, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 1 ||
    input > maximum
  )
    throw new Error("plugin_ui_limit_invalid");
  return input;
}
export function uiNow(input: unknown): number {
  return Date.parse(pluginInstallationTimestamp(input));
}
export function uiSameScope(
  a: PluginProfileScope,
  b: PluginProfileScope,
): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.spaceId === b.spaceId &&
    a.profileId === b.profileId
  );
}
export function uiSameActor(a: ActorContext, b: ActorContext): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.spaceId === b.spaceId &&
    a.principalId === b.principalId &&
    a.actorId === b.actorId
  );
}
export function uiSelection(
  input: unknown,
  scope: PluginProfileScope,
  pluginId: string,
): PluginSelection {
  return uiOutput(() => {
    const selection = parsePluginSelection(input);
    assertPluginProfileScope(scope, selection);
    if (selection.pluginId !== pluginId)
      throw new Error("plugin_ui_selection_identity_invalid");
    return selection;
  });
}
export function uiPackage(
  input: unknown,
  scope: PluginProfileScope,
  selection: PluginSelection,
): InstalledPluginPackage {
  return uiOutput(() => {
    const pkg = parseInstalledPluginPackage(input);
    assertPluginProfileScope(scope, pkg);
    assertPluginSelectionPackage({ selection, package: pkg });
    return pkg;
  });
}
export function uiProjection(
  input: unknown,
  context: PluginUiPackageContext,
  contributionId: string,
): PluginUiVerifiedPackage {
  return uiOutput(() => {
    const value = uiRecord(input, ["descriptor", "publicAssets"]);
    const descriptor = parsePluginPackageDescriptor(value.descriptor);
    if (
      descriptor.pluginId !== context.package.pluginId ||
      descriptor.version !== context.package.version ||
      descriptor.publisherId !== context.package.publisherId
    )
      throw new Error("plugin_ui_package_identity_invalid");
    // The shared lease parser owns publication/contribution validation; this temporary envelope is
    // metadata validation only, never a minted reference or authorization grant.
    const checked = parsePluginUiLease({
      schemaVersion: "crewon.plugin-ui-lease.v1",
      mountRef: "0".repeat(32),
      expiresAt: "2000-01-01T00:00:00.000Z",
      selectionRevision: context.selection.revision,
      packageDigest: context.package.packageDigest,
      descriptor,
      contributionId,
      publicAssets: value.publicAssets,
    });
    return Object.freeze({
      descriptor: checked.descriptor,
      publicAssets: checked.publicAssets,
    });
  });
}
export function uiPublicLease(input: unknown): PluginUiLease {
  return uiOutput(() => parsePluginUiLease(input));
}
export function uiOpenCommand(input: unknown) {
  return uiInput(() => {
    const value = uiRecord(input, [
      "pluginId",
      "contributionId",
      "expectedSelectionRevision",
      "expectedPackageDigest",
    ]);
    return Object.freeze({
      pluginId: pluginInstallationNamespaceId(value.pluginId),
      contributionId: pluginInstallationNamespaceId(value.contributionId),
      expectedSelectionRevision: pluginInstallationRevision(
        value.expectedSelectionRevision,
      ),
      expectedPackageDigest: pluginInstallationDigest(
        value.expectedPackageDigest,
      ),
    });
  });
}
export function uiMountQuery(input: unknown) {
  return uiInput(() =>
    Object.freeze({ mountRef: uiRef(uiRecord(input, ["mountRef"]).mountRef) }),
  );
}
export function uiAssetQuery(input: unknown) {
  return uiInput(() => {
    const value = uiRecord(input, ["mountRef", "path"]);
    if (
      typeof value.path !== "string" ||
      new TextEncoder().encode(value.path).byteLength > 256
    )
      throw new Error("plugin_ui_asset_path_invalid");
    return Object.freeze({ mountRef: uiRef(value.mountRef), path: value.path });
  });
}
export function uiInvokeCommand(input: unknown) {
  return uiInput(() => {
    const value = uiRecord(input, ["mountRef", "action", "input"]);
    return Object.freeze({
      mountRef: uiRef(value.mountRef),
      action: pluginInstallationOpaqueId(value.action),
      input: parsePluginUiJsonValue(value.input, {
        maxBytes: pluginUiActionInputMaximumBytes(value.action),
      }),
    });
  });
}
export function uiCatalogQuery(input: unknown) {
  return uiInput(() => {
    const value = uiRecord(input, ["afterPluginId", "limit"]);
    return Object.freeze({
      afterPluginId:
        value.afterPluginId === null
          ? null
          : pluginInstallationNamespaceId(value.afterPluginId),
      limit: uiLimit(value.limit, 50),
    });
  });
}
export function uiAssetResult(
  input: unknown,
  lease: PluginUiLease,
  path: string,
  maximum: number,
) {
  return uiOutput(() => {
    const value = uiRecord(input, ["bytes", "contentType"]);
    const declared = lease.descriptor.files.find((file) => file.path === path);
    if (
      !declared ||
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.byteLength !== declared.byteLength ||
      value.bytes.byteLength > maximum ||
      typeof value.contentType !== "string" ||
      value.contentType.length > 128 ||
      !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/u.test(
        value.contentType,
      )
    )
      throw new Error("plugin_ui_asset_result_invalid");
    return Object.freeze({
      bytes: Uint8Array.prototype.slice.call(value.bytes) as Uint8Array,
      contentType: value.contentType,
    });
  });
}
