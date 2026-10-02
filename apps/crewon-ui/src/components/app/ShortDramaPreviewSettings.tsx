import { useState } from "react";
import {
  appliedAppearance,
  applyAppearanceField,
} from "../../lib/appearance/appearanceRuntime";
import {
  LOCAL_APPEARANCE_KEY,
  persistLocalAppearanceField,
  readLocalAppearance,
} from "../../lib/appearance/localAppearanceStore";
import { systemPrefersDark } from "../../lib/appearance/applyAppearance";
import type { AppearancePreferences } from "../../lib/appearance/appearancePreferences";
import { persistLocale, type Locale } from "../../lib/i18n";
import { persistTheme, type Theme } from "../../lib/theme";
import type { NoticeState } from "../../lib/shared/noticeState";
import {
  detectOperatingSystem,
  detectPlatform,
  detectRuntimeSurface,
} from "../../lib/platform";
import {
  controlSettingsPanel,
  usesControlSettingsPanel,
} from "../../lib/settings/controlSettingsPanels";
import {
  appearancePanel,
  keyboardPanel,
} from "../../lib/settings/settingsConfigurationPanels";
import { commitSettingsFieldAction } from "../../lib/settings/settingsFieldCommitActions";
import { settingsFieldCommitErrorText } from "../../lib/settings/settingsFieldCommitHandler";
import type { SettingsSection } from "../../lib/settings/settingsCatalog";
import { CommandSettingsRoute } from "./CommandSettingsRoute";

/** Existing settings UI with local preferences and no connected backend. */
export function ShortDramaPreviewSettings({
  locale,
  onBack,
  onLocaleChange,
}: {
  locale: Locale;
  onBack(): void;
  onLocaleChange(locale: Locale): void;
}) {
  const [section, setSection] = useState<SettingsSection>("config");
  const [preferences, setPreferences] = useState(
    () => readLocalAppearance() ?? appliedAppearance(),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const surface = detectRuntimeSurface();
  const localSettingsAvailable =
    section === "appearance" || section === "keyboard";
  const panel =
    section === "appearance"
      ? appearancePanel({
          localPreferences: preferences,
          configRead: null,
          currentLocale: locale,
          currentTheme:
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "light",
          cwd: null,
          locale,
          os: detectOperatingSystem(),
          surface,
        })
      : section === "keyboard"
        ? keyboardPanel({ configRead: null, cwd: null, locale })
        : usesControlSettingsPanel(section)
          ? controlSettingsPanel({
              section,
              locale,
              state: { status: "error" },
              platformUser: null,
              surface,
            })
          : null;

  async function commitField(fieldId: string, value: string) {
    if (
      section !== "appearance" ||
      !panel?.fields?.some((f) => f.id === fieldId)
    )
      return;
    let appearanceBeforeWrite: string | null = null;
    let appearanceWritten = false;
    let nextLocale: Locale | undefined;
    let nextTheme: Theme | undefined;
    let nextAppearance: [keyof AppearancePreferences, string] | undefined;
    try {
      await commitSettingsFieldAction({
        client: null,
        isConnected: false,
        fieldId,
        value,
        persistLocalAppearanceField: (field, nextValue) => {
          appearanceBeforeWrite = localStorage.getItem(LOCAL_APPEARANCE_KEY);
          persistLocalAppearanceField(field, nextValue);
          appearanceWritten = true;
        },
        persistLocale: (next) => {
          try {
            persistLocale(next);
          } catch {
            throw new Error("appearance_storage_unavailable");
          }
        },
        persistTheme: (next) => {
          try {
            persistTheme(next);
          } catch {
            throw new Error("appearance_storage_unavailable");
          }
        },
        setLocale: (next) => {
          nextLocale = next;
        },
        setTheme: (next) => {
          nextTheme = next;
        },
        applyAppearanceField: (field, nextValue) => {
          nextAppearance = [field, nextValue];
        },
        systemPrefersDark: systemPrefersDark(),
      });
      if (nextAppearance) applyAppearanceField(...nextAppearance);
      if (nextTheme) document.documentElement.dataset.theme = nextTheme;
      if (nextLocale) onLocaleChange(nextLocale);
      setPreferences(readLocalAppearance() ?? appliedAppearance());
      setNotice(null);
    } catch (error) {
      // A legacy theme-key write can fail after the appearance record was saved.
      // Keep the previous preferences when that second write could not finish.
      if (appearanceWritten) {
        try {
          if (appearanceBeforeWrite === null)
            localStorage.removeItem(LOCAL_APPEARANCE_KEY);
          else
            localStorage.setItem(LOCAL_APPEARANCE_KEY, appearanceBeforeWrite);
        } catch {
          // The warning remains visible even if storage also rejects rollback.
        }
      }
      setNotice({
        text: settingsFieldCommitErrorText(error, locale),
        tone: "warning",
      });
    } finally {
      setDrafts((current) => {
        const next = { ...current };
        delete next[fieldId];
        return next;
      });
    }
  }

  return (
    <CommandSettingsRoute
      activeSection={section}
      controlClient={null}
      platformUser={null}
      dataMode={localSettingsAvailable ? "live" : "disconnected"}
      disabled={!localSettingsAvailable}
      locale={locale}
      notice={notice}
      panel={
        panel
          ? {
              ...panel,
              fields: panel.fields?.map((field) => ({
                ...field,
                value: drafts[field.id] ?? field.value,
              })),
            }
          : null
      }
      platform={detectPlatform()}
      onBack={onBack}
      onDismissNotice={() => setNotice(null)}
      onPanelAction={(actionId) => {
        if (section === "keyboard" && actionId === "refresh-keyboard") {
          setDrafts({});
          setNotice(null);
        }
      }}
      onPanelFieldChange={(fieldId, value) => {
        if (section === "appearance")
          setDrafts((current) => ({ ...current, [fieldId]: value }));
      }}
      onPanelFieldCommit={(fieldId, value) => {
        void commitField(fieldId, value);
      }}
      onSectionChange={(next) => {
        setDrafts({});
        setNotice(null);
        setSection(next);
      }}
    />
  );
}
