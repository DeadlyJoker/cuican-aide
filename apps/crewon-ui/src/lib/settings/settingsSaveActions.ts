import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { SettingsSaveAction } from "./settingsActions";
import {
  buildAppearanceEdits,
  buildConfigEdits,
  buildPersonalizationEdits,
  configValuesMissingPanel,
  type ConfigEdit,
  type ConfigWriteSummary,
  settingsDisconnectedPanel,
  settingsSaveFailurePanel,
  settingsSaveProgressPanel,
  settingsSaveSuccessPanel,
} from "./settingsSavePayloads";
import type { Theme } from "../theme";
import {
  personalizationSettingsFromFields,
  type PersonalizationSettingsStore,
} from "./personalizationSettingsStore";

type SettingsSaveClient = {
  writeConfigBatch(
    edits: ConfigEdit[],
  ): Promise<ConfigWriteSummary | null | undefined>;
};

type SetCapabilityPanel = (
  updater: (currentPanel: CapabilityPanel | null) => CapabilityPanel | null,
) => void;

export type SettingsSaveHandlersParams = {
  client: SettingsSaveClient | null | undefined;
  fieldValue: (fieldId: string) => string;
  isConnected: boolean;
  locale: Locale;
  persistLocale: (locale: Locale) => void;
  persistTheme: (theme: Theme) => void;
  personalizationStore?: PersonalizationSettingsStore | null;
  refreshAppearanceSettingsPanel: () => Promise<void> | void;
  refreshConfigPanel: () => Promise<void> | void;
  refreshPersonalizationSettingsPanel: () => Promise<void> | void;
  setCapabilityPanel: SetCapabilityPanel;
  setLocale: (locale: Locale) => void;
  setTheme: (theme: Theme) => void;
  theme: Theme;
};

export function createSettingsSaveHandlers(
  params: SettingsSaveHandlersParams,
): Record<SettingsSaveAction, () => void> {
  return {
    appearance: () => saveAppearanceSettings(params),
    config: () => saveConfigSettings(params),
    personalization: () => savePersonalizationSettings(params),
  };
}

function saveConfigSettings(params: SettingsSaveHandlersParams) {
  const { client, fieldValue, isConnected, locale, setCapabilityPanel } =
    params;
  const edits = buildConfigEdits(fieldValue);

  if (!isConnected || !client) {
    setCapabilityPanel((currentPanel) =>
      settingsDisconnectedPanel(currentPanel, locale),
    );
    return;
  }

  if (edits.length === 0) {
    setCapabilityPanel((currentPanel) =>
      configValuesMissingPanel(currentPanel, locale),
    );
    return;
  }

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      settingsSaveProgressPanel(currentPanel, "config", locale),
    );

    try {
      const response = await client.writeConfigBatch(edits);
      setCapabilityPanel((currentPanel) =>
        settingsSaveSuccessPanel(currentPanel, {
          kind: "config",
          locale,
          response,
        }),
      );
      await params.refreshConfigPanel();
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        settingsSaveFailurePanel(currentPanel, "config", error, locale),
      );
    }
  })();
}

function saveAppearanceSettings(params: SettingsSaveHandlersParams) {
  const {
    client,
    fieldValue,
    isConnected,
    locale,
    persistLocale,
    persistTheme,
    setCapabilityPanel,
    setLocale,
    setTheme,
    theme,
  } = params;
  const { edits, nextLocale, nextTheme } = buildAppearanceEdits(
    fieldValue,
    locale,
    theme,
  );

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      settingsSaveProgressPanel(currentPanel, "appearance", locale),
    );

    try {
      const response =
        isConnected && client ? await client.writeConfigBatch(edits) : null;
      if (nextLocale === "zh" || nextLocale === "en") {
        setLocale(nextLocale);
        persistLocale(nextLocale);
      }
      if (nextTheme === "dark" || nextTheme === "light") {
        setTheme(nextTheme);
        persistTheme(nextTheme);
      }
      setCapabilityPanel((currentPanel) =>
        settingsSaveSuccessPanel(currentPanel, {
          kind: "appearance",
          locale,
          response,
        }),
      );
      await params.refreshAppearanceSettingsPanel();
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        settingsSaveFailurePanel(currentPanel, "appearance", error, locale),
      );
    }
  })();
}

function savePersonalizationSettings(params: SettingsSaveHandlersParams) {
  const {
    client,
    fieldValue,
    isConnected,
    locale,
    personalizationStore,
    setCapabilityPanel,
  } = params;
  const edits = buildPersonalizationEdits(fieldValue);

  if (!personalizationStore && (!isConnected || !client)) {
    setCapabilityPanel((currentPanel) =>
      settingsDisconnectedPanel(currentPanel, locale),
    );
    return;
  }

  void (async () => {
    setCapabilityPanel((currentPanel) =>
      settingsSaveProgressPanel(currentPanel, "personalization", locale),
    );

    try {
      let response: ConfigWriteSummary | null | undefined = null;
      if (personalizationStore) {
        personalizationStore.write(
          personalizationSettingsFromFields(fieldValue),
        );
      } else if (client) {
        response = await client.writeConfigBatch(edits);
      }
      setCapabilityPanel((currentPanel) =>
        settingsSaveSuccessPanel(currentPanel, {
          kind: "personalization",
          locale,
          response,
        }),
      );
      await params.refreshPersonalizationSettingsPanel();
    } catch (error) {
      setCapabilityPanel((currentPanel) =>
        settingsSaveFailurePanel(
          currentPanel,
          "personalization",
          error,
          locale,
        ),
      );
    }
  })();
}
