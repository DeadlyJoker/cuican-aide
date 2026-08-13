import type { PluginReadResponse } from "@crewon-ui-model/v2/PluginReadResponse";

import type { LibraryItemAction, LibraryPanel } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import {
  buildPluginDetailPanelContent,
  pluginDetailContentPanel,
  pluginDetailFailurePanel,
  pluginDetailLoadingPanel,
} from "./pluginDetailPanel";

type PluginDetailAction = Extract<LibraryItemAction, { type: "plugin" }>;
type LibraryPanelSetter = (
  updater: (panel: LibraryPanel | null) => LibraryPanel | null,
) => void;

export type OpenPluginDetailActionParams = {
  action: PluginDetailAction;
  locale: Locale;
  readPlugin: (
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ) => Promise<PluginReadResponse | null | undefined>;
  setLibraryPanel: LibraryPanelSetter;
};

export async function openPluginDetailAction({
  action,
  locale,
  readPlugin,
  setLibraryPanel,
}: OpenPluginDetailActionParams): Promise<boolean> {
  setLibraryPanel((currentPanel) =>
    pluginDetailLoadingPanel(currentPanel, locale),
  );

  try {
    const response = await readPlugin(
      action.pluginName,
      action.marketplacePath,
      action.remoteMarketplaceName,
    );

    if (!response) {
      return true;
    }

    const pluginDetailContent = buildPluginDetailPanelContent(
      response,
      action,
      locale,
    );

    setLibraryPanel((currentPanel) =>
      pluginDetailContentPanel(currentPanel, pluginDetailContent),
    );
  } catch (error) {
    setLibraryPanel((currentPanel) =>
      pluginDetailFailurePanel(currentPanel, error, locale),
    );
  }
  return true;
}
