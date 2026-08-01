import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";
import type { PluginListResponse } from "@crewon-protocol/v2/PluginListResponse";
import type { SkillsListResponse } from "@crewon-protocol/v2/SkillsListResponse";

import type { Locale } from "../i18n";
import type { LibraryItem, LibraryPanel } from "./crewonDomain";
import { capabilityPresetItems } from "../capability/capabilityCatalog";
import type { McpInventory } from "./domainCollaborationBackend";
import { libraryToolDecor } from "./domainLibraryItems";
import { promptPreview } from "../shared/text";
import {
  mcpConfigDetailText,
  mcpConfigEnabled,
  mcpConfigEndpoint,
  mcpConfigObject,
} from "../mcp/mcpConfigFormatters";

function authStatusLabel(authStatus: string, locale: Locale): string {
  const isZh = locale === "zh";
  switch (authStatus) {
    case "notLoggedIn":
      return isZh ? "待授权" : "Needs auth";
    case "loggedIn":
    case "authorized":
      return isZh ? "已授权" : "Authorized";
    case "unsupported":
      return isZh ? "免授权" : "No auth";
    default:
      return authStatus;
  }
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
          title: locale === "zh" ? "服务" : "MCP",
          meta: locale === "zh" ? "未知配置" : "unknown config",
          glyph: decor.glyph,
          accent: decor.accent,
          capabilityKind: "mcp",
        };
      }
      const endpoint = config ? mcpConfigEndpoint(config) : "";
      const enabled = mcpConfigEnabled(config);
      return {
        title: config?.name ?? (locale === "zh" ? "服务" : "MCP"),
        meta: `${locale === "zh" ? "服务" : "MCP"} · ${
          enabled
            ? locale === "zh"
              ? "已配置 · 等待加载"
              : "Configured · waiting"
            : locale === "zh"
              ? "已配置 · 已停用"
              : "Configured · disabled"
        }`,
        description:
          endpoint ||
          (locale === "zh"
            ? "已保存到服务配置，但当前运行态尚未返回该服务。"
            : "Saved in MCP config, but not yet reported by the runtime."),
        glyph: decor.glyph,
        accent: decor.accent,
        capabilityKind: "mcp",
        badge: {
          label: enabled
            ? locale === "zh"
              ? "等待加载"
              : "waiting"
            : locale === "zh"
              ? "已停用"
              : "disabled",
          tone: enabled ? "planning" : "warning",
        },
        tags: [
          locale === "zh" ? "服务" : "MCP",
          enabled
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
              config: mcpConfigObject(config),
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
      title: serverTitle,
      meta: `${locale === "zh" ? "服务" : "MCP"} · ${authStatusLabel(status.authStatus, locale)}${
        status.serverInfo?.version ? ` · v${status.serverInfo.version}` : ""
      }`,
      glyph: decor.glyph,
      accent: decor.accent,
      capabilityKind: "mcp",
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
        status.serverInfo?.description ||
        (Object.keys(status.tools).length > 0
          ? locale === "zh"
            ? `可供工程师和自动化调用：${Object.keys(status.tools).slice(0, 5).join("、")}`
            : `Callable by engineers and automations: ${Object.keys(status.tools).slice(0, 5).join(", ")}`
          : locale === "zh"
            ? "当前运行态未返回可调用工具。"
            : "No callable tools are currently reported by the runtime."),
      action: {
        type: "mcp-detail",
        title: serverTitle,
        subtitle: status.name,
        body: [
          mcpServerDetailText(status, locale),
          config
            ? `\n${locale === "zh" ? "持久化配置" : "Persisted config"}\n${mcpConfigDetailText(config, locale)}`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        authStatus: status.authStatus,
        configName: config?.name,
        config: config ? mcpConfigObject(config) : undefined,
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
    const decor = libraryToolDecor("skill", index);
    return {
      title: skill.name,
      meta: locale === "zh" ? "技能" : "Skill",
      glyph: decor.glyph,
      accent: decor.accent,
      capabilityKind: "skill",
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
      tags: [locale === "zh" ? "技能" : "Skill"],
      description:
        promptPreview(
          skill.description ||
            skill.shortDescription ||
            (locale === "zh"
              ? `可绑定到智能体或办公室：${skill.path}`
              : `Assignable to agents or offices: ${skill.path}`),
        ) ||
        (locale === "zh"
          ? "可绑定到智能体或办公室。"
          : "Assignable to agents or offices."),
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
  const presetItems = capabilityPresetItems(locale);
  const presetSkillItems = presetItems.filter(
    (item) => item.capabilityKind === "skill",
  );
  const presetMcpItems = presetItems.filter(
    (item) => item.capabilityKind === "mcp",
  );
  const installedItems = dedupeCapabilityItems([
    ...mcpItems,
    ...skillItems,
    ...workspaceToolItems,
  ]);

  return {
    subtitle:
      locale === "zh"
        ? `${installedItems.length} 个已添加 · ${presetItems.length} 个预制能力`
        : `${installedItems.length} added · ${presetItems.length} presets`,
    body:
      locale === "zh"
        ? "能力统一分为技能和服务：技能沉淀可复用工作流，服务通过 MCP 协议连接外部系统与数据。预制项会先打开可编辑配置，确认保存后才写入。"
        : "Capabilities are either Skills or MCP services. Presets open as editable drafts and are written only after confirmation.",
    actions: [
      {
        id: "create-skill",
        label: locale === "zh" ? "创建技能" : "Create Skill",
        tone: "primary",
      },
      {
        id: "create-mcp",
        label: locale === "zh" ? "创建服务" : "Create MCP service",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "刷新工具" : "Refresh tools",
      },
    ],
    items: [
      ...(installedItems.length > 0
        ? [
            {
              title: locale === "zh" ? "已添加" : "Added",
              meta:
                locale === "zh"
                  ? `${installedItems.length} 个能力`
                  : `${installedItems.length} capabilities`,
              description:
                locale === "zh"
                  ? "已添加的技能和服务，可继续编辑、启停或分配给智能体。"
                  : "Added Skills and MCP services can be edited, toggled, or assigned.",
              section: true,
            },
            ...installedItems,
          ]
        : []),
      {
        title: locale === "zh" ? "精选技能" : "Featured Skills",
        meta:
          locale === "zh"
            ? `${presetSkillItems.length} 个模板`
            : `${presetSkillItems.length} templates`,
        description:
          locale === "zh"
            ? "参考 WorkBuddy 的办公、内容、研究、数据和开发能力，点击后可先编辑再添加。"
            : "WorkBuddy-inspired office, content, research, data, and developer workflows.",
        section: true,
      },
      ...presetSkillItems,
      {
        title: locale === "zh" ? "服务" : "MCP services",
        meta:
          locale === "zh"
            ? `${presetMcpItems.length} 个预制配置`
            : `${presetMcpItems.length} presets`,
        description:
          locale === "zh"
            ? "基于 MCP 协议和公开文档预制；命令、URL、参数和环境变量都可在保存前编辑。"
            : "Based on official MCP documentation; edit commands, URLs, arguments, and environment before saving.",
        section: true,
      },
      ...presetMcpItems,
    ],
  };
}

function dedupeCapabilityItems(items: LibraryItem[]): LibraryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.capabilityKind ?? item.meta}:${item.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
