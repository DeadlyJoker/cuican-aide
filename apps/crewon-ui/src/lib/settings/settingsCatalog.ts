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
    mcpServers: "工具与扩展",
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
    mcpServers: "Tools & extensions",
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
    return locale === "zh" ? "查看当前登录账号" : "View your signed-in account";
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
          zh: "任务模型与模型服务",
          en: "Task models and model services",
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
          zh: "使用环境与任务偏好",
          en: "Environment and task preferences",
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
        id: "keyboard",
        labelKey: "keyboard",
        icon: "keyboard",
        mode: "status",
        description: {
          zh: "用快捷键更快地完成常用操作",
          en: "Get common tasks done faster with shortcuts",
        },
        backend: { refreshTarget: "keyboard-settings", scope: "desktop" },
      },
      {
        id: "account",
        labelKey: "general",
        icon: "shield-check",
        mode: "action",
        description: {
          zh: "查看当前登录账号",
          en: "View your signed-in account",
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
          zh: "设置常用任务的输出偏好",
          en: "Set output preferences for common tasks",
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
          zh: "在任务中查看和使用网页",
          en: "View and use web pages in your tasks",
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
          zh: "使用本地文件与终端",
          en: "Use local files and terminals",
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
          zh: "了解任务可以执行哪些操作",
          en: "Understand what your tasks can do",
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
