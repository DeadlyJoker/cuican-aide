import { commitSettingsFieldAction } from "./settingsFieldCommitActions";
import { applyAppearanceField } from "../appearance/appearanceRuntime";
import { persistLocale } from "../i18n";
import { persistTheme } from "../theme";
import type { AppearancePreferences } from "../appearance/appearancePreferences";
import type { Locale } from "../i18n";
import type { NoticeState } from "../shared/noticeState";
import type { SettingsSection } from "./settingsCatalog";
import type { Theme } from "../theme";

/**
 * Commits one settings field and reconciles the panel with what took effect.
 *
 * A committed value is not always the value that was typed: appearance fields
 * clamp or reject out-of-range input. When that happens the panel is re-read so
 * a rejected entry cannot stay on screen looking applied.
 */
export function commitSettingsField(params: {
  /** Mirrors the action's client contract without widening its visibility. */
  client: Parameters<typeof commitSettingsFieldAction>[0]["client"];
  fieldId: string;
  isConnected: boolean;
  locale: Locale;
  refreshSettingsSection: (section: SettingsSection) => void;
  setLocale: (locale: Locale) => void;
  setNotice: (notice: NoticeState) => void;
  setTheme: (theme: Theme) => void;
  settingsSection: () => SettingsSection;
  value: string;
}): void {
  void commitSettingsFieldAction({
    applyAppearanceField: (field: keyof AppearancePreferences, value: string) =>
      applyAppearanceField(field, value),
    client: params.client,
    fieldId: params.fieldId,
    isConnected: params.isConnected,
    persistLocale,
    persistTheme,
    setLocale: params.setLocale,
    setTheme: params.setTheme,
    value: params.value,
  })
    .then((outcome) => {
      if (params.fieldId !== "appearance-locale" && !outcome.normalized) {
        return;
      }
      /*
       * Deferred to a task so the panel is re-read after this commit settles,
       * rather than racing the state update it just triggered.
       */
      window.setTimeout(() => {
        params.refreshSettingsSection(params.settingsSection());
      }, 0);
    })
    .catch((error) => {
      params.setNotice({
        text:
          error instanceof Error
            ? error.message
            : params.locale === "zh"
              ? "设置保存失败"
              : "Unable to save setting",
        tone: "warning",
      });
    });
}
