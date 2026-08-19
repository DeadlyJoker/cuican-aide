import type { ControlApiClient } from "@crewon/control-client";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import type { SettingsSection } from "./settingsCatalog";

export type ControlSettingsClient = Pick<
  ControlApiClient,
  | "getAccountSnapshot"
  | "getLocalSettings"
  | "getModelProviderSettings"
  | "listActiveCapabilities"
  | "probeModelProvider"
  | "putLocalSettings"
>;

export type ControlSettingsAuthority =
  | "account-snapshot"
  | "active-capability-catalog"
  | "local-settings"
  | "model-provider-settings";

export type ControlSettingsAvailability =
  | { authority: ControlSettingsAuthority; status: "available" }
  | { reason: "not-owned-by-control"; status: "unavailable" };

const CONTROL_SETTINGS_AUTHORITIES: Partial<
  Record<SettingsSection, ControlSettingsAuthority>
> = {
  "account": "account-snapshot",
  "appearance": "local-settings",
  "browser": "active-capability-catalog",
  "model-providers": "model-provider-settings",
};

export function controlSettingsAvailability(
  section: SettingsSection,
): ControlSettingsAvailability {
  const authority = CONTROL_SETTINGS_AUTHORITIES[section];
  return authority
    ? { authority, status: "available" }
    : { reason: "not-owned-by-control", status: "unavailable" };
}

export function controlSettingsUnavailablePanel(
  section: SettingsSection,
  locale: Locale,
): CapabilityPanel {
  const names: Record<SettingsSection, Record<Locale, string>> = {
    "account": { en: "Account", zh: "账号" },
    "appearance": { en: "Appearance", zh: "外观" },
    "app-snapshots": { en: "App snapshots", zh: "应用快照" },
    "browser": { en: "Browser", zh: "浏览器" },
    "computer-control": { en: "Computer control", zh: "电脑操控" },
    "config": { en: "Config", zh: "配置" },
    "connections": { en: "Connections", zh: "连接" },
    "environment": { en: "Environment", zh: "环境" },
    "git": { en: "Git", zh: "Git" },
    "hooks": { en: "Hooks", zh: "钩子" },
    "keyboard": { en: "Keyboard shortcuts", zh: "键盘快捷键" },
    "mcp-servers": { en: "MCP servers", zh: "MCP 服务器" },
    "model-providers": { en: "Model access", zh: "模型接入" },
    "personalization": {
      en: "Assistant profile & memory",
      zh: "助理人格与记忆",
    },
    "worktrees": { en: "Worktrees", zh: "工作树" },
  };

  return {
    title: names[section][locale],
    subtitle: locale === "zh" ? "Control 设置" : "Control settings",
    body:
      locale === "zh"
        ? "不可用：当前 Control contract 不拥有此设置。"
        : "Unavailable: this setting is not owned by the current Control contract.",
  };
}

export function createControlSettingsAdapter(
  client: ControlSettingsClient | null | undefined,
) {
  return {
    availability: controlSettingsAvailability,
    getAccountSnapshot: () => client?.getAccountSnapshot(),
    getLocalSettings: () => client?.getLocalSettings(),
    getModelProviderSettings: () => client?.getModelProviderSettings(),
    listActiveCapabilities: (
      query: Parameters<ControlSettingsClient["listActiveCapabilities"]>[0],
    ) => client?.listActiveCapabilities(query),
    probeModelProvider: (idempotencyKey: string) =>
      client?.probeModelProvider(idempotencyKey),
    putLocalSettings: (
      input: Parameters<ControlSettingsClient["putLocalSettings"]>[0],
    ) => client?.putLocalSettings(input),
  };
}
