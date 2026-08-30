import type { Locale } from "../i18n";
import { createAppSettingsSaveHandlers } from "../capability/appCapabilityPanelActions";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import {
  createAppSettingsRefreshHandlers,
  createSettingsRefreshHandlers,
  createSettingsSectionRefreshHandlers,
} from "../settings/settingsRefreshHandlers";
import type { Theme } from "../theme";

type SettingsRefreshParams = Parameters<
  typeof createAppSettingsRefreshHandlers
>[0];

type AppSettingsCoordinatorParams = SettingsRefreshParams & {
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
      theme: params.theme,
    }),
    settingsSectionRefreshHandlers: createSettingsSectionRefreshHandlers(
      settingsRefreshBundle,
    ),
  };
}
