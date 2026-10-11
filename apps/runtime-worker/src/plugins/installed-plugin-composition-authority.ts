import type {
  PluginCompositionLock,
  PluginCompositionScope,
} from "@crewon/contracts/plugins";
import {
  parsePluginProfileScope,
  pluginInstallationOpaqueId,
} from "@crewon/domain";
import { ioRecord } from "./plugin-execution-io-network.ts";
import { InstalledPluginRunContextError } from "./installed-plugin-run-context-error.ts";

/** Trusted deployment callback, issued by the actual live host owner, never by a request or plugin. */
export type InstalledPluginCompositionAuthority = () => PluginCompositionScope;

export function captureInstalledPluginCompositionAuthority(
  input: object,
): InstalledPluginCompositionAuthority | undefined {
  const property = Object.getOwnPropertyDescriptor(
    input,
    "assertCurrentAuthority",
  );
  if (property === undefined) return undefined;
  if (
    !property.enumerable ||
    !("value" in property) ||
    typeof property.value !== "function"
  )
    throw new InstalledPluginRunContextError(
      "installed_plugin_composition_configuration_invalid",
    );
  const callback = property.value.bind(input) as () => unknown;
  return () => {
    const value = ioRecord(callback(), [
      "tenantId",
      "spaceId",
      "profileId",
      "authorityEpoch",
    ]);
    return Object.freeze({
      ...parsePluginProfileScope({
        tenantId: value.tenantId,
        spaceId: value.spaceId,
        profileId: value.profileId,
      }),
      authorityEpoch: pluginInstallationOpaqueId(value.authorityEpoch),
    });
  };
}

/** Observation retains only the old epoch, never a revoked owner or a different profile scope. */
export function assertInstalledPluginCompositionAuthority(
  authority: InstalledPluginCompositionAuthority | undefined,
  lock: PluginCompositionLock | null,
  purpose: "submit" | "observe",
): void {
  if (authority === undefined || lock === null) return;
  const current = authority();
  if (
    (
      [
        "tenantId",
        "spaceId",
        "profileId",
        ...(purpose === "submit" ? ["authorityEpoch" as const] : []),
      ] as const
    ).some((field) => lock.scope[field] !== current[field])
  )
    throw new InstalledPluginRunContextError(
      "installed_plugin_composition_authority_changed",
    );
}
