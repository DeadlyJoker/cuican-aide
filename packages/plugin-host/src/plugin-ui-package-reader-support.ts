import {
  ApplicationError,
  type ActorContext,
  type PluginUiPackageContext,
} from "@crewon/application";
import {
  assertPluginProfileScope,
  assertPluginSelectionPackage,
  parseInstalledPluginPackage,
  parsePluginProfileScope,
  parsePluginSelection,
  pluginInstallationOpaqueId,
  type PluginProfileScope,
} from "@crewon/domain";
import type { PluginPackageDescriptor } from "@crewon/contracts/plugins";

export function uiPackageFailure(
  kind: "validation" | "authorization" | "conflict" | "internal",
  code: string,
  cause?: unknown,
): never {
  throw new ApplicationError(
    kind,
    code,
    cause === undefined ? undefined : { cause },
  );
}

/** Copies descriptor values, never executes caller getters or keeps mutable request objects. */
export function uiPackageRecord(input: unknown, fields: readonly string[]) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    uiPackageFailure("validation", "plugin_ui_package_input_invalid");
  const prototype = Object.getPrototypeOf(input);
  const keys = Reflect.ownKeys(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    uiPackageFailure("validation", "plugin_ui_package_input_invalid");
  return Object.freeze(
    Object.fromEntries(
      fields.map((field) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, field);
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        )
          uiPackageFailure("validation", "plugin_ui_package_input_invalid");
        return [field, descriptor.value];
      }),
    ),
  );
}

export function uiPackageContext(
  input: Readonly<Record<string, unknown>>,
  profile: PluginProfileScope,
): PluginUiPackageContext {
  const scope = parsePluginProfileScope(input.scope);
  assertPluginProfileScope(profile, scope);
  const actorValue = uiPackageRecord(input.actor, [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
  ]);
  const actor: ActorContext = Object.freeze({
    tenantId: pluginInstallationOpaqueId(actorValue.tenantId),
    spaceId: pluginInstallationOpaqueId(actorValue.spaceId),
    principalId: pluginInstallationOpaqueId(actorValue.principalId),
    actorId: pluginInstallationOpaqueId(actorValue.actorId),
  });
  if (actor.tenantId !== scope.tenantId || actor.spaceId !== scope.spaceId)
    uiPackageFailure("authorization", "plugin_ui_package_scope_mismatch");
  const selection = parsePluginSelection(input.selection);
  const pkg = parseInstalledPluginPackage(input.package);
  assertPluginProfileScope(scope, selection);
  assertPluginProfileScope(scope, pkg);
  assertPluginSelectionPackage({ selection, package: pkg });
  if (selection.state !== "enabled")
    uiPackageFailure("conflict", "plugin_ui_package_not_enabled");
  return Object.freeze({ actor, scope, selection, package: pkg });
}

export function uiPackageIdentity(
  context: PluginUiPackageContext,
  descriptor: PluginPackageDescriptor,
): void {
  if (
    descriptor.pluginId !== context.package.pluginId ||
    descriptor.version !== context.package.version ||
    descriptor.publisherId !== context.package.publisherId
  )
    uiPackageFailure("internal", "plugin_ui_installed_identity_mismatch");
}

export function uiPackageDescriptor(
  context: PluginUiPackageContext,
  descriptor: PluginPackageDescriptor,
): void {
  uiPackageIdentity(context, descriptor);
  if (descriptor.entrypoints.ui?.mode !== "trustedModule")
    uiPackageFailure("conflict", "plugin_ui_mode_unsupported");
  if (
    !descriptor.contributions.some(
      (item) => item.kind === "module" && item.slot === "main.content",
    )
  )
    uiPackageFailure("conflict", "plugin_ui_contribution_unsupported");
}

/** Publication is an explicit host decision, including any intentionally public metadata. */
export function uiPackagePublicAssets(
  input: unknown,
  descriptor: PluginPackageDescriptor,
): readonly string[] {
  if (
    !Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Array.prototype ||
    input.length > descriptor.files.length ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    uiPackageFailure("internal", "plugin_ui_publication_result_invalid");
  const inventory = new Set(descriptor.files.map((file) => file.path));
  const values: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const field = Object.getOwnPropertyDescriptor(input, String(index));
    if (
      !field ||
      !field.enumerable ||
      !Object.hasOwn(field, "value") ||
      typeof field.value !== "string" ||
      !inventory.has(field.value) ||
      values.includes(field.value)
    )
      uiPackageFailure("internal", "plugin_ui_publication_result_invalid");
    values.push(field.value);
  }
  if (
    !descriptor.entrypoints.ui ||
    !values.includes(descriptor.entrypoints.ui.path)
  )
    uiPackageFailure("authorization", "plugin_ui_publication_denied");
  return Object.freeze(values.sort());
}

export function uiPackageAssetPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    new TextEncoder().encode(input).byteLength > 256 ||
    /[\\%:?#\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) ||
    input.split("/").some((part) => !part || part === "." || part === "..")
  )
    uiPackageFailure("validation", "plugin_ui_asset_path_invalid");
  return input;
}

export function uiPackageMime(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const known: Readonly<Record<string, string>> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
  };
  return known[extension] ?? "application/octet-stream";
}
