import type { ExtensionStore } from "@crewon/application";
import type { PostgresDomainStore, SqliteRunStore } from "@crewon/store";

/**
 * Initialize provenance before a Worker can distinguish an ordinary Run from an
 * installed-package Run. This creates no user accounts, grants or credit holds.
 * Missing or incompatible schema remains a startup failure, never a v0 fallback.
 */
export async function preparePluginTaskAdmissionProbe(
  store: SqliteRunStore | PostgresDomainStore,
): Promise<ExtensionStore> {
  const extensions = store.extensionStore();
  await extensions.migrate();
  await store.pluginInstallationStore().migrate();
  await extensions.migratePluginAdmissions();
  return extensions;
}
