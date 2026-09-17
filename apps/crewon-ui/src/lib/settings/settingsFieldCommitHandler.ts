import { commitSettingsFieldAction } from "./settingsFieldCommitActions";
import { applyAppearanceField } from "../appearance/appearanceRuntime";
import { persistLocalAppearanceField } from "../appearance/localAppearanceStore";
import { systemPrefersDark } from "../appearance/applyAppearance";
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
  const section = params.settingsSection();
  void commitSettingsFieldAction({
    applyAppearanceField: (field: keyof AppearancePreferences, value: string) =>
      applyAppearanceField(field, value),
    persistLocalAppearanceField,
    systemPrefersDark: systemPrefersDark(),
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
        if (params.settingsSection() === section)
          params.refreshSettingsSection(section);
      }, 0);
    })
    .catch((error) => {
      params.setNotice({
        text: settingsFieldCommitErrorText(error, params.locale),
        tone: "warning",
      });
      if (params.settingsSection() === section)
        params.refreshSettingsSection(section);
    });
}

export function settingsFieldCommitErrorText(
  error: unknown,
  locale: Locale,
): string {
  const message = error instanceof Error ? error.message : "";
  if (/appearance_storage/iu.test(message)) {
    return locale === "zh"
      ? "无法保存到本机存储，请检查存储权限后重试。"
      : "Could not save locally. Check storage access and retry.";
  }
  if (/app-server|not connected|unavailable|disconnected/iu.test(message)) {
    return locale === "zh"
      ? "当前更改未确认保存，请检查连接后重试。"
      : "Saving this change is unconfirmed. Check the connection and retry.";
  }
  return locale === "zh"
    ? "这项设置暂时无法保存，请稍后重试。"
    : "This setting cannot be saved right now. Try again shortly.";
}
