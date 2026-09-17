import type { Locale } from "../i18n";
import { createAppSettingsSaveHandlers } from "../capability/appCapabilityPanelActions";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createAppSettingsRefreshHandlers,
  createSettingsRefreshHandlers,
  createSettingsSectionRefreshHandlers,
} from "../settings/settingsRefreshHandlers";
import type { Theme } from "../theme";
import type { NoticeState } from "../shared/noticeState";

type SettingsRefreshParams = Parameters<
  typeof createAppSettingsRefreshHandlers
>[0];

type AppSettingsCoordinatorParams = SettingsRefreshParams & {
  setNotice?: (notice: NoticeState) => void;
  capabilityPanel: CapabilityPanel | null;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
};

export function createAppSettingsCoordinator(
  params: AppSettingsCoordinatorParams,
) {
  const settingsRefreshBundle = createAppSettingsRefreshHandlers(params);
  const {
    refreshAppearanceSettingsPanel,
    refreshConfigPanel,
    refreshPersonalizationSettingsPanel,
  } = settingsRefreshBundle;
  const sectionHandlers = createSettingsSectionRefreshHandlers(
    settingsRefreshBundle,
  );
  if (params.controlClient && !params.isDemoPreview) {
    // The Control route owns these reads and cancels them on navigation.
    // Do not query the retired app-server or fabricate empty inventories.
    const clearLegacyPanel = async () => params.setCapabilityPanel(null);
    for (const section of [
      "account",
      "config",
      "connections",
      "environment",
      "mcpServers",
      "browser",
      "computerControl",
    ] as const) {
      sectionHandlers[section] = clearLegacyPanel;
    }
  }

  return {
    ...settingsRefreshBundle,
    settingsRefreshHandlers: createSettingsRefreshHandlers(
      settingsRefreshBundle,
    ),
    settingsSaveHandlers: createAppSettingsSaveHandlers({
      capabilityPanel: params.capabilityPanel,
      client: params.client,
      isConnected: params.isConnected,
      locale: params.locale,
      persistLocale: params.persistLocale,
      persistTheme: params.persistTheme,
      personalizationStore: params.personalizationStore,
      refreshAppearanceSettingsPanel,
      refreshConfigPanel,
      refreshPersonalizationSettingsPanel,
      setCapabilityPanel: params.setCapabilityPanel,
      setLocale: params.setLocale,
      setTheme: params.setTheme,
      setNotice: params.setNotice,
      theme: params.theme,
    }),
    settingsSectionRefreshHandlers: sectionHandlers,
  };
}
