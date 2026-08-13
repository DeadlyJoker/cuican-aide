import type { ControlApiClient } from "@crewon/control-client";

import { refreshAccountPanelAction } from "../account/accountActions";
import type { AgentPlatformUser } from "../agent-platform/agentPlatformSession";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import {
  controlModelProviderActionForActionId,
  handleControlModelProviderAction,
  refreshControlModelProvidersPanel,
} from "../model-provider/controlModelProviderActions";
import {
  providerCredentialStore,
  type ProviderCredentialStorePort,
} from "../model-provider/providerCredentialStore";
import type { NoticeState } from "../shared/noticeState";
import { trimmedPanelFieldValue } from "../shared/panelState";
import type { SettingsSectionRefreshHandlers } from "../settings/settingsActions";
import { controlSettingsUnavailablePanel } from "../settings/controlSettingsAdapter";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "../settings/settingsCatalog";
import type { Theme } from "../theme";

type ControlSettingsClient = Pick<
  ControlApiClient,
  | "getAccountSnapshot"
  | "getLocalSettings"
  | "getModelProviderSettings"
  | "probeModelProvider"
  | "putLocalSettings"
>;

type SetCapabilityPanel = (
  panelOrUpdater:
    | CapabilityPanel
    | null
    | ((current: CapabilityPanel | null) => CapabilityPanel | null),
) => void;

type AppSettingsCoordinatorParams = {
  client: ControlSettingsClient;
  credentialStore?: ProviderCredentialStorePort | null;
  getCapabilityPanel: () => CapabilityPanel | null;
  locale: Locale;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
  platformUser: AgentPlatformUser | null;
  setCapabilityPanel: SetCapabilityPanel;
  setLocale: (locale: Locale) => void;
  setNotice: (notice: NoticeState | null) => void;
  setTheme: (theme: Theme) => void;
};

export type AppSettingsCoordinator = {
  commitField: (fieldId: string, value: string) => Promise<void>;
  handleAction: (actionId: string) => boolean;
  openThreadSettingsPanel: () => Promise<void>;
  refreshSection: (section: SettingsSection) => Promise<void>;
  sectionRefreshHandlers: SettingsSectionRefreshHandlers;
};

function appearancePanel(
  locale: Locale,
  settings: { locale: Locale; theme: Theme },
): CapabilityPanel {
  return {
    title: locale === "zh" ? "外观" : "Appearance",
    subtitle:
      locale === "zh"
        ? "由 CrewON Control 保存的本机偏好"
        : "Local preferences saved by CrewON Control",
    fields: [
      {
        commitOnChange: true,
        control: "segmented",
        id: "appearance-locale",
        label: locale === "zh" ? "语言" : "Language",
        options: [
          { label: "English", value: "en" },
          { label: "简体中文", value: "zh" },
        ],
        value: settings.locale,
      },
      {
        commitOnChange: true,
        control: "segmented",
        id: "appearance-theme",
        label: locale === "zh" ? "主题" : "Theme",
        options: [
          { label: locale === "zh" ? "浅色" : "Light", value: "light" },
          { label: locale === "zh" ? "深色" : "Dark", value: "dark" },
        ],
        value: settings.theme,
      },
    ],
  };
}

function unavailableNotice(locale: Locale): NoticeState {
  return {
    text:
      locale === "zh"
        ? "此设置尚无 CrewON Control 数据权威，未执行任何更改。"
        : "This setting has no CrewON Control authority. No changes were made.",
    tone: "warning",
  };
}

export function createAppSettingsCoordinator(
  params: AppSettingsCoordinatorParams,
): AppSettingsCoordinator {
  const credentialStore =
    params.credentialStore === undefined
      ? providerCredentialStore()
      : params.credentialStore;

  const refreshAppearance = async () => {
    try {
      const { settings } = await params.client.getLocalSettings();
      params.setCapabilityPanel(appearancePanel(params.locale, settings));
    } catch (error) {
      params.setCapabilityPanel({
        ...appearancePanel(params.locale, {
          locale: params.locale,
          theme: "dark",
        }),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const refreshAccount = () =>
    refreshAccountPanelAction({
      controlClient: params.client,
      locale: params.locale,
      platformUser: params.platformUser,
      setCapabilityPanel: params.setCapabilityPanel,
    });

  const modelProviderParams = () => ({
    client: params.client,
    credentialStore,
    fieldValue: (fieldId: string) =>
      trimmedPanelFieldValue(params.getCapabilityPanel(), fieldId),
    locale: params.locale,
    setCapabilityPanel: params.setCapabilityPanel,
  });

  const refreshModelProviders = () =>
    refreshControlModelProvidersPanel(modelProviderParams());

  const refreshSection = async (section: SettingsSection) => {
    switch (section) {
      case "account":
        await refreshAccount();
        return;
      case "appearance":
        await refreshAppearance();
        return;
      case "model-providers":
        await refreshModelProviders();
        return;
      case "app-snapshots":
      case "browser":
      case "computer-control":
      case "config":
      case "connections":
      case "environment":
      case "git":
      case "hooks":
      case "keyboard":
      case "mcp-servers":
      case "personalization":
      case "worktrees":
        params.setCapabilityPanel(
          controlSettingsUnavailablePanel(section, params.locale),
        );
    }
  };

  const commitField = async (fieldId: string, value: string) => {
    const isLocale = fieldId === "appearance-locale";
    const isTheme = fieldId === "appearance-theme";
    if (
      (!isLocale && !isTheme) ||
      (isLocale && value !== "en" && value !== "zh") ||
      (isTheme && value !== "light" && value !== "dark")
    ) {
      params.setNotice(unavailableNotice(params.locale));
      return;
    }

    try {
      const { settings: current } = await params.client.getLocalSettings();
      const nextLocale: Locale =
        isLocale && (value === "en" || value === "zh") ? value : current.locale;
      const nextTheme: Theme =
        isTheme && (value === "light" || value === "dark")
          ? value
          : current.theme;
      const { settings } = await params.client.putLocalSettings({
        expectedRevision: current.revision,
        locale: nextLocale,
        theme: nextTheme,
      });
      params.setLocale(settings.locale);
      params.setTheme(settings.theme);
      params.persistLocale(settings.locale);
      params.persistTheme(settings.theme);
      params.setCapabilityPanel(appearancePanel(settings.locale, settings));
      params.setNotice(null);
    } catch (error) {
      params.setCapabilityPanel((current) =>
        current
          ? {
              ...current,
              error: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
      params.setNotice({
        text:
          params.locale === "zh"
            ? "设置未保存，本地界面没有应用该更改。"
            : "The setting was not saved, so the local UI was not changed.",
        tone: "warning",
      });
    }
  };

  const sectionRefreshHandlers = Object.fromEntries(
    SETTINGS_SECTIONS.map((section) => [
      section === "app-snapshots"
        ? "appSnapshots"
        : section === "computer-control"
          ? "computerControl"
          : section === "mcp-servers"
            ? "mcpServers"
            : section === "model-providers"
              ? "modelProviders"
              : section,
      () => refreshSection(section),
    ]),
  ) as SettingsSectionRefreshHandlers;

  return {
    commitField,
    handleAction: (actionId) => {
      const modelProviderAction =
        controlModelProviderActionForActionId(actionId);
      if (modelProviderAction) {
        handleControlModelProviderAction(
          modelProviderParams(),
          modelProviderAction.action,
          modelProviderAction.providerId,
        );
        return true;
      }
      if (actionId === "refresh-account") {
        void refreshAccount();
        return true;
      }
      if (actionId === "refresh-appearance") {
        void refreshAppearance();
        return true;
      }
      if (actionId === "refresh-model-providers") {
        void refreshModelProviders();
        return true;
      }
      return false;
    },
    openThreadSettingsPanel: async () => {
      params.setCapabilityPanel(
        controlSettingsUnavailablePanel("config", params.locale),
      );
      params.setNotice(unavailableNotice(params.locale));
    },
    refreshSection,
    sectionRefreshHandlers,
  };
}
