import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";
import type { SkillsListResponse } from "@crewon-protocol/v2/SkillsListResponse";

import type { Locale } from "./i18n";
import type { LibraryItem, LibraryPanel } from "./crewonDomain";
import type { McpInventory } from "./domainCollaborationBackend";
import { libraryToolDecor } from "./domainLibraryItems";
import {
  mcpConfigDetailText,
  mcpConfigEnabled,
  mcpConfigEndpoint,
} from "./mcpConfigFormatters";

function promptPreview(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  return normalizedText.length > 72
    ? `${normalizedText.slice(0, 69)}...`
    : normalizedText;
}

function mcpServerDetailText(server: McpServerStatus, locale: Locale): string {
  const tools = Object.values(server.tools).filter(
    (tool) => tool !== undefined,
  );
  const resources = server.resources;
  const resourceTemplates = server.resourceTemplates;
  const toolLines = tools.slice(0, 12).map((tool) => {
    const name = tool.title || tool.name;
    return `- ${name}${tool.description ? `: ${tool.description}` : ""}`;
  });
  const resourceLines = resources.slice(0, 8).map((resource) => {
    const name = resource.title || resource.name;
    return `- ${name}: ${resource.uri}`;
  });
  const templateLines = resourceTemplates.slice(0, 8).map((template) => {
    const name = template.title || template.name;
    return `- ${name}: ${template.uriTemplate}`;
  });

  return [
    server.serverInfo?.description || server.serverInfo?.title || server.name,
    `Name: ${server.name}`,
    `Auth: ${server.authStatus}`,
    server.serverInfo?.version ? `Version: ${server.serverInfo.version}` : null,
    server.serverInfo?.websiteUrl
      ? `Website: ${server.serverInfo.websiteUrl}`
      : null,
    "",
    `${locale === "zh" ? "工具" : "Tools"} (${tools.length})`,
    toolLines.length > 0
      ? toolLines.join("\n")
      : locale === "zh"
        ? "暂无工具"
        : "No tools",
    "",
    `${locale === "zh" ? "资源" : "Resources"} (${resources.length})`,
    resourceLines.length > 0
      ? resourceLines.join("\n")
      : locale === "zh"
        ? "暂无资源"
        : "No resources",
    "",
    `${locale === "zh" ? "资源模板" : "Resource templates"} (${resourceTemplates.length})`,
    templateLines.length > 0
      ? templateLines.join("\n")
      : locale === "zh"
        ? "暂无资源模板"
        : "No resource templates",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function skillSourceLabel(
  path: string | null | undefined,
  locale: Locale,
): string {
  if (!path) {
    return locale === "zh" ? "内置" : "built-in";
  }

  if (
    path.includes("/.crewon/plugins/") ||
    path.includes("/.codex/plugins/") ||
    path.includes("/plugins/cache/")
  ) {
    return "Plugin";
  }

  if (path.includes("/.crewon/skill/.system/")) {
    return locale === "zh" ? "系统" : "system";
  }

  if (path.includes("/.crewon/skill/")) {
    return "Crewon";
  }

  return locale === "zh" ? "本地" : "local";
}

function pluginSkillAction(
  skillName: string,
  pluginEntries: Array<{
    marketplaceName: string;
    pluginName: string;
    remotePluginId: string | null;
  }>,
): LibraryItem["action"] | null {
  const separatorIndex = skillName.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  const pluginName = skillName.slice(0, separatorIndex);
  const shortSkillName = skillName.slice(separatorIndex + 1);
  const pluginEntry = pluginEntries.find(
    (entry) => entry.pluginName === pluginName && entry.remotePluginId,
  );
  if (!pluginEntry?.remotePluginId) {
    return null;
  }

  return {
    type: "plugin-skill",
    skillName: shortSkillName,
    remoteMarketplaceName: pluginEntry.marketplaceName,
    remotePluginId: pluginEntry.remotePluginId,
  };
}

export function toolLibraryPanelContent(params: {
  mcpInventory: McpInventory;
  pluginsResponse: PluginListResponse | null | undefined;
  skillsResponse: SkillsListResponse | null | undefined;
  workspaceToolItems: LibraryItem[];
  locale: Locale;
}): Pick<LibraryPanel, "subtitle" | "body" | "actions" | "items"> {
  const {
    mcpInventory,
    pluginsResponse,
    skillsResponse,
    workspaceToolItems,
    locale,
  } = params;
  const servers = mcpInventory.servers;
  const pluginEntries = (pluginsResponse?.marketplaces ?? []).flatMap(
    (marketplace) =>
      marketplace.plugins.map((plugin) => ({
        marketplaceName: marketplace.name,
        pluginName: plugin.name,
        remotePluginId: plugin.remotePluginId,
      })),
  );
  const skills = (skillsResponse?.data ?? []).flatMap((entry) =>
    entry.skills.map((skill) => skill),
  );
  const mcpItems: LibraryItem[] = servers.map(({ config, status }, index) => {
    const decor = libraryToolDecor("mcp", index);
    if (!status) {
      if (!config) {
        return {
          title: "MCP",
          meta: locale === "zh" ? "未知配置" : "unknown config",
          glyph: decor.glyph,
          accent: decor.accent,
        };
      }
      const endpoint = config ? mcpConfigEndpoint(config) : "";
      const source =
        locale === "zh"
          ? "真实来源：MCP 配置记录"
          : "Source of truth: MCP config record";
      return {
        title: `MCP · ${config?.name ?? ""}`,
        meta: mcpConfigEnabled(config)
          ? locale === "zh"
            ? `${source} · 已配置 · 等待加载`
            : `${source} · configured · waiting to load`
          : locale === "zh"
            ? `${source} · 已配置 · 停用`
            : `${source} · configured · disabled`,
        description:
          `${source} · ${
            endpoint ||
            (locale === "zh"
              ? "已保存到 MCP 配置，但当前运行态未返回该服务器。"
              : "Saved in MCP config, but not present in the current runtime status.")
          }`,
        glyph: decor.glyph,
        accent: decor.accent,
        badge: {
          label: locale === "zh" ? "配置" : "config",
          tone: mcpConfigEnabled(config) ? "planning" : "warning",
        },
        tags: [
          "MCP",
          mcpConfigEnabled(config)
            ? locale === "zh"
              ? "已配置"
              : "configured"
            : locale === "zh"
              ? "停用"
              : "disabled",
        ],
        action: config
          ? {
              type: "mcp-detail",
              title: config.name,
              subtitle: config.name,
              configName: config.name,
              body: mcpConfigDetailText(config, locale),
            }
          : undefined,
      };
    }

    const tools = Object.values(status.tools).filter(
      (tool) => tool !== undefined,
    );
    const firstTool = tools[0];
    const toolCount = tools.length;
    const resourceCount =
      status.resources.length + status.resourceTemplates.length;
    const serverTitle =
      status.serverInfo?.title || status.serverInfo?.name || status.name;
    const runtimeSource =
      locale === "zh"
        ? "真实来源：运行态 MCP"
        : "Source of truth: runtime MCP";
    const configState = config
      ? mcpConfigEnabled(config)
        ? locale === "zh"
          ? "已配置"
          : "configured"
        : locale === "zh"
          ? "配置停用"
          : "config disabled"
      : null;
    return {
      title: `MCP · ${serverTitle}`,
      meta: `${runtimeSource} · ${status.authStatus} · ${toolCount} ${locale === "zh" ? "工具" : "tools"} · ${resourceCount} ${
        locale === "zh" ? "资源" : "resources"
      }${configState ? ` · ${configState}` : ""}`,
      glyph: decor.glyph,
      accent: decor.accent,
      badge:
        status.authStatus === "notLoggedIn"
          ? {
              label: locale === "zh" ? "待授权" : "needs auth",
              tone: "warning",
            }
          : {
              label: locale === "zh" ? "已连接" : "connected",
              tone: "running",
            },
      tags: [
        `${toolCount} ${locale === "zh" ? "工具" : "tools"}`,
        `${resourceCount} ${locale === "zh" ? "资源" : "resources"}`,
        configState,
      ].filter((tag): tag is string => Boolean(tag)),
      description:
        `${runtimeSource} · ${
          status.serverInfo?.description ||
          (Object.keys(status.tools).length > 0
            ? locale === "zh"
              ? `已分配给工程师和自动化使用：${Object.keys(status.tools).slice(0, 5).join(", ")}`
              : `Assigned to engineers and automations: ${Object.keys(status.tools).slice(0, 5).join(", ")}`
            : locale === "zh"
              ? "当前运行态未返回可调用工具。"
              : "No callable tools are currently reported by the runtime.")
        }`,
      action: {
        type: "mcp-detail",
        title: serverTitle,
        subtitle: status.name,
        body: [
          runtimeSource,
          mcpServerDetailText(status, locale),
          config
            ? `\n${locale === "zh" ? "持久化配置" : "Persisted config"}\n${mcpConfigDetailText(config, locale)}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        authStatus: status.authStatus,
        configName: config?.name,
        tool: firstTool
          ? {
              server: status.name,
              name: firstTool.name,
              label: firstTool.title || firstTool.name,
              inputSchema: JSON.stringify(firstTool.inputSchema ?? {}, null, 2),
            }
          : undefined,
        resource:
          status.resources.length > 0
            ? {
                server: status.name,
                uri: status.resources[0].uri,
                label:
                  status.resources[0].title ||
                  status.resources[0].name ||
                  status.resources[0].uri,
              }
            : undefined,
      },
    };
  });
  const skillItems: LibraryItem[] = skills.map((skill, index) => {
    const source = skillSourceLabel(skill.path, locale);
    const truthSource =
      locale === "zh"
        ? "真实来源：Skill 文件"
        : "Source of truth: skill file";
    const decor = libraryToolDecor("skill", index);
    return {
      title: `Skill · ${skill.name}`,
      meta: `${truthSource} · ${source} · ${skill.enabled ? (locale === "zh" ? "可招募" : "recruitable") : locale === "zh" ? "停用" : "disabled"}`,
      glyph: decor.glyph,
      accent: decor.accent,
      badge: {
        label: skill.enabled
          ? locale === "zh"
            ? "可招募"
            : "recruitable"
          : locale === "zh"
            ? "停用"
            : "disabled",
        tone: skill.enabled ? "running" : "warning",
      },
      tags: ["Skill", source],
      description:
        `${truthSource} · ${
          promptPreview(
            skill.description ||
              skill.shortDescription ||
              (locale === "zh"
                ? `可绑定到智能体或办公室：${skill.path}`
                : `Assignable to agents or offices: ${skill.path}`),
          ) ||
          (locale === "zh"
            ? "可绑定到智能体或办公室。"
            : "Assignable to agents or offices.")
        }`,
      action: skill.path
        ? {
            type: "skill-file",
            skillName: skill.name,
            path: skill.path,
            enabled: skill.enabled,
          }
        : (pluginSkillAction(skill.name, pluginEntries) ?? undefined),
    };
  });

  return {
    subtitle:
      locale === "zh"
        ? `${servers.length} 个 MCP · ${mcpInventory.configs.length} 个配置 · ${skills.length} 个 Skill`
        : `${servers.length} MCP · ${mcpInventory.configs.length} configs · ${skills.length} skills`,
    body:
      locale === "zh"
        ? "工具库是智能体和办公室的能力市场。MCP 负责连接外部系统，Skill 负责沉淀可复用流程；新建后可以分配给某个智能体或办公室。"
        : "The tool library is the capability market for agents and offices. MCP connects external systems, while Skills package reusable workflows for assignment.",
    actions: [
      {
        id: "create-mcp",
        label: locale === "zh" ? "新建 MCP" : "New MCP",
        tone: "primary",
      },
      {
        id: "create-skill",
        label: locale === "zh" ? "新建 Skill" : "New Skill",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "刷新工具" : "Refresh tools",
      },
    ],
    items: [
      ...(workspaceToolItems.length > 0
        ? [
            {
              title: locale === "zh" ? "后端工具记录" : "Backend tool records",
              meta:
                locale === "zh"
                  ? `${workspaceToolItems.length} 个草稿`
                  : `${workspaceToolItems.length} drafts`,
              description:
                locale === "zh"
                  ? "这些 MCP 和 Skill 来自 app-server tool/list，可继续编辑并分配给智能体。"
                  : "These MCP and Skill entries come from app-server tool/list and can be assigned to agents.",
              section: true,
            },
            ...workspaceToolItems,
          ]
        : []),
      {
        title: "MCP",
        meta:
          locale === "zh"
            ? `${servers.length} 个服务器 · ${mcpInventory.configs.length} 个配置`
            : `${servers.length} servers · ${mcpInventory.configs.length} configs`,
        description:
          locale === "zh"
            ? "运行态连接与持久化配置合并展示；未加载或停用的 MCP 也会保留在这里。"
            : "Runtime connectors merged with persisted config; unloaded or disabled MCPs remain visible here.",
        section: true,
      },
      ...mcpItems,
      {
        title: "Skill",
        meta:
          locale === "zh" ? `${skills.length} 个技能` : `${skills.length} skills`,
        description:
          locale === "zh"
            ? "方法库：代码审查、甲方材料、演示截图、表格分析等流程，招募到办公室后可复用。"
            : "Method library for review, client materials, demo screenshots, spreadsheet analysis, and reusable office workflows.",
        section: true,
      },
      ...skillItems,
    ],
  };
}
