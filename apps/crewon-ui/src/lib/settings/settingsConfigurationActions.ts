import type { ConfigReadResponse } from "@crewon-ui-model/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-ui-model/v2/ConfigRequirementsReadResponse";
import type { ModelListResponse } from "@crewon-ui-model/v2/ModelListResponse";

import { settledErrorMessages, settledValue } from "../shared/settledResults";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { OperatingSystem, RuntimeSurface } from "../platform";
import {
  appearanceDisconnectedPanel,
  appearanceErrorPanel,
  appearanceLoadingPanel,
  appearancePanel,
  configDisconnectedPanel,
  configErrorPanel,
  configLoadingPanel,
  configPanel,
  keyboardDisconnectedPanel,
  keyboardErrorPanel,
  keyboardLoadingPanel,
  keyboardPanel,
  personalizationDisconnectedPanel,
  personalizationErrorPanel,
  personalizationLoadingPanel,
  personalizationPanel,
} from "./settingsPanelText";
import type { Theme } from "../theme";
import type { ControlApiClient } from "@crewon/control-client";

type SettingsConfigurationClient = {
  listModels(): Promise<ModelListResponse>;
  readConfig(cwd?: string | null): Promise<ConfigReadResponse>;
  readConfigRequirements(): Promise<ConfigRequirementsReadResponse>;
};

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((currentPanel: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type BaseSettingsConfigurationParams = {
  controlClient?: Pick<ControlApiClient, "getLocalSettings"> | null;
  client: SettingsConfigurationClient | null | undefined;
  connectionHint: string;
  isConnected: boolean;
  locale: Locale;
  resolveBackendCwd: () => Promise<string | null | undefined>;
  setCapabilityPanel: SetCapabilityPanel;
};

export type RefreshConfigPanelParams = BaseSettingsConfigurationParams;

export type RefreshAppearanceSettingsPanelParams =
  BaseSettingsConfigurationParams & {
    currentLocale: Locale;
    currentTheme: Theme;
    os?: OperatingSystem;
    surface?: RuntimeSurface;
  };

export type RefreshPersonalizationSettingsPanelParams =
  BaseSettingsConfigurationParams;

export type RefreshKeyboardSettingsPanelParams =
  BaseSettingsConfigurationParams;

export async function refreshConfigPanelAction(
  params: RefreshConfigPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    locale,
    resolveBackendCwd,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(configDisconnectedPanel(connectionHint, locale));
    return;
  }

  const configCwd = await resolveBackendCwd();
  setCapabilityPanel(configLoadingPanel(configCwd ?? null, locale));

  try {
    const [configResult, requirementsResult, modelsResult] =
      await Promise.allSettled([
        client?.readConfig(configCwd ?? null),
        client?.readConfigRequirements(),
        client?.listModels(),
      ]);
    const configRead = settledValue(configResult, null);
    const configRequirements = settledValue(requirementsResult, null);
    const models = settledValue(modelsResult, null);
    const errors = settledErrorMessages([
      configResult,
      requirementsResult,
      modelsResult,
    ]);

    setCapabilityPanel(
      configPanel({
        configRead,
        configRequirements,
        cwd: configCwd ?? null,
        errors,
        locale,
        models,
      }),
    );
  } catch (error) {
    setCapabilityPanel(
      configErrorPanel({ cwd: configCwd ?? null, error, locale }),
    );
  }
}

export async function refreshAppearanceSettingsPanelAction(
  params: RefreshAppearanceSettingsPanelParams,
) {
  const {
    controlClient,
    connectionHint,
    currentLocale,
    currentTheme,
    isConnected,
    locale,
    os,
    resolveBackendCwd,
    setCapabilityPanel,
    surface,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(appearanceDisconnectedPanel(connectionHint, locale));
    return;
  }

  setCapabilityPanel(appearanceLoadingPanel(null, locale));

  try {
    if (controlClient == null) throw new Error("local_settings_unavailable");
    const { settings } = await controlClient.getLocalSettings();
    const configRead = {
      config: {
        desktop: { uiLocale: settings.locale, appearanceTheme: settings.theme },
      },
      layers: [],
      origins: {},
    } as unknown as import("@crewon-ui-model/v2/ConfigReadResponse").ConfigReadResponse;
    setCapabilityPanel(
      appearancePanel({
        configRead,
        currentLocale,
        currentTheme,
        cwd: null,
        locale,
        os,
        surface,
      }),
    );
  } catch (error) {
    setCapabilityPanel(appearanceErrorPanel({ cwd: null, error, locale }));
  }
}

export async function refreshPersonalizationSettingsPanelAction(
  params: RefreshPersonalizationSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    locale,
    resolveBackendCwd,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(
      personalizationDisconnectedPanel(connectionHint, locale),
    );
    return;
  }

  const configCwd = await resolveBackendCwd();
  setCapabilityPanel(personalizationLoadingPanel(configCwd ?? null, locale));

  try {
    const configRead = (await client?.readConfig(configCwd ?? null)) ?? null;
    setCapabilityPanel(
      personalizationPanel({
        configRead,
        cwd: configCwd ?? null,
        locale,
      }),
    );
  } catch (error) {
    setCapabilityPanel(
      personalizationErrorPanel({ cwd: configCwd ?? null, error, locale }),
    );
  }
}

export async function refreshKeyboardSettingsPanelAction(
  params: RefreshKeyboardSettingsPanelParams,
) {
  const {
    client,
    connectionHint,
    isConnected,
    locale,
    resolveBackendCwd,
    setCapabilityPanel,
  } = params;

  if (!isConnected) {
    setCapabilityPanel(keyboardDisconnectedPanel(connectionHint, locale));
    return;
  }

  const configCwd = await resolveBackendCwd();
  setCapabilityPanel(keyboardLoadingPanel(configCwd ?? null, locale));

  try {
    const configRead = (await client?.readConfig(configCwd ?? null)) ?? null;
    setCapabilityPanel(
      keyboardPanel({
        configRead,
        cwd: configCwd ?? null,
        locale,
      }),
    );
  } catch (error) {
    setCapabilityPanel(
      keyboardErrorPanel({ cwd: configCwd ?? null, error, locale }),
    );
  }
}
