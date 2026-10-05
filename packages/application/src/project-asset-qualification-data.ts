import {
  extensionCanonicalJson,
  parseInstalledPluginPackage,
  parsePluginSelection,
  validateCreativeProjectActor,
} from "@crewon/domain";
import { parseProjectToolInstallationPin } from "./creative-project-run-commit-authority.ts";

/** Host data only: reject accessors before capturing immutable evidence or callbacks. */
export function projectAssetAuthorityFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    projectAssetAuthorityDenied();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !d?.enumerable ||
      !Object.hasOwn(d, "value")
    )
      projectAssetAuthorityDenied();
    result[key] = d.value;
  }
  if (Object.keys(result).length !== keys.length) projectAssetAuthorityDenied();
  return result;
}
export function projectAssetAuthorityCopy<T>(input: T): T {
  const json = extensionCanonicalJson(input);
  if (Buffer.byteLength(json, "utf8") > 262144) projectAssetAuthorityDenied();
  return freeze(JSON.parse(json)) as T;
}
function freeze(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function projectAssetInstallationEvidence(v: Record<string, unknown>) {
  const actor = validateCreativeProjectActor(
    projectAssetAuthorityCopy(v.actor),
  );
  const installation = parseProjectToolInstallationPin(v.installation);
  const selection = parsePluginSelection(
    projectAssetAuthorityCopy(v.selection),
  );
  const pkg = parseInstalledPluginPackage(projectAssetAuthorityCopy(v.package));
  if (
    actor.tenantId !== installation.tenantId ||
    actor.spaceId !== installation.spaceId ||
    selection.state !== "enabled" ||
    selection.revision !== installation.selectionRevision ||
    selection.selectedPackageDigest !== installation.packageDigest ||
    pkg.packageDigest !== installation.packageDigest ||
    pkg.version !== installation.version ||
    (
      ["tenantId", "spaceId", "profileId", "pluginId", "publisherId"] as const
    ).some(
      (k) => selection[k] !== installation[k] || pkg[k] !== installation[k],
    )
  )
    projectAssetAuthorityDenied();
  return { actor, installation, selection, package: pkg };
}
export function projectAssetAuthorityDenied(): never {
  throw new Error("project_asset_commit_authority_invalid");
}
