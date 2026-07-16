import type { DomainConfigListResponse } from "../app-server/appServer";
import { isLegacyGeneratedAgentPlaceholder } from "../agent-config/legacyAgentPlaceholder";
import type { Locale } from "../i18n";
import { isLegacyGeneratedOfficePlaceholder } from "../office/legacyOfficePlaceholder";
import {
  MCP_GLYPHS,
  PLUGIN_GLYPHS,
  SKILL_GLYPHS,
  capabilityAccents,
} from "../agent-config/agentConfigDefaults";
import type {
  AgentConfig,
  AutomationConfig,
  LibraryAccent,
  LibraryItem,
  OfficeConfig,
  ToolConfig,
} from "./crewonDomain";
import { pathBaseName } from "../shared/pathUtils";
import { promptPreview } from "../shared/text";

type DomainConfigRecord<TConfig> = Pick<
  DomainConfigListResponse<TConfig>["data"][number],
  "filePath" | "savedAt" | "config"
>;

/**
 * Rotating glyph/accent vocabulary so real (backend) tool cards get the same
 * varied, colorful treatment as the demo data (which curates one per item),
 * instead of every card sharing a single fixed glyph/accent.
 */
export function libraryToolDecor(
  kind: "mcp" | "skill" | "plugin",
  index: number,
): { glyph: string; accent: LibraryAccent } {
  const accents = capabilityAccents();
  const glyphs =
    kind === "mcp"
      ? MCP_GLYPHS
      : kind === "skill"
        ? SKILL_GLYPHS
        : PLUGIN_GLYPHS;
  return {
    glyph: glyphs[index % glyphs.length],
    accent: accents[index % accents.length],
  };
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

function savedItemMeta(
  locale: Locale,
  savedAt: string | null | undefined,
): string {
  if (!savedAt) {
    return locale === "zh" ? "已保存" : "Saved";
  }
  return locale === "zh"
    ? `已保存 · ${new Date(savedAt).toLocaleString("zh-CN")}`
    : `Saved · ${new Date(savedAt).toLocaleString("en-US")}`;
}

function sourceOfTruthLabel(
  locale: Locale,
  source: "skill-file" | "runtime-mcp" | "workspace-tool-record",
): string {
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

export function officeConfigRecordsToLibraryItems(
  records: Array<DomainConfigRecord<OfficeConfig>>,
  locale: Locale,
): LibraryItem[] {
  return records
    .filter(({ config }) => !isLegacyGeneratedOfficePlaceholder(config))
    .map(({ filePath, savedAt, config }) => ({
      title: config.title,
      meta: savedItemMeta(locale, savedAt),
      description:
        config.workspace.goal ||
        (locale === "zh"
          ? "已保存的办公室。"
          : "Saved office."),
      glyph: "⌘",
      accent: "green",
      badge: { label: locale === "zh" ? "办公室" : "office", tone: "planning" },
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
  return records
    .filter(({ config }) => !isLegacyGeneratedAgentPlaceholder(config))
    .map(({ filePath, savedAt, config }) => ({
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
        locale === "zh"
          ? `后端记录：${filePath}`
          : `Backend record: ${filePath}`,
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
  return records.map(({ filePath, savedAt, config }, index) => {
    const restoredDescription =
      config.description ||
      (config.kind === "mcp" ? config.command : config.path) ||
      (locale === "zh"
        ? "从后端工具记录恢复。"
        : "Restored from a backend tool record.");
    const decor = libraryToolDecor(
      config.kind === "mcp" ? "mcp" : "skill",
      index,
    );
    return {
      title: config.title,
      meta: `${config.kind === "mcp" ? "MCP" : "Skill"} · ${backendRecordMeta(locale, filePath, savedAt)}`,
      description: restoredDescription,
      glyph: decor.glyph,
      accent: decor.accent,
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
                sourceOfTruthLabel(locale, "workspace-tool-record"),
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
