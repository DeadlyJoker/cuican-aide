import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import type { InstalledPluginExecutionConfig } from "./installed-plugin-runtime-composition.ts";
import {
  assertLoadedInstalledPluginRelease,
  verifyInstalledPluginRelease,
  type LoadedInstalledPluginRelease,
} from "./installed-plugin-release-loader.ts";

export type { LoadedInstalledPluginRelease };

type InstalledPluginReleaseCompositionConfig = Readonly<{
  installedPluginRelease?: LoadedInstalledPluginRelease;
  installedPluginExecution?: InstalledPluginExecutionConfig;
  extensionRuntime?: unknown;
  extensionHost?: unknown;
}>;

/** A release only uses explicitly supplied installed execution authority. */
export function prepareInstalledPluginReleaseComposition(
  config: InstalledPluginReleaseCompositionConfig,
): void {
  if (config.installedPluginRelease === undefined) return;
  assertLoadedInstalledPluginRelease(config.installedPluginRelease);
  if (config.installedPluginExecution === undefined)
    throw new Error("installed_plugin_release_execution_authority_missing");
  if (
    config.extensionRuntime !== undefined ||
    config.extensionHost !== undefined
  )
    throw new Error("installed_plugin_release_legacy_runtime_conflict");
}

/** Uses the same actual parent Store after its opt-in schemas exist, before any runtime registration. */
export async function verifyInstalledPluginReleaseComposition(input: {
  config: InstalledPluginReleaseCompositionConfig;
  store: SqliteRunStore | PostgresDomainStore;
}): Promise<void> {
  if (input.config.installedPluginRelease === undefined) return;
  await verifyInstalledPluginRelease({
    release: input.config.installedPluginRelease,
    store: input.store,
  });
}
