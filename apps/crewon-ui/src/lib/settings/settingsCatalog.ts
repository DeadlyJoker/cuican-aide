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
  "model-providers",
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
  | "modelProviders"
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
  mode: "action" | "editable" | "status";
  description: Record<Locale, string>;
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
    modelProviders: "模型接入",
    personal: "个人",
    personalization: "助理人格与记忆",
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
    modelProviders: "Model access",
    personal: "Personal",
    personalization: "Assistant profile & memory",
    search: "Search settings...",
    title: "Settings",
    worktrees: "Worktrees",
  },
};

export function settingsSidebarCopy(locale: Locale): SettingsSidebarCopy {
  return sidebarCopy[locale];
}

export function settingsSectionLabel(
  section: SettingsSection,
  locale: Locale,
): string {
  if (section === "account") {
    return locale === "zh" ? "账号" : "Account";
  }
  const labelKeys: Record<Exclude<SettingsSection, "account">, SettingsCopyKey> = {
    appearance: "appearance",
    "app-snapshots": "appSnapshots",
    browser: "browser",
    "computer-control": "computerControl",
    config: "config",
    connections: "connections",
    environment: "environment",
    git: "git",
    hooks: "hooks",
    keyboard: "keyboard",
    "mcp-servers": "mcpServers",
    "model-providers": "modelProviders",
    personalization: "personalization",
    worktrees: "worktrees",
  };
  return sidebarCopy[locale][labelKeys[section]];
}

const APPEARANCE_CONFIG_FIELDS = [
  {
    fieldId: "appearance-locale",
    configPath: "desktop.uiLocale",
    valueKind: "select",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-theme",
    configPath: "desktop.appearanceTheme",
    valueKind: "select",
    writeActionId: "save-appearance",
  },
] as const satisfies readonly SettingsConfigField[];

export const settingsCatalog = [
  {
    id: "personal",
    labelKey: "personal",
    items: [
      {
        id: "model-providers",
        labelKey: "modelProviders",
        icon: "cable",
        mode: "action",
        description: {
          zh: "接入模型服务：地址、密钥与连通性测试",
          en: "Connect a model service: address, credential, and connectivity test",
        },
        backend: {
          refreshTarget: "model-providers",
          scope: "workspace",
        },
      },
      {
        id: "appearance",
        labelKey: "appearance",
        icon: "palette",
        mode: "editable",
        description: {
          zh: "语言与明暗主题，保存后立即生效",
          en: "Language and theme, applied immediately after saving",
        },
        backend: {
          refreshTarget: "appearance-settings",
          scope: "desktop",
          fields: APPEARANCE_CONFIG_FIELDS,
        },
      },
      {
        id: "account",
        labelKey: "general",
        icon: "shield-check",
        mode: "action",
        description: {
          zh: "企业身份、模型账号与授权状态",
          en: "Enterprise identity, model account, and authorization",
        },
        backend: {
          refreshTarget: "account",
          scope: "account",
        },
      },
    ],
  },
] as const satisfies readonly SettingsCatalogGroup[];

export function settingsCatalogItem(
  section: SettingsSection,
): SettingsCatalogItem | null {
  for (const group of settingsCatalog) {
    const item = group.items.find((candidate) => candidate.id === section);
    if (item) {
      return item;
    }
  }
  return null;
}

export function settingsConfigField(
  fieldId: string,
): SettingsConfigField | null {
  for (const group of settingsCatalog) {
    for (const item of group.items) {
      const fields =
        "fields" in item.backend ? item.backend.fields : undefined;
      const field = fields?.find(
        (candidate) => candidate.fieldId === fieldId,
      );
      if (field) {
        return field;
      }
    }
  }
  return null;
}
