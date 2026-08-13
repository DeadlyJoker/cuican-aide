import type { McpServerConfigRecord } from "@crewon-protocol/v2/McpServerConfigRecord";
import type { McpServerStatus } from "@crewon-protocol/v2/McpServerStatus";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { Locale } from "../i18n";
import { mcpConfigSummaryText } from "../mcp/mcpConfigFormatters";

type McpInventory = {
  configs: McpServerConfigRecord[];
  servers: Array<{
    config?: McpServerConfigRecord;
    name: string;
    status?: McpServerStatus;
  }>;
  statuses: McpServerStatus[];
};

export function mcpSettingsText(
  servers: McpServerStatus[],
  locale: Locale,
): string {
  const toolCount = servers.reduce(
    (total, server) => total + Object.keys(server.tools).length,
    0,
  );
  const resourceCount = servers.reduce(
    (total, server) =>
      total + server.resources.length + server.resourceTemplates.length,
    0,
  );
  const authCounts = servers.reduce<Record<string, number>>(
    (counts, server) => {
      counts[server.authStatus] = (counts[server.authStatus] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const authSummary = Object.entries(authCounts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(" · ");
  const serverLines = servers.slice(0, 16).map((server) => {
    const title =
      server.serverInfo?.title || server.serverInfo?.name || server.name;
    const tools = Object.values(server.tools)
      .filter((tool) => tool !== undefined)
      .slice(0, 6)
      .map((tool) => tool.title || tool.name);
    const resourceTotal =
      server.resources.length + server.resourceTemplates.length;
    return [
      `- ${title}`,
      `  name: ${server.name}`,
      `  auth: ${server.authStatus}`,
      server.serverInfo?.version
        ? `  version: ${server.serverInfo.version}`
        : null,
      server.serverInfo?.websiteUrl
        ? `  website: ${server.serverInfo.websiteUrl}`
        : null,
      `  tools: ${Object.keys(server.tools).length}${tools.length > 0 ? ` · ${tools.join(", ")}` : ""}`,
      `  resources: ${resourceTotal}`,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [
    locale === "zh"
      ? `MCP 服务器: ${servers.length} · 工具: ${toolCount} · 资源: ${resourceCount}`
      : `MCP servers: ${servers.length} · tools: ${toolCount} · resources: ${resourceCount}`,
    authSummary
      ? `${locale === "zh" ? "认证状态" : "Auth status"}: ${authSummary}`
      : null,
    "",
    serverLines.length > 0
      ? serverLines.join("\n\n")
      : locale === "zh"
        ? "暂无 MCP 服务器。可以通过工具页新建 MCP 草稿，或在配置中添加 mcp_servers。"
        : "No MCP servers. Create an MCP draft from Tools, or add mcp_servers in config.",
  ]
    .filter(Boolean)
    .join("\n");
}
function mcpSettingsTitle(locale: Locale): string {
  return locale === "zh" ? "MCP 服务器" : "MCP servers";
}

function mcpSettingsSubtitle(locale: Locale): string {
  return locale === "zh" ? "运行态连接器" : "Runtime connectors";
}

export function mcpSettingsDisconnectedPanel(
  connectionHint: string,
  locale: Locale,
): CapabilityPanel {
  return {
    title: mcpSettingsTitle(locale),
    subtitle: connectionHint,
    error:
      locale === "zh"
        ? "未连接本地 app-server"
        : "Local app-server is not connected",
  };
}

export function mcpSettingsLoadingPanel(locale: Locale): CapabilityPanel {
  return {
    title: mcpSettingsTitle(locale),
    subtitle: mcpSettingsSubtitle(locale),
    body: locale === "zh" ? "正在读取 MCP 服务器..." : "Reading MCP servers...",
  };
}

export function mcpSettingsPanel(
  inventory: McpInventory,
  locale: Locale,
): CapabilityPanel {
  const configOnlyCount = inventory.servers.filter(
    (server) => server.config && !server.status,
  ).length;
  const toolCount = inventory.servers.reduce(
    (total, server) =>
      total + (server.status ? Object.keys(server.status.tools).length : 0),
    0,
  );
  const resourceCount = inventory.servers.reduce(
    (total, server) =>
      total +
      (server.status
        ? server.status.resources.length +
          server.status.resourceTemplates.length
        : 0),
    0,
  );

  return {
    title: mcpSettingsTitle(locale),
    subtitle:
      locale === "zh"
        ? `${inventory.servers.length} 服务器 · ${inventory.configs.length} 配置 · ${configOnlyCount} 未加载`
        : `${inventory.servers.length} servers · ${inventory.configs.length} configs · ${configOnlyCount} unloaded`,
    body: [
      mcpSettingsText(inventory.statuses, locale),
      "",
      locale === "zh"
        ? `持久化配置 (${inventory.configs.length})`
        : `Persisted config (${inventory.configs.length})`,
      mcpConfigSummaryText(inventory.configs, locale),
      "",
      locale === "zh"
        ? `运行态工具: ${toolCount} · 资源: ${resourceCount}`
        : `Runtime tools: ${toolCount} · resources: ${resourceCount}`,
    ]
      .filter(Boolean)
      .join("\n"),
    actions: [
      {
        id: "refresh-mcp-settings",
        label: locale === "zh" ? "刷新 MCP" : "Refresh MCP",
      },
      {
        id: "reload-tools",
        label: locale === "zh" ? "重载 MCP 配置" : "Reload MCP config",
      },
    ],
  };
}

export function mcpSettingsErrorPanel(
  error: unknown,
  locale: Locale,
): CapabilityPanel {
  return {
    title: mcpSettingsTitle(locale),
    subtitle: mcpSettingsSubtitle(locale),
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取 MCP 服务器失败"
          : "Unable to read MCP servers",
  };
}

export function mcpReloadProgressBody(locale: Locale): string {
  return locale === "zh" ? "正在重载 MCP 配置..." : "Reloading MCP config...";
}

export function mcpReloadProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        body: mcpReloadProgressBody(locale),
        error: undefined,
      }
    : panel;
}

export function mcpReloadFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "重载 MCP 配置失败"
      : "Unable to reload MCP config";
}

export function mcpReloadFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        error: mcpReloadFailureMessage(error, locale),
      }
    : panel;
}
