import type { Locale } from "../i18n";

export const SETTINGS_SECTIONS = [
  "account",
  "appearance",
  "app-snapshots",
  "browser",
  "computer-control",
  "config",
  "connections",
  "environment",
  "git",
  "hooks",
  "keyboard",
  "mcp-servers",
  "personalization",
  "worktrees",
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type SettingsIconKey =
  | "app-window"
  | "bot"
  | "cable"
  | "git-branch"
  | "globe"
  | "keyboard"
  | "palette"
  | "shield-check"
  | "sliders-horizontal"
  | "sparkles"
  | "terminal-square";

type SettingsCopyKey =
  | "appSnapshots"
  | "appearance"
  | "browser"
  | "coding"
  | "computerControl"
  | "config"
  | "connections"
  | "environment"
  | "general"
  | "git"
  | "hooks"
  | "integrations"
  | "keyboard"
  | "mcpServers"
  | "personal"
  | "personalization"
  | "worktrees";

export type SettingsConfigScope =
  | "account"
  | "desktop"
  | "integration"
  | "runtime"
  | "session"
  | "source-control"
  | "workspace";

export type SettingsConfigField = {
  fieldId: string;
  configPath: string;
  valueKind: "secret" | "select" | "string";
  writeActionId?: string;
};

export type SettingsBackendBinding = {
  refreshTarget: string;
  scope: SettingsConfigScope;
  fields?: readonly SettingsConfigField[];
};

export type SettingsCatalogItem = {
  id: SettingsSection;
  labelKey: SettingsCopyKey;
  icon: SettingsIconKey;
  backend: SettingsBackendBinding;
};

export type SettingsCatalogGroup = {
  id: "coding" | "integrations" | "personal";
  labelKey: SettingsCopyKey;
  items: readonly SettingsCatalogItem[];
};

type SettingsSidebarCopy = Record<
  SettingsCopyKey | "back" | "search" | "title",
  string
>;

const sidebarCopy: Record<Locale, SettingsSidebarCopy> = {
  zh: {
    appSnapshots: "应用快照",
    appearance: "外观",
    back: "返回应用",
    browser: "浏览器",
    coding: "编码",
    computerControl: "电脑操控",
    config: "配置",
    connections: "连接",
    environment: "环境",
    general: "常规",
    git: "Git",
    hooks: "钩子",
    integrations: "集成",
    keyboard: "键盘快捷键",
    mcpServers: "MCP 服务器",
    personal: "个人",
    personalization: "个性化",
    search: "搜索设置...",
    title: "设置",
    worktrees: "工作树",
  },
  en: {
    appSnapshots: "App snapshots",
    appearance: "Appearance",
    back: "Back to app",
    browser: "Browser",
    coding: "Coding",
    computerControl: "Computer control",
    config: "Config",
    connections: "Connections",
    environment: "Environment",
    general: "General",
    git: "Git",
    hooks: "Hooks",
    integrations: "Integrations",
    keyboard: "Keyboard shortcuts",
    mcpServers: "MCP servers",
    personal: "Personal",
    personalization: "Personalization",
    search: "Search settings...",
    title: "Settings",
    worktrees: "Worktrees",
  },
};

export function settingsSidebarCopy(locale: Locale): SettingsSidebarCopy {
  return sidebarCopy[locale];
}

export const settingsCatalog = [
  {
    id: "personal",
    labelKey: "personal",
    items: [
      {
        id: "account",
        labelKey: "general",
        icon: "shield-check",
        backend: {
          refreshTarget: "account",
          scope: "account",
        },
      },
      {
        id: "appearance",
        labelKey: "appearance",
        icon: "palette",
        backend: {
          refreshTarget: "appearance-settings",
          scope: "desktop",
          fields: [
            {
              fieldId: "appearance-locale",
              configPath: "ui.locale",
              valueKind: "select",
              writeActionId: "save-appearance",
            },
            {
              fieldId: "appearance-theme",
              configPath: "ui.theme",
              valueKind: "select",
              writeActionId: "save-appearance",
            },
          ],
        },
      },
      {
        id: "config",
        labelKey: "config",
        icon: "sliders-horizontal",
        backend: {
          refreshTarget: "config",
          scope: "workspace",
          fields: [
            {
              fieldId: "config-model",
              configPath: "model",
              valueKind: "string",
              writeActionId: "save-config",
            },
            {
              fieldId: "config-approval-policy",
              configPath: "approval_policy",
              valueKind: "string",
              writeActionId: "save-config",
            },
            {
              fieldId: "config-sandbox-mode",
              configPath: "sandbox_mode",
              valueKind: "string",
              writeActionId: "save-config",
            },
          ],
        },
      },
      {
        id: "personalization",
        labelKey: "personalization",
        icon: "sparkles",
        backend: {
          refreshTarget: "personalization-settings",
          scope: "desktop",
          fields: [
            {
              fieldId: "personalization-instructions",
              configPath: "instructions",
              valueKind: "string",
              writeActionId: "save-personalization",
            },
            {
              fieldId: "personalization-developer-instructions",
              configPath: "developer_instructions",
              valueKind: "string",
              writeActionId: "save-personalization",
            },
          ],
        },
      },
      {
        id: "keyboard",
        labelKey: "keyboard",
        icon: "keyboard",
        backend: {
          refreshTarget: "keyboard-settings",
          scope: "desktop",
        },
      },
    ],
  },
  {
    id: "integrations",
    labelKey: "integrations",
    items: [
      {
        id: "app-snapshots",
        labelKey: "appSnapshots",
        icon: "app-window",
        backend: {
          refreshTarget: "app-snapshots-settings",
          scope: "integration",
        },
      },
      {
        id: "mcp-servers",
        labelKey: "mcpServers",
        icon: "bot",
        backend: {
          refreshTarget: "mcp-settings",
          scope: "integration",
        },
      },
      {
        id: "browser",
        labelKey: "browser",
        icon: "globe",
        backend: {
          refreshTarget: "browser-settings",
          scope: "integration",
        },
      },
      {
        id: "computer-control",
        labelKey: "computerControl",
        icon: "terminal-square",
        backend: {
          refreshTarget: "computer-control-settings",
          scope: "integration",
          fields: [
            {
              fieldId: "remote-control-revoke-client",
              configPath: "remote_control.clients[].client_id",
              valueKind: "string",
              writeActionId: "revoke-remote-client",
            },
          ],
        },
      },
    ],
  },
  {
    id: "coding",
    labelKey: "coding",
    items: [
      {
        id: "hooks",
        labelKey: "hooks",
        icon: "cable",
        backend: {
          refreshTarget: "hooks",
          scope: "workspace",
        },
      },
      {
        id: "connections",
        labelKey: "connections",
        icon: "globe",
        backend: {
          refreshTarget: "connections-settings",
          scope: "integration",
        },
      },
      {
        id: "git",
        labelKey: "git",
        icon: "git-branch",
        backend: {
          refreshTarget: "git-settings",
          scope: "source-control",
        },
      },
      {
        id: "environment",
        labelKey: "environment",
        icon: "terminal-square",
        backend: {
          refreshTarget: "environment-settings",
          scope: "runtime",
        },
      },
      {
        id: "worktrees",
        labelKey: "worktrees",
        icon: "app-window",
        backend: {
          refreshTarget: "worktrees-settings",
          scope: "session",
        },
      },
    ],
  },
] as const satisfies readonly SettingsCatalogGroup[];
