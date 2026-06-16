import type { DomainConfigListResponse } from "./appServer";
import type { Locale } from "./i18n";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryAccent,
  LibraryItem,
  OfficeConfig,
  ToolConfig,
} from "./crewonDomain";

type DomainConfigRecord<TConfig> = Pick<
  DomainConfigListResponse<TConfig>["data"][number],
  "filePath" | "savedAt" | "config"
>;

/**
 * Shared glyph/accent vocabulary so real (backend) cards match the demo styling
 * and the runtime vs. draft tool cards look identical to each other.
 */
export const LIBRARY_DECOR = {
  mcp: { glyph: "⌁", accent: "blue" },
  skill: { glyph: "◇", accent: "violet" },
  plugin: { glyph: "◰", accent: "amber" },
} as const satisfies Record<string, { glyph: string; accent: LibraryAccent }>;

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function promptPreview(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  return normalizedText.length > 72
    ? `${normalizedText.slice(0, 69)}...`
    : normalizedText;
}

function automationTriggerLabel(
  locale: Locale,
  trigger: string | undefined,
): string {
  const isZh = locale === "zh";
  switch (trigger) {
    case "schedule":
      return isZh ? "定时" : "scheduled";
    case "event":
      return isZh ? "事件" : "event";
    case "file":
      return isZh ? "文件" : "file";
    default:
      return isZh ? "手动" : "manual";
  }
}

function backendRecordMeta(
  locale: Locale,
  filePath: string,
  savedAt: string | null | undefined,
): string {
  return locale === "zh"
    ? `后端记录 · ${savedAt ? new Date(savedAt).toLocaleString("zh-CN") : pathBaseName(filePath)}`
    : `Backend record · ${savedAt ? new Date(savedAt).toLocaleString("en-US") : pathBaseName(filePath)}`;
}

function sourceOfTruthLabel(locale: Locale, source: "skill-file" | "runtime-mcp" | "workspace-tool-record"): string {
  switch (source) {
    case "runtime-mcp":
      return locale === "zh"
        ? "真实来源：运行态 MCP"
        : "Source of truth: runtime MCP";
    case "workspace-tool-record":
      return locale === "zh"
        ? "真实来源：workspace 工具记录"
        : "Source of truth: workspace tool record";
    case "skill-file":
      return locale === "zh"
        ? "真实来源：Skill 文件"
        : "Source of truth: skill file";
  }
}

function sourcedDescription(
  locale: Locale,
  source: "skill-file" | "runtime-mcp" | "workspace-tool-record",
  description: string,
): string {
  return `${sourceOfTruthLabel(locale, source)} · ${description}`;
}

export function officeConfigRecordsToLibraryItems(
  records: Array<DomainConfigRecord<OfficeConfig>>,
  locale: Locale,
): LibraryItem[] {
  return records.map(({ filePath, savedAt, config }) => ({
    title: config.title,
    meta: backendRecordMeta(locale, filePath, savedAt),
    description:
      config.workspace.goal ||
      (locale === "zh"
        ? "从后端记录恢复的办公室。"
        : "Office restored from a backend record."),
    glyph: "⌘",
    accent: "green",
    badge: { label: locale === "zh" ? "记录" : "record", tone: "planning" },
    tags: [
      `${config.workspace.tasks.length} ${locale === "zh" ? "任务" : "tasks"}`,
      `${config.workspace.members.length} ${locale === "zh" ? "成员" : "members"}`,
    ],
    action: {
      type: "office-detail",
      title: config.title,
      subtitle: config.subtitle,
      body: config.workspace.goal,
      items: [],
      workspace: config.workspace,
      configPath: filePath,
    },
  }));
}

export function agentConfigRecordsToLibraryItems(
  records: Array<DomainConfigRecord<AgentConfig>>,
  locale: Locale,
): LibraryItem[] {
  return records.map(({ filePath, savedAt, config }) => ({
    title: config.name,
    meta: backendRecordMeta(locale, filePath, savedAt),
    description: `${config.role} · ${config.model} · ${config.permission}`,
    glyph: config.glyph,
    accent: config.accent,
    badge: { label: locale === "zh" ? "记录" : "record", tone: "planning" },
    tags: [
      config.model,
      `${config.mcp.length} MCP`,
      `${config.skills.length} ${locale === "zh" ? "技能" : "skills"}`,
    ],
    action: {
      type: "agent-config",
      config,
      configPath: filePath,
    },
  }));
}

export function automationConfigRecordToLibraryItem(
  record: DomainConfigRecord<AutomationConfig>,
  locale: Locale,
  items: LibraryItem[],
): LibraryItem {
  const { filePath, savedAt, config } = record;
  return {
    title: config.title,
    meta: backendRecordMeta(locale, filePath, savedAt),
    description: config.subtitle || promptPreview(config.prompt),
    glyph: "⏱",
    accent: "cyan",
    badge: { label: locale === "zh" ? "记录" : "record", tone: "planning" },
    tags: [automationTriggerLabel(locale, config.trigger?.type)],
    action: {
      type: "automation-detail",
      title: config.title,
      subtitle: config.subtitle,
      body: [
        config.body,
        locale === "zh" ? `后端记录：${filePath}` : `Backend record: ${filePath}`,
      ].join("\n"),
      prompt: config.prompt,
      threadId: config.threadId,
      config,
      configPath: filePath,
      items,
    },
  };
}

export function toolConfigRecordsToLibraryItems(
  records: Array<DomainConfigRecord<ToolConfig>>,
  locale: Locale,
): LibraryItem[] {
  return records.map(({ filePath, savedAt, config }) => {
    const source = sourceOfTruthLabel(locale, "workspace-tool-record");
    const restoredDescription =
      config.description ||
      (config.kind === "mcp" ? config.command : config.path) ||
      (locale === "zh"
        ? "从后端工具记录恢复。"
        : "Restored from a backend tool record.");
    return {
      title: `${config.kind === "mcp" ? "MCP" : "Skill"} · ${config.title}`,
      meta: `${backendRecordMeta(locale, filePath, savedAt)} · ${source}`,
      description: sourcedDescription(
        locale,
        "workspace-tool-record",
        restoredDescription,
      ),
      glyph: config.kind === "mcp" ? LIBRARY_DECOR.mcp.glyph : LIBRARY_DECOR.skill.glyph,
      accent: config.kind === "mcp" ? LIBRARY_DECOR.mcp.accent : LIBRARY_DECOR.skill.accent,
      badge: {
        label: config.kind === "mcp" ? "MCP" : "Skill",
        tone: config.enabled === false ? "warning" : "planning",
      },
      tags: [
        config.kind === "mcp" ? "MCP" : "Skill",
        config.enabled === false
          ? locale === "zh"
            ? "停用"
            : "disabled"
          : locale === "zh"
            ? "启用"
            : "enabled",
      ],
      action:
        config.kind === "mcp"
          ? {
              type: "mcp-detail",
              title: config.title,
              subtitle: config.name,
              body: [
                source,
                config.description,
                config.command
                  ? `${locale === "zh" ? "命令" : "Command"}: ${config.command}`
                  : null,
                config.args?.length
                  ? `${locale === "zh" ? "参数" : "Args"}: ${config.args.join(" ")}`
                  : null,
                locale === "zh"
                  ? `后端记录：${filePath}`
                  : `Backend record: ${filePath}`,
              ]
                .filter(Boolean)
                .join("\n"),
              configPath: filePath,
            }
          : {
              type: "skill-file",
              skillName: config.name,
              path: config.path ?? filePath,
              enabled: config.enabled ?? true,
              configPath: filePath,
            },
    };
  });
}
