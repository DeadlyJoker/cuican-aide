import type { Thread } from "@crewon-protocol/v2/Thread";

import type { NoticeState } from "../shared/noticeState";
import type {
  AgentConfig,
  LibraryItem,
  LibraryItemAction,
  LibraryPanel,
  LibraryPanelAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { agentThreadHistoryItems } from "../thread/threadHistoryItems";

type AgentConfigAction = Extract<LibraryItemAction, { type: "agent-config" }>;

type AgentConfigPanelContent = {
  title: string;
  subtitle: string;
  body: undefined;
  actions?: LibraryPanelAction[];
  items: LibraryItem[];
  agentConfig: AgentConfig;
};

type AgentCreatePanelContent = Pick<
  LibraryPanel,
  "actions" | "agentConfig" | "body" | "error" | "items" | "subtitle" | "title"
>;

type AgentCapabilityCounts = {
  enabledMcp: number;
  enabledSkills: number;
};
type AgentCapabilityGroup = "mcp" | "skills";

export function buildAgentCreateLoadingPanelContent(
  locale: Locale,
): Pick<LibraryPanel, "body" | "error"> {
  return {
    body:
      locale === "zh"
        ? "正在读取模型、权限、MCP 和 Skill..."
        : "Reading models, permissions, MCP, and skills...",
    error: undefined,
  };
}

export function buildAgentCreateLoadingPanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return patchAgentPanel(panel, buildAgentCreateLoadingPanelContent(locale));
}

export function buildAgentCreatePanelContent(params: {
  config: AgentConfig;
  configError: string | undefined;
  configPath: string | null;
  locale: Locale;
}): AgentCreatePanelContent {
  const { config, configError, configPath, locale } = params;
  return {
    title: config.name,
    subtitle: locale === "zh" ? "智能体配置" : "Agent configuration",
    body: configPath
      ? locale === "zh"
        ? `已创建后端智能体记录：${configPath}`
        : `Created backend agent record: ${configPath}`
      : undefined,
    actions: undefined,
    items: [],
    agentConfig: config,
    error: configError,
  };
}

export function buildAgentCreatePanel(
  panel: LibraryPanel | null,
  params: {
    config: AgentConfig;
    configError: string | undefined;
    configPath: string | null;
    locale: Locale;
  },
): LibraryPanel | null {
  return patchAgentPanel(panel, buildAgentCreatePanelContent(params));
}

export function agentCreateCapabilityFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "读取后端智能体能力失败"
    : "Unable to read backend agent capabilities";
}

export function agentCreateRecordFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "创建后端智能体记录失败"
    : "Unable to create backend agent record";
}

export function agentCreateErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return error instanceof Error ? error.message : fallback;
}

export function agentCapabilityCounts(config: AgentConfig): AgentCapabilityCounts {
  return {
    enabledMcp: config.mcp.filter((option) => option.enabled).length,
    enabledSkills: config.skills.filter((option) => option.enabled).length,
  };
}

export function agentSaveThreadGoal(config: AgentConfig, locale: Locale): string {
  return locale === "zh"
    ? `保存智能体「${config.name}」配置，并作为办公室可招募角色使用。`
    : `Persist agent "${config.name}" configuration and make it recruitable by offices.`;
}

export function agentSaveTurnSummary(params: {
  config: AgentConfig;
  configPath: string | null | undefined;
  locale: Locale;
}): string {
  const { config, configPath, locale } = params;
  const enabledMcp = enabledCapabilityNames(config.mcp);
  const enabledSkills = enabledCapabilityNames(config.skills);
  return locale === "zh"
    ? [
        `智能体：${config.name}`,
        `职责：${config.role}`,
        `模型：${config.model}`,
        `权限：${config.permission}`,
        `启用 MCP：${enabledMcp}`,
        `启用 Skill：${enabledSkills}`,
        configPath ? `后端记录：${configPath}` : "后端记录：已提交到 agent/create",
        "",
        config.systemPrompt,
      ].join("\n")
    : [
        `Agent: ${config.name}`,
        `Role: ${config.role}`,
        `Model: ${config.model}`,
        `Permission: ${config.permission}`,
        `Enabled MCP: ${enabledMcp}`,
        `Enabled skills: ${enabledSkills}`,
        configPath
          ? `Backend record: ${configPath}`
          : "Backend record: submitted to agent/create",
        "",
        config.systemPrompt,
      ].join("\n");
}

export function agentConfigWrittenBody(
  configPath: string | null | undefined,
  locale: Locale,
): string | undefined {
  if (!configPath) {
    return undefined;
  }
  return locale === "zh"
    ? `智能体配置已写入：${configPath}`
    : `Agent config written: ${configPath}`;
}

export function agentSaveSuccessNotice(params: {
  config: AgentConfig;
  counts?: AgentCapabilityCounts;
  locale: Locale;
}): string {
  const { config, counts = agentCapabilityCounts(config), locale } = params;
  return locale === "zh"
    ? `已保存「${config.name}」配置 · ${config.model} · ${counts.enabledMcp} MCP · ${counts.enabledSkills} Skill`
    : `Saved "${config.name}" · ${config.model} · ${counts.enabledMcp} MCP · ${counts.enabledSkills} skills`;
}

export function agentSaveSuccessNoticeState(params: {
  config: AgentConfig;
  counts?: AgentCapabilityCounts;
  locale: Locale;
}): NoticeState {
  return {
    text: agentSaveSuccessNotice(params),
    tone: "success",
  };
}

export function agentSaveFallbackError(locale: Locale): string {
  return locale === "zh"
    ? "保存智能体配置失败"
    : "Unable to save agent config";
}

export function agentSaveFailureNoticeState(
  error: unknown,
  locale: Locale,
): NoticeState {
  return {
    text:
      error instanceof Error ? error.message : agentSaveFallbackError(locale),
    tone: "warning",
  };
}

export function buildAgentConfigPanelContent(
  action: AgentConfigAction,
  locale: Locale,
): AgentConfigPanelContent {
  return {
    title: action.config.name,
    subtitle: locale === "zh" ? "智能体配置" : "Agent configuration",
    body: undefined,
    actions: agentConfigActions(action, locale),
    items: agentConfigInitialHistory(action.config, locale),
    agentConfig: action.config,
  };
}

export function agentConfigPanelPatch(
  content: AgentConfigPanelContent,
): Partial<LibraryPanel> {
  return {
    title: content.title,
    subtitle: content.subtitle,
    body: content.body,
    actions: content.actions,
    items: content.items,
    agentConfig: content.agentConfig,
    error: undefined,
  };
}

export function agentConfigPanel(
  panel: LibraryPanel | null,
  content: AgentConfigPanelContent,
): LibraryPanel | null {
  return patchAgentPanel(panel, agentConfigPanelPatch(content));
}

export function agentConfigUpdatedPanel(
  panel: LibraryPanel | null,
  patch: Partial<AgentConfig>,
): LibraryPanel | null {
  return panel?.agentConfig
    ? {
        ...panel,
        title: patch.name ?? panel.title,
        agentConfig: { ...panel.agentConfig, ...patch },
      }
    : panel;
}

export function agentCapabilityToggledPanel(
  panel: LibraryPanel | null,
  group: AgentCapabilityGroup,
  id: string,
): LibraryPanel | null {
  if (!panel?.agentConfig) {
    return panel;
  }
  const nextOptions = panel.agentConfig[group].map((option) =>
    option.id === id ? { ...option, enabled: !option.enabled } : option,
  );
  return {
    ...panel,
    agentConfig: {
      ...panel.agentConfig,
      [group]: nextOptions,
    },
  };
}

export function agentConfigSavedPanel(
  panel: LibraryPanel | null,
  params: {
    agentId: string | null | undefined;
    configPath: string | null | undefined;
    locale: Locale;
    threadId: string;
  },
): LibraryPanel | null {
  const { agentId, configPath, locale, threadId } = params;
  return panel?.agentConfig
    ? {
        ...panel,
        agentConfig: {
          ...panel.agentConfig,
          agentId: agentId ?? undefined,
          threadId,
        },
        body: agentConfigWrittenBody(configPath, locale) ?? panel.body,
      }
    : panel;
}

export function agentConfigHistoryPanel(
  panel: LibraryPanel | null,
  thread: Thread | null,
  locale: Locale,
): LibraryPanel | null {
  return panel?.agentConfig
    ? {
        ...panel,
        items: thread ? agentThreadHistoryItems(thread, locale) : panel.items,
      }
    : panel;
}

export function agentConfigHydratedPatch(params: {
  config: AgentConfig;
  locale: Locale;
  thread?: Thread | null;
}): Partial<LibraryPanel> {
  const { config, locale, thread } = params;
  return {
    title: config.name,
    agentConfig: config,
    items: thread ? agentThreadHistoryItems(thread, locale) : [],
    error: undefined,
  };
}

export function agentConfigHydrateFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取智能体后端记录失败"
          : "Unable to read agent backend records",
  };
}

export function agentConfigHydratedPanel(
  panel: LibraryPanel | null,
  selectedAgentName: string,
  params: {
    config: AgentConfig;
    locale: Locale;
    thread?: Thread | null;
  },
): LibraryPanel | null {
  return patchAgentConfigPanelIfCurrent(
    panel,
    selectedAgentName,
    agentConfigHydratedPatch(params),
  );
}

export function agentConfigHydrateFailurePanel(
  panel: LibraryPanel | null,
  selectedAgentName: string,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchAgentConfigPanelIfCurrent(
    panel,
    selectedAgentName,
    agentConfigHydrateFailurePatch(error, locale),
  );
}

function patchAgentConfigPanelIfCurrent(
  panel: LibraryPanel | null,
  selectedAgentName: string,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel?.agentConfig?.name === selectedAgentName
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function patchAgentPanel(
  panel: LibraryPanel | null,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function agentConfigActions(
  action: AgentConfigAction,
  locale: Locale,
): LibraryPanelAction[] | undefined {
  if (!action.configPath) {
    return undefined;
  }

  return [
    {
      id: "open-path",
      label: locale === "zh" ? "打开后端记录" : "Open backend record",
      pathToOpen: action.configPath,
      pathKind: "file",
    },
    {
      id: "delete-config-file",
      label: locale === "zh" ? "删除后端记录" : "Delete backend record",
      pathToOpen: action.configPath,
      pathKind: "file",
      domainConfigKind: "agent",
      tone: "danger",
    },
  ];
}

function enabledCapabilityNames(
  options: Array<{ enabled?: boolean; name: string }>,
): string {
  return options
    .filter((option) => option.enabled)
    .map((option) => option.name)
    .join(", ");
}

function agentConfigInitialHistory(
  config: AgentConfig,
  locale: Locale,
): LibraryItem[] {
  if (!config.threadId) {
    return [];
  }

  return [
    {
      title: locale === "zh" ? "正在读取后端记录" : "Reading backend records",
      meta: "app-server",
      description:
        locale === "zh"
          ? "正在从智能体线程读取最近配置记录。"
          : "Loading recent configuration records from the agent thread.",
      glyph: "◷",
      accent: "blue",
    },
  ];
}
