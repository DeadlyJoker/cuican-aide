import {
  DESKTOP_LOCALE_KEY_PATH,
  DESKTOP_THEME_KEY_PATH,
} from "../shared/desktopPreferenceKeys";
import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export type ConfigEdit = {
  keyPath: string;
  value: string;
};

export type ThreadSettingsPatch = {
  approvalPolicy: string;
  model: string;
  sandboxMode: string;
};

export type ConfigWriteSummary = {
  filePath?: string | null;
  status?: string | null;
  version?: bigint | number | string | null;
};

export type SettingsSaveKind = "appearance" | "config" | "personalization";

export function buildConfigEdits(
  fieldValue: (fieldId: string) => string,
): ConfigEdit[] {
  return [
    { keyPath: "model", value: fieldValue("config-model") },
    {
      keyPath: "approval_policy",
      value: fieldValue("config-approval-policy"),
    },
    { keyPath: "sandbox_mode", value: fieldValue("config-sandbox-mode") },
  ].filter((edit) => edit.value);
}

export function buildAppearanceEdits(
  fieldValue: (fieldId: string) => string,
  currentLocale: Locale,
  currentTheme: string,
): { edits: ConfigEdit[]; nextLocale: string; nextTheme: string } {
  const nextLocale = fieldValue("appearance-locale");
  const nextTheme = fieldValue("appearance-theme");
  return {
    nextLocale,
    nextTheme,
    edits: [
      { keyPath: DESKTOP_LOCALE_KEY_PATH, value: nextLocale || currentLocale },
      { keyPath: DESKTOP_THEME_KEY_PATH, value: nextTheme || currentTheme },
    ],
  };
}

export function buildPersonalizationEdits(
  fieldValue: (fieldId: string) => string,
): ConfigEdit[] {
  return [
    {
      keyPath: "instructions",
      value: fieldValue("personalization-instructions"),
    },
    {
      keyPath: "developer_instructions",
      value: fieldValue("personalization-developer-instructions"),
    },
  ];
}

export function buildThreadSettingsPatch(
  fieldValue: (fieldId: string) => string,
): ThreadSettingsPatch {
  return {
    approvalPolicy: fieldValue("thread-settings-approval-policy"),
    model: fieldValue("thread-settings-model"),
    sandboxMode: fieldValue("thread-settings-sandbox-mode"),
  };
}

export function hasThreadSettingsPatch(patch: ThreadSettingsPatch): boolean {
  return Boolean(patch.model || patch.approvalPolicy || patch.sandboxMode);
}

export function localServerDisconnectedMessage(locale: Locale): string {
  return locale === "zh"
    ? "未连接本地 app-server"
    : "Local app-server is not connected";
}

export function noConfigValuesToSaveMessage(locale: Locale): string {
  return locale === "zh" ? "没有可保存的配置项" : "No config values to save";
}

export function noThreadSettingsSelectedMessage(locale: Locale): string {
  return locale === "zh"
    ? "没有可保存的会话设置"
    : "No session settings selected";
}

export function realThreadRequiredMessage(locale: Locale): string {
  return locale === "zh" ? "请先选择一个真实会话" : "Select a real session first";
}

export function settingsSaveInProgressBody(
  kind: SettingsSaveKind,
  locale: Locale,
): string {
  if (kind === "config") {
    return locale === "zh" ? "正在保存配置..." : "Saving config...";
  }
  if (kind === "appearance") {
    return locale === "zh"
      ? "正在保存外观设置..."
      : "Saving appearance settings...";
  }
  return locale === "zh"
    ? "正在保存个性化设置..."
    : "Saving personalization settings...";
}

export function settingsSaveSuccessBody(
  kind: SettingsSaveKind,
  response: ConfigWriteSummary | null | undefined,
  locale: Locale,
): string {
  const savedMessage =
    kind === "config"
      ? locale === "zh"
        ? "配置已保存并热重载"
        : "Config saved and hot-reloaded"
      : kind === "appearance"
        ? locale === "zh"
          ? "外观设置已保存"
          : "Appearance saved"
        : locale === "zh"
          ? "个性化设置已保存"
          : "Personalization saved";
  return `${savedMessage}\nversion: ${response?.version ?? "-"}\nstatus: ${
    response?.status ?? "ok"
  }`;
}

export function settingsSaveFailureMessage(
  kind: SettingsSaveKind,
  error: unknown,
  locale: Locale,
): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (kind === "config") {
    return locale === "zh" ? "保存配置失败" : "Unable to save config";
  }
  if (kind === "appearance") {
    return locale === "zh"
      ? "保存外观设置失败"
      : "Unable to save appearance settings";
  }
  return locale === "zh"
    ? "保存个性化设置失败"
    : "Unable to save personalization settings";
}

export function configValuesMissingPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: noConfigValuesToSaveMessage(locale),
  };
}

function patchSettingsPanel(
  panel: CapabilityPanel | null,
  patch: Partial<CapabilityPanel>,
): CapabilityPanel | null {
  return panel ? { ...panel, ...patch } : panel;
}

export function configValuesMissingPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, configValuesMissingPatch(locale));
}

export function settingsDisconnectedPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: localServerDisconnectedMessage(locale),
  };
}

export function settingsDisconnectedPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, settingsDisconnectedPatch(locale));
}

export function settingsSaveProgressPatch(
  kind: SettingsSaveKind,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: settingsSaveInProgressBody(kind, locale),
    error: undefined,
  };
}

export function settingsSaveProgressPanel(
  panel: CapabilityPanel | null,
  kind: SettingsSaveKind,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, settingsSaveProgressPatch(kind, locale));
}

export function settingsSaveSuccessPatch(params: {
  currentSubtitle?: string;
  kind: SettingsSaveKind;
  locale: Locale;
  response: ConfigWriteSummary | null | undefined;
}): Partial<CapabilityPanel> {
  const { currentSubtitle, kind, locale, response } = params;
  return {
    subtitle: response?.filePath ?? currentSubtitle,
    body: settingsSaveSuccessBody(kind, response, locale),
    error: undefined,
  };
}

export function settingsSaveSuccessPanel(
  panel: CapabilityPanel | null,
  params: {
    kind: SettingsSaveKind;
    locale: Locale;
    response: ConfigWriteSummary | null | undefined;
  },
): CapabilityPanel | null {
  return patchSettingsPanel(
    panel,
    settingsSaveSuccessPatch({
      currentSubtitle: panel?.subtitle,
      ...params,
    }),
  );
}

export function settingsSaveFailurePatch(
  kind: SettingsSaveKind,
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: settingsSaveFailureMessage(kind, error, locale),
  };
}

export function settingsSaveFailurePanel(
  panel: CapabilityPanel | null,
  kind: SettingsSaveKind,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, settingsSaveFailurePatch(kind, error, locale));
}

export function threadSettingsMissingSelectionPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: noThreadSettingsSelectedMessage(locale),
  };
}

export function threadSettingsMissingSelectionPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(
    panel,
    threadSettingsMissingSelectionPatch(locale),
  );
}

export function realThreadRequiredPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: realThreadRequiredMessage(locale),
  };
}

export function realThreadRequiredPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, realThreadRequiredPatch(locale));
}

export function threadSettingsSaveInProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在保存会话设置..." : "Saving session settings...";
}

export function threadSettingsSaveSuccessBody(
  patch: ThreadSettingsPatch,
  locale: Locale,
): string {
  return [
    locale === "zh"
      ? "会话设置已保存，将作用于后续任务。"
      : "Session settings saved for future turns.",
    patch.model ? `${locale === "zh" ? "模型" : "Model"}: ${patch.model}` : null,
    patch.approvalPolicy
      ? `${locale === "zh" ? "审批" : "Approval"}: ${patch.approvalPolicy}`
      : null,
    patch.sandboxMode
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${patch.sandboxMode}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function threadSettingsSaveFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "保存会话设置失败"
      : "Unable to save session settings";
}

export function threadSettingsSaveProgressPatch(
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: threadSettingsSaveInProgressBody(locale),
    error: undefined,
  };
}

export function threadSettingsSaveProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, threadSettingsSaveProgressPatch(locale));
}

export function threadSettingsSaveSuccessPatch(
  patch: ThreadSettingsPatch,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    body: threadSettingsSaveSuccessBody(patch, locale),
    error: undefined,
  };
}

export function threadSettingsSaveSuccessPanel(
  panel: CapabilityPanel | null,
  patch: ThreadSettingsPatch,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(
    panel,
    threadSettingsSaveSuccessPatch(patch, locale),
  );
}

export function threadSettingsSaveFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<CapabilityPanel> {
  return {
    error: threadSettingsSaveFailureMessage(error, locale),
  };
}

export function threadSettingsSaveFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchSettingsPanel(panel, threadSettingsSaveFailurePatch(error, locale));
}
