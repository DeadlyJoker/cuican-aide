import type { PluginInstallResponse } from "@crewon-ui-model/v2/PluginInstallResponse";

import type { LibraryKind, LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { pluginInstallResultPanel } from "./libraryActionPresentation";

type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type LibraryPluginActionParams = {
  action: LibraryPanelAction;
  installPlugin: (
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ) => Promise<PluginInstallResponse | null | undefined>;
  locale: Locale;
  openLibrary: (kind: LibraryKind) => Promise<void>;
  setLibraryPanel: LibraryPanelSetter;
  uninstallPlugin: (pluginId: string) => Promise<void>;
};

export async function handleLibraryPluginAction({
  action,
  installPlugin,
  locale,
  openLibrary,
  setLibraryPanel,
  uninstallPlugin,
}: LibraryPluginActionParams): Promise<boolean> {
  if (action.id === "install-plugin") {
    if (!action.pluginName) {
      return true;
    }
    const response = await installPlugin(
      action.pluginName,
      action.marketplacePath,
      action.remoteMarketplaceName,
    );
    setLibraryPanel((currentPanel) =>
      pluginInstallResultPanel(currentPanel, response, locale),
    );
    await openLibrary("plugins");
    return true;
  }

  if (action.id === "uninstall-plugin") {
    if (!action.pluginId) {
      return true;
    }
    await uninstallPlugin(action.pluginId);
    await openLibrary("plugins");
    return true;
  }

  return false;
}
