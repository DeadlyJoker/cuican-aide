import type { JsonValue } from "@crewon-protocol/serde_json/JsonValue";
import type { McpServerConfigRecord } from "@crewon-protocol/v2/McpServerConfigRecord";
import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";
import type { SkillMetadata } from "@crewon-protocol/v2/SkillMetadata";

import type { Locale } from "./i18n";
import type {
  AgentCapabilityOption,
  AgentConfig,
  LibraryAccent,
  OfficeMember,
} from "./crewonDomain";

const CAPABILITY_ACCENTS: LibraryAccent[] = [
  "blue",
  "cyan",
  "green",
  "amber",
  "violet",
  "rose",
  "slate",
];
export const MCP_GLYPHS = ["⌁", "◎", "⌘", "◈", "◇"];
export const SKILL_GLYPHS = ["✓", "✦", "⌗", "◌", "◇"];
export const PLUGIN_GLYPHS = ["◰", "⬡", "❖", "▣", "◆"];

function mcpConfigObject(record: McpServerConfigRecord): Record<string, JsonValue> {
  return record.config && typeof record.config === "object" && !Array.isArray(record.config)
    ? (record.config as Record<string, JsonValue>)
    : {};
}

function mcpConfigEnabled(record: McpServerConfigRecord): boolean {
  const config = mcpConfigObject(record);
  return config.enabled !== false;
}

function mcpConfigEndpoint(record: McpServerConfigRecord): string {
  const config = mcpConfigObject(record);
  const command = typeof config.command === "string" ? config.command : "";
  const url = typeof config.url === "string" ? config.url : "";
  return command || url;
}

export function capabilityAccents(): LibraryAccent[] {
  return CAPABILITY_ACCENTS;
}

export function createDefaultAgentConfig(locale: Locale): AgentConfig {
  const permissions =
    locale === "zh"
      ? ["只读", "工作区写入", "完全访问"]
      : ["read-only", "workspace-write", "full-access"];
  return {
    name: locale === "zh" ? "新智能体" : "New Agent",
    glyph: "✦",
    accent: "cyan",
    role:
      locale === "zh"
        ? "自定义执行角色 · 可招募"
        : "Custom execution role · recruitable",
    model: "gpt-5-codex",
    models: ["gpt-5-codex", "gpt-5", "o4-mini", "claude-opus-4.8"],
    permission: permissions[1],
    permissions,
    systemPrompt:
      locale === "zh"
        ? "你是办公室中的自定义智能体。先理解目标，再列出计划，必要时调用已授权工具，并把结果沉淀为可复用交付物。"
        : "You are a custom agent in an office. Understand the goal, outline a plan, use authorized tools when needed, and turn results into reusable deliverables.",
    mcp: [
      {
        id: "filesystem",
        name: locale === "zh" ? "文件系统" : "Filesystem",
        glyph: "⌁",
        accent: "blue",
        description:
          locale === "zh"
            ? "读取和整理工作区文件"
            : "Read and organize workspace files",
        enabled: true,
      },
      {
        id: "browser",
        name: locale === "zh" ? "浏览器" : "Browser",
        glyph: "◎",
        accent: "amber",
        description:
          locale === "zh"
            ? "打开网页、抓取页面和截图"
            : "Open pages, inspect content, and capture screenshots",
        enabled: false,
      },
    ],
    skills: [
      {
        id: "review",
        name: locale === "zh" ? "代码审查" : "Code review",
        glyph: "✓",
        accent: "green",
        description:
          locale === "zh"
            ? "检查风险、缺陷和测试缺口"
            : "Check risks, defects, and test gaps",
        enabled: true,
      },
      {
        id: "workspace-brief",
        name: locale === "zh" ? "工作区简报" : "Workspace brief",
        glyph: "◈",
        accent: "rose",
        description:
          locale === "zh"
            ? "整理工作区证据、材料和截图"
            : "Prepare workspace evidence, material, and screenshots",
        enabled: false,
      },
    ],
  };
}

export function createMcpAgentOption(
  server: McpServerStatus,
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  const toolCount = Object.keys(server.tools).length;
  const resourceCount = server.resources.length + server.resourceTemplates.length;
  const serverTitle =
    server.serverInfo?.title || server.serverInfo?.name || server.name;
  const authLabel =
    server.authStatus === "notLoggedIn"
      ? locale === "zh"
        ? "未登录"
        : "not logged in"
      : server.authStatus === "unsupported"
        ? locale === "zh"
          ? "无需授权"
          : "no auth"
        : locale === "zh"
          ? "已授权"
          : "authorized";

  return {
    id: server.name,
    name: serverTitle,
    glyph: MCP_GLYPHS[index % MCP_GLYPHS.length],
    accent: CAPABILITY_ACCENTS[index % CAPABILITY_ACCENTS.length],
    description:
      locale === "zh"
        ? `真实来源：运行态 MCP · ${authLabel} · ${toolCount} 个工具 · ${resourceCount} 个资源`
        : `Source of truth: runtime MCP · ${authLabel} · ${toolCount} tools · ${resourceCount} resources`,
    enabled: server.authStatus !== "notLoggedIn" && toolCount > 0,
  };
}

export function createMcpConfigAgentOption(
  record: McpServerConfigRecord,
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  const endpoint = mcpConfigEndpoint(record);
  return {
    id: record.name,
    name: record.name,
    glyph: MCP_GLYPHS[index % MCP_GLYPHS.length],
    accent: CAPABILITY_ACCENTS[index % CAPABILITY_ACCENTS.length],
    description:
      locale === "zh"
        ? `真实来源：MCP 配置记录 · ${mcpConfigEnabled(record) ? "已配置" : "配置停用"} · 等待运行态加载${endpoint ? ` · ${endpoint}` : ""}`
        : `Source of truth: MCP config record · ${mcpConfigEnabled(record) ? "configured" : "config disabled"} · waiting to load${endpoint ? ` · ${endpoint}` : ""}`,
    enabled: mcpConfigEnabled(record),
  };
}

export function createMcpInventoryAgentOption(
  server: {
    config?: McpServerConfigRecord;
    name: string;
    status?: McpServerStatus;
  },
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  if (server.status) {
    const option = createMcpAgentOption(server.status, locale, index);
    if (!server.config) {
      return option;
    }
    return {
      ...option,
      description: `${option.description} · ${
        mcpConfigEnabled(server.config)
          ? locale === "zh"
            ? "已配置"
            : "configured"
          : locale === "zh"
            ? "配置停用"
            : "config disabled"
      }`,
      enabled: option.enabled && mcpConfigEnabled(server.config),
    };
  }

  return server.config
    ? createMcpConfigAgentOption(server.config, locale, index)
    : {
        id: server.name,
        name: server.name,
        glyph: MCP_GLYPHS[index % MCP_GLYPHS.length],
        accent: CAPABILITY_ACCENTS[index % CAPABILITY_ACCENTS.length],
        description:
          locale === "zh"
            ? "真实来源：MCP 清单占位 · 等待加载"
            : "Source of truth: MCP inventory placeholder · waiting to load",
        enabled: false,
      };
}

export function createSkillAgentOption(
  skill: SkillMetadata,
  locale: Locale,
  index: number,
): AgentCapabilityOption {
  let scopeLabel: string;
  switch (skill.scope) {
    case "repo":
      scopeLabel = locale === "zh" ? "项目" : "repo";
      break;
    case "user":
      scopeLabel = locale === "zh" ? "个人" : "user";
      break;
    case "system":
      scopeLabel = locale === "zh" ? "系统" : "system";
      break;
    case "admin":
      scopeLabel = locale === "zh" ? "管理" : "admin";
      break;
  }
  const sourceLabel =
    locale === "zh" ? "真实来源：Skill 文件" : "Source of truth: skill file";
  const skillDescription =
    skill.shortDescription ||
    skill.description ||
    (locale === "zh" ? `${scopeLabel} Skill` : `${scopeLabel} skill`);
  return {
    id: skill.path,
    name: skill.name,
    glyph: SKILL_GLYPHS[index % SKILL_GLYPHS.length],
    accent: CAPABILITY_ACCENTS[(index + 2) % CAPABILITY_ACCENTS.length],
    description: `${sourceLabel} · ${skillDescription}`,
    enabled: skill.enabled && index < 8,
  };
}

export function agentConfigToOfficeMember(
  config: AgentConfig,
  locale: Locale,
): OfficeMember {
  return {
    agentId: config.agentId,
    name: config.name,
    role: config.role,
    glyph: config.glyph,
    accent: config.accent,
    status: locale === "zh" ? "已从智能体库招募" : "Recruited from agents",
    online: true,
  };
}
