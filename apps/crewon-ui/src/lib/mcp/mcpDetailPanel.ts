import type {
  LibraryItem,
  LibraryPanel,
  LibraryPanelAction,
  LibraryPanelField,
  McpDetailAction,
} from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { buildMcpDraftPanelContent } from "../draft/draftSavePayloads";
import { toolEmptyHistoryItems } from "../thread/threadHistoryItems";

type McpDetailPanelContent = {
  title: string;
  subtitle: string;
  body: string;
  fields?: LibraryPanelField[];
  actions?: LibraryPanelAction[];
  items?: LibraryItem[];
};

type McpDetailPanelTarget = {
  subtitle: string;
  title: string;
};

export function buildMcpDetailPanelContent(
  action: McpDetailAction,
  locale: Locale,
): McpDetailPanelContent {
  const tool = action.tool;
  const editor = action.config
    ? buildMcpDraftPanelContent({
        config: action.config,
        locale,
        mode: "edit",
        serverName: action.configName || action.subtitle,
      })
    : null;
  const actions = [
    ...(editor?.actions?.filter((item) => item.id === "save-mcp-config") ?? []),
    ...mcpDetailActions(action, locale),
  ];
  return {
    title: action.title,
    subtitle: action.subtitle,
    body: [
      action.body,
      tool
        ? [
            "",
            locale === "zh" ? "默认调用工具" : "Default callable tool",
            `${tool.label} (${tool.name})`,
            "inputSchema:",
            tool.inputSchema,
          ].join("\n")
        : null,
    ]
      .filter(Boolean)
      .join("\n"),
    fields:
      editor || tool
        ? [
            ...(editor?.fields ?? []),
            ...(tool
              ? [
                  {
                    id: "mcp-tool-arguments",
                    label:
                      locale === "zh" ? "工具参数 JSON" : "Tool arguments JSON",
                    placeholder: "{\n}",
                    value: "{}",
                  },
                ]
              : []),
          ]
        : undefined,
    actions: actions.length > 0 ? actions : undefined,
    items: tool
      ? [
          {
            title:
              locale === "zh" ? "正在读取调用记录" : "Reading call history",
            meta: "app-server",
            description:
              locale === "zh"
                ? "正在从工具验证线程读取最近调用记录。"
                : "Loading recent calls from the tool verification thread.",
            glyph: "◷",
            accent: "blue",
          },
        ]
      : undefined,
  };
}

export function mcpDetailContentPanel(
  panel: LibraryPanel | null,
  content: McpDetailPanelContent,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        ...mcpDetailContentPatch(content, panel.items),
      }
    : panel;
}

export function mcpDetailContentPatch(
  content: McpDetailPanelContent,
  currentItems: LibraryItem[],
): Partial<LibraryPanel> {
  return {
    title: content.title,
    subtitle: content.subtitle,
    body: content.body,
    fields: content.fields,
    actions: content.actions,
    items: content.items ?? currentItems,
    error: undefined,
  };
}

export function mcpToolEmptyHistoryPanel(
  panel: LibraryPanel | null,
  target: McpDetailPanelTarget,
  locale: Locale,
): LibraryPanel | null {
  return patchMatchingMcpDetailPanel(panel, target, {
    items: toolEmptyHistoryItems(locale),
  });
}

export function mcpToolThreadTitle(
  tool: NonNullable<McpDetailAction["tool"]>,
  locale: Locale,
): string {
  return mcpToolThreadTitleForNames(tool.server, tool.name, locale);
}

export function mcpToolThreadTitleForNames(
  serverName: string,
  toolName: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `工具验证 · ${serverName}.${toolName}`
    : `Tool check · ${serverName}.${toolName}`;
}

export function mcpToolThreadGoal(
  serverName: string,
  toolName: string,
  locale: Locale,
): string {
  return locale === "zh"
    ? `验证 MCP 工具 ${serverName}.${toolName} 的后端调用结果。`
    : `Verify backend MCP tool call result for ${serverName}.${toolName}.`;
}

export function mcpBackendToolEventPrompt(title: string, body: string): string {
  return [title, "", body].join("\n");
}

export function mcpToolHistoryPatch(params: {
  currentActions: LibraryPanelAction[] | undefined;
  items: LibraryItem[];
  locale: Locale;
  threadId: string;
}): Partial<LibraryPanel> {
  const { currentActions, items, locale, threadId } = params;
  return {
    actions: [
      {
        id: "open-thread",
        label:
          locale === "zh"
            ? "打开工具验证线程"
            : "Open tool verification thread",
        threadId,
      },
      ...(currentActions ?? []).filter(
        (currentAction) => currentAction.id !== "open-thread",
      ),
    ],
    items,
    error: undefined,
  };
}

export function mcpToolHistoryPanel(
  panel: LibraryPanel | null,
  target: McpDetailPanelTarget,
  params: {
    items: LibraryItem[];
    locale: Locale;
    threadId: string;
  },
): LibraryPanel | null {
  return panelMatchesMcpDetail(panel, target)
    ? {
        ...panel,
        ...mcpToolHistoryPatch({
          currentActions: panel.actions,
          items: params.items,
          locale: params.locale,
          threadId: params.threadId,
        }),
      }
    : panel;
}

export function mcpToolHistoryFailurePatch(
  error: unknown,
  locale: Locale,
): Partial<LibraryPanel> {
  return {
    error:
      error instanceof Error
        ? error.message
        : locale === "zh"
          ? "读取工具调用记录失败"
          : "Unable to read tool call history",
  };
}

export function mcpToolHistoryFailurePanel(
  panel: LibraryPanel | null,
  target: McpDetailPanelTarget,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return patchMatchingMcpDetailPanel(
    panel,
    target,
    mcpToolHistoryFailurePatch(error, locale),
  );
}

function patchMatchingMcpDetailPanel(
  panel: LibraryPanel | null,
  target: McpDetailPanelTarget,
  patch: Partial<LibraryPanel>,
): LibraryPanel | null {
  return panelMatchesMcpDetail(panel, target)
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}

function panelMatchesMcpDetail(
  panel: LibraryPanel | null,
  target: McpDetailPanelTarget,
): panel is LibraryPanel {
  return panel?.title === target.title && panel.subtitle === target.subtitle;
}

function mcpDetailActions(
  action: McpDetailAction,
  locale: Locale,
): LibraryPanelAction[] {
  const actions: LibraryPanelAction[] = [];
  const primaryWhenLoggedIn =
    action.authStatus === "notLoggedIn" ? undefined : "primary";

  if (action.authStatus === "notLoggedIn") {
    actions.push({
      id: "login-mcp-oauth",
      label: locale === "zh" ? "登录服务" : "Log in to MCP",
      mcpServerName: action.subtitle,
      tone: "primary",
    });
  }

  if (action.resource) {
    actions.push({
      id: "read-mcp-resource",
      label:
        locale === "zh"
          ? `读取资源：${action.resource.label}`
          : `Read resource: ${action.resource.label}`,
      mcpResourceServer: action.resource.server,
      mcpResourceUri: action.resource.uri,
      tone: primaryWhenLoggedIn,
    });
  }

  if (action.tool) {
    actions.push({
      id: "call-mcp-tool",
      label:
        locale === "zh"
          ? `调用工具：${action.tool.label}`
          : `Call tool: ${action.tool.label}`,
      mcpServerName: action.tool.server,
      mcpToolName: action.tool.name,
      tone: primaryWhenLoggedIn,
    });
  }

  if (action.configName) {
    actions.push({
      id: "delete-mcp-config",
      label: locale === "zh" ? "删除服务配置" : "Delete MCP config",
      mcpServerName: action.configName,
      tone: "danger",
    });
  }

  if (action.configPath) {
    actions.push(
      {
        id: "open-path",
        label: locale === "zh" ? "打开后端记录" : "Open backend record",
        pathToOpen: action.configPath,
        pathKind: "file",
      },
      {
        id: "delete-config-file",
        label:
          locale === "zh"
            ? "只删除工具库记录"
            : "Delete tool-library record only",
        pathToOpen: action.configPath,
        pathKind: "file",
        domainConfigKind: "tool",
        tone: "danger",
      },
    );
  }

  return actions;
}
