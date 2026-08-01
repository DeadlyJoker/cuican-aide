import type { ConfigReadResponse } from "@crewon-protocol/v2/ConfigReadResponse";
import type { ConfigRequirementsReadResponse } from "@crewon-protocol/v2/ConfigRequirementsReadResponse";
import type { ModelListResponse } from "@crewon-protocol/v2/ModelListResponse";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";

export function configSummaryText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  if (!configRead) {
    return "";
  }

  const { config } = configRead;
  const approvalPolicy =
    typeof config.approval_policy === "string"
      ? config.approval_policy
      : config.approval_policy
        ? locale === "zh"
          ? "细粒度"
          : "granular"
        : null;
  const enabledTools = [
    config.tools?.web_search
      ? locale === "zh"
        ? "网页搜索"
        : "web search"
      : null,
  ].filter(Boolean);
  const lines = [
    locale === "zh" ? "配置" : "Config",
    config.model
      ? `${locale === "zh" ? "模型" : "Model"}: ${config.model}`
      : null,
    config.model_provider ? `Provider: ${config.model_provider}` : null,
    approvalPolicy
      ? `${locale === "zh" ? "审批" : "Approval"}: ${approvalPolicy}`
      : null,
    config.sandbox_mode
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${config.sandbox_mode}`
      : null,
    config.web_search
      ? `${locale === "zh" ? "网页搜索" : "Web search"}: ${config.web_search}`
      : null,
    enabledTools.length > 0
      ? `${locale === "zh" ? "工具" : "Tools"}: ${enabledTools.join(", ")}`
      : null,
    `${locale === "zh" ? "配置层" : "Layers"}: ${configRead.layers?.length ?? 0}`,
    `${locale === "zh" ? "来源项" : "Origins"}: ${Object.keys(configRead.origins).length}`,
  ];

  return lines.filter(Boolean).join("\n");
}

export function configRequirementsText(
  configRequirements: ConfigRequirementsReadResponse | null,
  locale: Locale,
): string {
  const requirements = configRequirements?.requirements;

  if (!requirements) {
    return locale === "zh" ? "配置约束: 无" : "Config requirements: none";
  }

  const enabledFeatureRequirements = Object.entries(
    requirements.featureRequirements ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const permissionProfiles = Object.entries(
    requirements.allowedPermissionProfiles ?? {},
  )
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const lines = [
    locale === "zh" ? "配置约束" : "Config requirements",
    requirements.allowedApprovalPolicies
      ? `${locale === "zh" ? "审批策略" : "Approval policies"}: ${requirements.allowedApprovalPolicies
          .map((policy) =>
            typeof policy === "string"
              ? policy
              : locale === "zh"
                ? "细粒度"
                : "granular",
          )
          .join(", ")}`
      : null,
    requirements.allowedSandboxModes
      ? `${locale === "zh" ? "沙箱" : "Sandbox"}: ${requirements.allowedSandboxModes.join(", ")}`
      : null,
    requirements.allowedWebSearchModes
      ? `${locale === "zh" ? "网页搜索" : "Web search"}: ${requirements.allowedWebSearchModes.join(", ")}`
      : null,
    permissionProfiles.length > 0
      ? `${locale === "zh" ? "权限档案" : "Permission profiles"}: ${permissionProfiles.join(", ")}`
      : null,
    requirements.defaultPermissions
      ? `${locale === "zh" ? "默认权限" : "Default permissions"}: ${requirements.defaultPermissions}`
      : null,
    requirements.allowManagedHooksOnly !== null
      ? `${locale === "zh" ? "仅托管 Hooks" : "Managed hooks only"}: ${requirements.allowManagedHooksOnly ? "yes" : "no"}`
      : null,
    requirements.allowAppshots !== null
      ? `Appshots: ${requirements.allowAppshots ? "yes" : "no"}`
      : null,
    requirements.computerUse?.allowLockedComputerUse !== null &&
    requirements.computerUse?.allowLockedComputerUse !== undefined
      ? `${locale === "zh" ? "锁屏电脑控制" : "Locked computer use"}: ${requirements.computerUse.allowLockedComputerUse ? "yes" : "no"}`
      : null,
    requirements.enforceResidency
      ? `${locale === "zh" ? "数据驻留" : "Residency"}: ${requirements.enforceResidency}`
      : null,
    enabledFeatureRequirements.length > 0
      ? `${locale === "zh" ? "特性要求" : "Feature requirements"}: ${enabledFeatureRequirements.join(", ")}`
      : null,
  ];

  return lines.filter(Boolean).join("\n");
}

export function configDesktopValue(
  configRead: ConfigReadResponse | null,
  key: string,
): string {
  const value = configRead?.config.desktop?.[key];
  return typeof value === "string" ? value : "";
}

function configTitle(locale: Locale): string {
  return locale === "zh" ? "配置" : "Config";
}

function configScopedSubtitle(cwd: string | null, locale: Locale): string {
  return cwd || (locale === "zh" ? "全局配置" : "Global config");
}

export function configDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: configTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function configLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: configTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: locale === "zh" ? "正在读取配置..." : "Reading config...",
  };
}

type FieldOption = NonNullable<
  NonNullable<CapabilityPanel["fields"]>[number]["options"]
>[number];

function uniqueFieldOptions(options: FieldOption[]): FieldOption[] {
  return options.filter(
    (option, index, allOptions) =>
      option.value &&
      allOptions.findIndex((candidate) => candidate.value === option.value) ===
        index,
  );
}

export function configPanel(params: {
  configRead: ConfigReadResponse | null;
  configRequirements: ConfigRequirementsReadResponse | null;
  cwd: string | null;
  errors: string[];
  locale: Locale;
  models: ModelListResponse | null;
}): CapabilityPanel {
  const { configRead, configRequirements, cwd, errors, locale, models } =
    params;
  const currentModel = configRead?.config.model ?? "";
  const currentApprovalPolicy =
    typeof configRead?.config.approval_policy === "string"
      ? configRead.config.approval_policy
      : "";
  const currentSandboxMode = configRead?.config.sandbox_mode ?? "";
  const modelOptions = uniqueFieldOptions([
    ...(currentModel ? [{ label: currentModel, value: currentModel }] : []),
    ...(models?.data ?? []).map((model) => ({
      label: model.displayName || model.model || model.id,
      value: model.model,
    })),
  ]);
  const approvalOptions = uniqueFieldOptions([
    ...(currentApprovalPolicy
      ? [{ label: currentApprovalPolicy, value: currentApprovalPolicy }]
      : []),
    ...(
      configRequirements?.requirements?.allowedApprovalPolicies ?? [
        "untrusted",
        "on-failure",
        "on-request",
        "never",
      ]
    )
      .flatMap((policy) => (typeof policy === "string" ? [policy] : []))
      .map((policy) => ({ label: policy, value: policy })),
  ]);
  const sandboxOptions = uniqueFieldOptions([
    ...(currentSandboxMode
      ? [{ label: currentSandboxMode, value: currentSandboxMode }]
      : []),
    ...(
      configRequirements?.requirements?.allowedSandboxModes ?? [
        "read-only",
        "workspace-write",
        "danger-full-access",
      ]
    ).map((mode) => ({ label: mode, value: mode })),
  ]);

  return {
    title: configTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: [
      configSummaryText(configRead, locale) ||
        (locale === "zh" ? "未读取到配置" : "No config returned"),
      configRequirementsText(configRequirements, locale),
      errors.length > 0
        ? `${locale === "zh" ? "部分配置读取失败" : "Some config reads failed"}\n${errors.join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    fields: [
      {
        commitOnChange: true,
        id: "config-model",
        label: locale === "zh" ? "默认模型" : "Default model",
        placeholder: "gpt-5-codex",
        value: currentModel || modelOptions[0]?.value || "",
        options: modelOptions,
      },
      {
        commitOnChange: true,
        id: "config-approval-policy",
        label: locale === "zh" ? "审批策略" : "Approval policy",
        placeholder: "on-request",
        value: currentApprovalPolicy || approvalOptions[0]?.value || "",
        options: approvalOptions,
      },
      {
        commitOnChange: true,
        id: "config-sandbox-mode",
        label: locale === "zh" ? "沙箱模式" : "Sandbox mode",
        placeholder: "workspace-write",
        value: currentSandboxMode || sandboxOptions[0]?.value || "",
        options: sandboxOptions,
      },
    ],
  };
}

export function configErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: configTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取配置失败"
          : "Unable to read config",
  };
}

export function appearanceSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const configuredLocale = configDesktopValue(configRead, "uiLocale");
  const configuredTheme = configDesktopValue(configRead, "appearanceTheme");
  return [
    locale === "zh" ? "外观" : "Appearance",
    `${locale === "zh" ? "语言" : "Language"}: ${
      configuredLocale ||
      (locale === "zh" ? "跟随当前界面" : "follow current UI")
    }`,
    `${locale === "zh" ? "主题" : "Theme"}: ${
      configuredTheme ||
      (locale === "zh" ? "跟随系统/当前界面" : "system/current")
    }`,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "外观设置会写入桌面端配置，并立即应用到当前界面。"
      : "Appearance settings are written to desktop config and applied immediately.",
  ].join("\n");
}

type AppearanceTheme = "dark" | "light";

function appearanceTitle(locale: Locale): string {
  return locale === "zh" ? "外观" : "Appearance";
}

export function appearanceDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: appearanceTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function appearanceLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: appearanceTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body:
      locale === "zh" ? "正在读取外观设置..." : "Reading appearance settings...",
  };
}

export function appearancePanel(params: {
  configRead: ConfigReadResponse | null;
  currentLocale: Locale;
  currentTheme: AppearanceTheme;
  cwd: string | null;
  locale: Locale;
}): CapabilityPanel {
  const { configRead, currentLocale, currentTheme, cwd, locale } = params;
  const configuredLocale =
    configDesktopValue(configRead, "uiLocale") || currentLocale;
  const configuredTheme =
    configDesktopValue(configRead, "appearanceTheme") || currentTheme;

  return {
    title: appearanceTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: appearanceSettingsText(configRead, locale),
    fields: [
      {
        commitOnChange: true,
        id: "appearance-locale",
        label: locale === "zh" ? "语言" : "Language",
        value: configuredLocale,
        options: [
          { label: "中文", value: "zh" },
          { label: "English", value: "en" },
        ],
      },
      {
        commitOnChange: true,
        id: "appearance-theme",
        label: locale === "zh" ? "主题" : "Theme",
        value: configuredTheme,
        options: [
          { label: locale === "zh" ? "深色" : "Dark", value: "dark" },
          { label: locale === "zh" ? "浅色" : "Light", value: "light" },
        ],
      },
    ],
  };
}

export function appearanceErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: appearanceTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取外观设置失败"
          : "Unable to read appearance settings",
  };
}

export function personalizationSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const instructions = configRead?.config.instructions?.trim() ?? "";
  const developerInstructions =
    configRead?.config.developer_instructions?.trim() ?? "";
  const memoryMode = personalizationMemoryMode(configRead);
  const memoryModeLabel = personalizationMemoryModeOptions(locale).find(
    (option) => option.value === memoryMode,
  )?.label;
  return [
    locale === "zh" ? "助理人格与记忆" : "Assistant profile & memory",
    `${locale === "zh" ? "角色定位" : "Role"}: ${
      instructions
        ? locale === "zh"
          ? "已配置"
          : "configured"
        : locale === "zh"
          ? "未配置"
          : "not configured"
    }`,
    `${locale === "zh" ? "灵魂与原则" : "Soul & principles"}: ${
      developerInstructions
        ? locale === "zh"
          ? "已配置"
          : "configured"
        : locale === "zh"
          ? "未配置"
          : "not configured"
    }`,
    `${locale === "zh" ? "长期记忆" : "Long-term memory"}: ${memoryModeLabel}`,
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "保存后由 app-server 热重载。角色和灵魂影响新会话；长期记忆会在对话空闲后异步沉淀，并按相关性有限检索。"
      : "The app-server hot-reloads these settings. Role and soul affect new sessions; long-term memory is consolidated asynchronously after conversations become idle and retrieved with bounded relevance.",
  ].join("\n");
}

type PersonalizationMemoryMode = "learn-only" | "off" | "on" | "read-only";

function configNestedBoolean(
  configRead: ConfigReadResponse | null,
  tableName: string,
  key: string,
  fallback: boolean,
): boolean {
  const table = configRead?.config[tableName];
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return fallback;
  }
  const value = table[key];
  return typeof value === "boolean" ? value : fallback;
}

function personalizationMemoryMode(
  configRead: ConfigReadResponse | null,
): PersonalizationMemoryMode {
  const featureEnabled = configNestedBoolean(
    configRead,
    "features",
    "memories",
    false,
  );
  if (!featureEnabled) {
    return "off";
  }

  const generateMemories = configNestedBoolean(
    configRead,
    "memories",
    "generate_memories",
    true,
  );
  const useMemories = configNestedBoolean(
    configRead,
    "memories",
    "use_memories",
    true,
  );
  if (generateMemories && useMemories) {
    return "on";
  }
  if (generateMemories) {
    return "learn-only";
  }
  if (useMemories) {
    return "read-only";
  }
  return "off";
}

function personalizationMemoryModeOptions(locale: Locale) {
  return locale === "zh"
    ? [
        { label: "生成并使用（推荐）", value: "on" },
        { label: "仅使用已有记忆", value: "read-only" },
        { label: "仅沉淀，不主动引用", value: "learn-only" },
        { label: "关闭长期记忆", value: "off" },
      ]
    : [
        { label: "Learn and use (recommended)", value: "on" },
        { label: "Use existing memories only", value: "read-only" },
        { label: "Learn without retrieval", value: "learn-only" },
        { label: "Turn off long-term memory", value: "off" },
      ];
}

function personalizationTitle(locale: Locale): string {
  return locale === "zh" ? "助理人格与记忆" : "Assistant profile & memory";
}

export function personalizationDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: personalizationTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function personalizationLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: personalizationTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body:
      locale === "zh"
        ? "正在读取助理人格与记忆设置..."
        : "Reading assistant profile and memory settings...",
  };
}

export function personalizationPanel(params: {
  configRead: ConfigReadResponse | null;
  cwd: string | null;
  locale: Locale;
}): CapabilityPanel {
  const { configRead, cwd, locale } = params;
  return {
    title: personalizationTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: personalizationSettingsText(configRead, locale),
    fields: [
      {
        id: "personalization-instructions",
        label: locale === "zh" ? "角色定位" : "Role",
        description:
          locale === "zh"
            ? "定义助理是谁、负责什么、以什么视角工作。保存为系统指令。"
            : "Define who the assistant is, what it owns, and the perspective it works from. Saved as system instructions.",
        multiline: true,
        placeholder:
          locale === "zh"
            ? "例如：你是我的产品与工程助理，负责把模糊想法推进为可验证的交付。"
            : "Example: You are my product and engineering assistant, turning ambiguous ideas into verified deliverables.",
        rows: 6,
        value: configRead?.config.instructions ?? "",
      },
      {
        id: "personalization-developer-instructions",
        label: locale === "zh" ? "灵魂与原则" : "Soul & principles",
        description:
          locale === "zh"
            ? "定义价值取向、表达方式、边界和长期行为原则。保存为开发者指令。"
            : "Define values, voice, boundaries, and durable behavior principles. Saved as developer instructions.",
        multiline: true,
        placeholder:
          locale === "zh"
            ? "例如：诚实标注未验证边界；主动推进，但不越过权限；优先使用真实证据。"
            : "Example: Mark unverified boundaries honestly, move work forward without crossing authority, and prefer real evidence.",
        rows: 7,
        value: configRead?.config.developer_instructions ?? "",
      },
      {
        id: "personalization-memory-mode",
        label: locale === "zh" ? "长期记忆" : "Long-term memory",
        description:
          locale === "zh"
            ? "控制是否从对话形成长期记忆，以及是否在新任务中检索已有记忆。"
            : "Control whether conversations form long-term memories and whether existing memories are retrieved in new tasks.",
        value: personalizationMemoryMode(configRead),
        options: personalizationMemoryModeOptions(locale),
      },
    ],
    actions: [
      {
        id: "save-personalization",
        label: locale === "zh" ? "保存助理设置" : "Save assistant settings",
        tone: "primary",
      },
      {
        id: "refresh-personalization",
        label: locale === "zh" ? "刷新助理设置" : "Refresh assistant settings",
      },
    ],
  };
}

export function personalizationErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: personalizationTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取助理人格与记忆设置失败"
          : "Unable to read assistant profile and memory settings",
  };
}

export function keyboardSettingsText(
  configRead: ConfigReadResponse | null,
  locale: Locale,
): string {
  const shortcuts =
    locale === "zh"
      ? [
          "新对话: ⌘N / Ctrl N",
          "搜索: ⌘K / Ctrl K",
          "发送: ⌘ Enter / Ctrl Enter",
          "审查: ⌃⇧G",
          "浏览器: ⌘T",
          "文件: ⌘P",
          "侧边聊天: ⌥⌘S",
        ]
      : [
          "New chat: ⌘N / Ctrl N",
          "Search: ⌘K / Ctrl K",
          "Send: ⌘ Enter / Ctrl Enter",
          "Review: ⌃⇧G",
          "Browser: ⌘T",
          "Files: ⌘P",
          "Side chat: ⌥⌘S",
        ];
  return [
    locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts",
    shortcuts.map((shortcut) => `- ${shortcut}`).join("\n"),
    `${locale === "zh" ? "配置层" : "Config layers"}: ${configRead?.layers?.length ?? 0}`,
    locale === "zh"
      ? "当前 app-server 协议尚未暴露快捷键写入 API；此页读取配置状态并展示当前桌面端绑定。"
      : "The current app-server protocol does not expose shortcut-write APIs yet. This page reads config state and shows the active desktop bindings.",
  ].join("\n");
}

function keyboardTitle(locale: Locale): string {
  return locale === "zh" ? "键盘快捷键" : "Keyboard shortcuts";
}

export function keyboardDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: keyboardTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function keyboardLoadingPanel(
  cwd: string | null,
  locale: Locale,
): CapabilityPanel {
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: locale === "zh" ? "正在读取快捷键..." : "Reading shortcuts...",
  };
}

export function keyboardPanel(params: {
  configRead: ConfigReadResponse | null;
  cwd: string | null;
  locale: Locale;
}): CapabilityPanel {
  const { configRead, cwd, locale } = params;
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    body: keyboardSettingsText(configRead, locale),
    actions: [
      {
        id: "refresh-keyboard",
        label: locale === "zh" ? "刷新快捷键" : "Refresh shortcuts",
      },
    ],
  };
}

export function keyboardErrorPanel(params: {
  cwd: string | null;
  error: unknown;
  locale: Locale;
}): CapabilityPanel {
  const { cwd, error, locale } = params;
  return {
    title: keyboardTitle(locale),
    subtitle: configScopedSubtitle(cwd, locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取快捷键失败"
          : "Unable to read shortcuts",
  };
}
