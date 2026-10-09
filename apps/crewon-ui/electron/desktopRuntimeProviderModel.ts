import { desktopInstalledPluginModelCatalog } from "./desktopInstalledPluginModelCatalog.ts";
import type { ActiveProvider } from "./providerCredentials.ts";
/** Runtime-only choice; stored Provider settings and credentials are not rewritten. */
export function desktopRuntimeProviderModel(
  provider: ActiveProvider,
  catalog: readonly string[],
): ActiveProvider | null {
  const runnable = desktopInstalledPluginModelCatalog(
    { CREWON_MODEL_CATALOG_JSON: JSON.stringify(catalog) },
    provider.modelId,
  );
  if (runnable.length === 0) return null;
  if (runnable.includes(provider.modelId)) return provider;
  return Object.freeze({ ...provider, modelId: runnable[0]! });
}
