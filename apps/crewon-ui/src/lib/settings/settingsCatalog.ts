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
    appSnapshots: "应用记录",
    appearance: "外观",
    back: "返回",
    browser: "网页应用",
    coding: "开发偏好",
    computerControl: "设备协助",
    config: "设置",
    connections: "连接管理",
    environment: "安全与权限",
    general: "常规",
    git: "代码版本",
    hooks: "自动执行",
    integrations: "能力与连接",
    keyboard: "键盘快捷键",
    mcpServers: "工具与服务",
    modelProviders: "AI 模型",
    personal: "个人设置",
    personalization: "助理与记忆",
    search: "搜索",
    title: "设置",
    worktrees: "并行任务",
  },
  en: {
    appSnapshots: "App history",
    appearance: "Appearance",
    back: "Back",
    browser: "Web apps",
    coding: "Developer preferences",
    computerControl: "Device assistance",
    config: "Settings",
    connections: "Connected services",
    environment: "Safety & access",
    general: "General",
    git: "Code versions",
    hooks: "Automatic actions",
    integrations: "Tools & connections",
    keyboard: "Keyboard shortcuts",
    mcpServers: "Tools & services",
    modelProviders: "AI models",
    personal: "Personal settings",
    personalization: "Assistant & memory",
    search: "Search",
    title: "Settings",
    worktrees: "Parallel tasks",
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
  const item = settingsCatalogItem(section);
  return item
    ? sidebarCopy[locale][item.labelKey]
    : locale === "zh"
      ? "设置"
      : "Settings";
}

export function settingsSectionDescription(
  section: SettingsSection,
  locale: Locale,
): string {
  if (section === "account") {
    return locale === "zh"
      ? "管理登录状态、套餐和使用情况"
      : "Manage sign-in, plan, and usage";
  }
  const item = settingsCatalogItem(section);
  return item?.description[locale] ?? "";
}

export function settingsSectionIconKey(
  section: SettingsSection,
): SettingsIconKey {
  return settingsCatalogItem(section)?.icon ?? "sliders-horizontal";
}

/**
 * Appearance writes one flat `desktop.*` key per control. Listing them here is
 * what lets commitSettingsFieldAction persist each field without special cases.
 */
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
  {
    fieldId: "appearance-accent",
    configPath: "desktop.appearanceAccent",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-background",
    configPath: "desktop.appearanceBackground",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-foreground",
    configPath: "desktop.appearanceForeground",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-ui-font",
    configPath: "desktop.uiFontFamily",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-code-font",
    configPath: "desktop.codeFontFamily",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-ui-font-size",
    configPath: "desktop.uiFontSize",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-code-font-size",
    configPath: "desktop.codeFontSize",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-contrast",
    configPath: "desktop.appearanceContrast",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-reduce-motion",
    configPath: "desktop.reduceMotion",
    valueKind: "select",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-diff-markers",
    configPath: "desktop.diffMarkers",
    valueKind: "select",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-translucent-sidebar",
    configPath: "desktop.translucentSidebar",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
  {
    fieldId: "appearance-font-smoothing",
    configPath: "desktop.fontSmoothing",
    valueKind: "string",
    writeActionId: "save-appearance",
  },
] as const satisfies readonly SettingsConfigField[];

export const settingsCatalog = [
  {
    id: "personal",
    labelKey: "personal",
    items: [
      /*
       * Listed before the general page because nothing else in the app works
       * until a provider is reachable, and until now this could only be set up
       * by hand-editing config.toml.
       *
       * `mode: "action"` because the panel manages a list of providers through
       * its own actions rather than mapping one field to one config key, so it
       * has no `fields` binding for commitSettingsFieldAction to drive.
       */
      {
        id: "model-providers",
        labelKey: "modelProviders",
        icon: "cable",
        mode: "action",
        description: {
          zh: "选择任务默认使用的模型",
          en: "Choose the default model for tasks",
        },
        backend: {
          refreshTarget: "model-providers",
          scope: "workspace",
        },
      },
      {
        id: "config",
        labelKey: "general",
        icon: "sliders-horizontal",
        mode: "editable",
        description: {
          zh: "设置默认模型、确认时机和可操作范围",
          en: "Choose the default model, confirmations, and access range",
        },
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
        id: "appearance",
        labelKey: "appearance",
        icon: "palette",
        mode: "editable",
        description: {
          zh: "调整语言、主题和阅读体验",
          en: "Adjust language, theme, and reading comfort",
        },
        backend: {
          refreshTarget: "appearance-settings",
          scope: "desktop",
          fields: APPEARANCE_CONFIG_FIELDS,
        },
      },
      {
        id: "personalization",
        labelKey: "personalization",
        icon: "sparkles",
        mode: "editable",
        description: {
          zh: "定义助理的表达方式和记忆偏好",
          en: "Shape how the assistant responds and remembers",
        },
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
            {
              fieldId: "personalization-memory-mode",
              configPath: "features.memories",
              valueKind: "select",
              writeActionId: "save-personalization",
            },
          ],
        },
      },
      {
        id: "account",
        labelKey: "general",
        icon: "shield-check",
        mode: "action",
        description: {
          zh: "管理登录状态、套餐和使用情况",
          en: "Manage sign-in, plan, and usage",
        },
        backend: {
          refreshTarget: "account",
          scope: "account",
        },
      },
    ],
  },
  {
    id: "integrations",
    labelKey: "integrations",
    items: [
      {
        id: "mcp-servers",
        labelKey: "mcpServers",
        icon: "bot",
        mode: "action",
        description: {
          zh: "管理助理可以调用的工具和服务",
          en: "Manage tools and services available to the assistant",
        },
        backend: {
          refreshTarget: "mcp-settings",
          scope: "integration",
        },
      },
      {
        id: "browser",
        labelKey: "browser",
        icon: "globe",
        mode: "status",
        description: {
          zh: "查看助理可以使用的网页应用",
          en: "Review web apps available to the assistant",
        },
        backend: {
          refreshTarget: "browser-settings",
          scope: "integration",
        },
      },
      {
        id: "computer-control",
        labelKey: "computerControl",
        icon: "terminal-square",
        mode: "action",
        description: {
          zh: "管理可由助理协助操作的设备",
          en: "Manage devices the assistant can help operate",
        },
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
      {
        id: "connections",
        labelKey: "connections",
        icon: "globe",
        mode: "status",
        description: {
          zh: "查看账号、模型和应用的连接状态",
          en: "Review account, model, and app connections",
        },
        backend: {
          refreshTarget: "connections-settings",
          scope: "integration",
        },
      },
      {
        id: "environment",
        labelKey: "environment",
        icon: "terminal-square",
        mode: "status",
        description: {
          zh: "查看任务权限和设备保护状态",
          en: "Review task access and device protection",
        },
        backend: {
          refreshTarget: "environment-settings",
          scope: "runtime",
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
      const fields = "fields" in item.backend ? item.backend.fields : undefined;
      const field = fields?.find((candidate) => candidate.fieldId === fieldId);
      if (field) {
        return field;
      }
    }
  }
  return null;
}
