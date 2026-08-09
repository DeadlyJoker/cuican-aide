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
  const item = settingsCatalogItem(section);
  return item
    ? sidebarCopy[locale][item.labelKey]
    : locale === "zh"
      ? "设置"
      : "Settings";
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
          zh: "接入模型服务：地址、密钥与连通性测试",
          en: "Connect a model service: address, credential, and connectivity test",
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
          zh: "默认模型、审批策略与本地权限边界",
          en: "Default model, approval policy, and local permissions",
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
        id: "personalization",
        labelKey: "personalization",
        icon: "sparkles",
        mode: "editable",
        description: {
          zh: "角色、原则与长期记忆行为",
          en: "Role, principles, and long-term memory behavior",
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
          zh: "已连接的 MCP 服务、工具与重载状态",
          en: "Connected MCP services, tools, and reload status",
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
          zh: "当前可用的浏览器应用与授权范围",
          en: "Available browser apps and authorization scope",
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
          zh: "远程控制、设备配对与撤销",
          en: "Remote control, device pairing, and revocation",
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
          zh: "账号、Provider、插件与应用连接总览",
          en: "Account, provider, plugin, and app connection overview",
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
          zh: "沙箱、策略约束与运行时就绪状态",
          en: "Sandbox, policy constraints, and runtime readiness",
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
