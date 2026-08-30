import type { JsonValue } from "@crewon/app-server-protocol/serde_json/JsonValue";
import type { ResourceContent } from "@crewon/app-server-protocol/ResourceContent";

import type { LibraryPanel, LibraryPanelAction } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { trimmedPanelFieldValue } from "../shared/panelState";

export function mcpToolThreadUnavailableError(locale: Locale): string {
  return locale === "zh"
    ? "无法创建工具验证线程。"
    : "Unable to create a tool verification thread.";
}

export function mcpToolArgumentsError(error: unknown, locale: Locale): string {
  if (error instanceof Error) {
    return `${locale === "zh" ? "参数不是合法 JSON" : "Arguments are not valid JSON"}: ${error.message}`;
  }
  return locale === "zh" ? "参数不是合法 JSON" : "Arguments are not valid JSON";
}

export function mcpToolArgumentsPayload(
  panel: LibraryPanel | null,
): JsonValue | undefined {
  const argsText = trimmedPanelFieldValue(
    panel,
    "mcp-tool-arguments",
    "{}",
  );
  return argsText ? (JSON.parse(argsText) as JsonValue) : undefined;
}

export function mcpToolThreadUnavailablePanel(
  panel: LibraryPanel | null,
  locale: Locale,
): LibraryPanel | null {
  return mcpToolErrorPanel(panel, mcpToolThreadUnavailableError(locale));
}

export function mcpToolArgumentsErrorPanel(
  panel: LibraryPanel | null,
  error: unknown,
  locale: Locale,
): LibraryPanel | null {
  return mcpToolErrorPanel(panel, mcpToolArgumentsError(error, locale));
}

export function mcpToolErrorPanel(
  panel: LibraryPanel | null,
  message: string,
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        error: message,
      }
    : panel;
}

export function mcpToolCallRecordTitle(params: {
  locale: Locale;
  server: string;
  tool: string;
}): string {
  const { locale, server, tool } = params;
  return locale === "zh"
    ? `记录 MCP 工具调用：${server}.${tool}`
    : `Record MCP tool call: ${server}.${tool}`;
}

export function mcpToolCallRecordText(params: {
  args: unknown;
  locale: Locale;
  response: unknown;
  server: string;
  tool: string;
}): string {
  const { args, locale, response, server, tool } = params;
  return [
    locale === "zh" ? `工具：${server}.${tool}` : `Tool: ${server}.${tool}`,
    locale === "zh" ? "参数：" : "Arguments:",
    JSON.stringify(args ?? {}, null, 2),
    locale === "zh" ? "结果：" : "Result:",
    JSON.stringify(response ?? {}, null, 2),
  ].join("\n");
}

export function mcpToolCallPanelBody(params: {
  currentBody?: string;
  locale: Locale;
  recordWarning: string | null;
  response: unknown;
  threadId: string;
}): string {
  const { currentBody, locale, recordWarning, response, threadId } = params;
  return [
    currentBody ?? "",
    "",
    locale === "zh" ? `调用结果 · 线程 ${threadId}` : `Tool result · thread ${threadId}`,
    JSON.stringify(response ?? {}, null, 2),
    recordStatusText({
      locale,
      successText:
        locale === "zh"
          ? "结果已写入工具验证线程。"
          : "Result written to the tool verification thread.",
      warning: recordWarning,
    }),
  ]
    .filter(Boolean)
    .join("\n");
}

export function mcpToolOpenThreadActions(
  currentActions: LibraryPanelAction[] | undefined,
  threadId: string,
  locale: Locale,
): LibraryPanelAction[] {
  return [
    {
      id: "open-thread",
      label:
        locale === "zh"
          ? "打开工具验证线程"
          : "Open tool verification thread",
      threadId,
    },
    ...(currentActions ?? []).filter(
      (currentAction) =>
        !(
          currentAction.id === "open-thread" &&
          currentAction.threadId === threadId
        ),
    ),
  ];
}

export function mcpToolCallResultPanel(
  panel: LibraryPanel | null,
  params: {
    locale: Locale;
    recordWarning: string | null;
    response: unknown;
    threadId: string;
  },
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        body: mcpToolCallPanelBody({
          currentBody: panel.body,
          locale: params.locale,
          recordWarning: params.recordWarning,
          response: params.response,
          threadId: params.threadId,
        }),
        actions: mcpToolOpenThreadActions(
          panel.actions,
          params.threadId,
          params.locale,
        ),
        error: undefined,
      }
    : panel;
}

export function mcpResourceBody(
  contents: ResourceContent[],
  locale: Locale,
): string {
  return contents
    .map((content) => {
      if ("text" in content) {
        return [
          `URI: ${content.uri}`,
          content.mimeType ? `MIME: ${content.mimeType}` : null,
          "",
          content.text,
        ]
          .filter(Boolean)
          .join("\n");
      }
      return [
        `URI: ${content.uri}`,
        content.mimeType ? `MIME: ${content.mimeType}` : null,
        "",
        locale === "zh"
          ? `二进制资源，base64 长度：${content.blob.length}`
          : `Binary resource, base64 length: ${content.blob.length}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n---\n\n");
}

export function mcpResourceRecordTitle(params: {
  locale: Locale;
  server: string;
}): string {
  const { locale, server } = params;
  return locale === "zh"
    ? `记录 MCP 资源读取：${server}`
    : `Record MCP resource read: ${server}`;
}

export function mcpResourceRecordText(params: {
  body: string;
  locale: Locale;
  uri: string;
}): string {
  const { body, locale, uri } = params;
  return [
    locale === "zh" ? `资源：${uri}` : `Resource: ${uri}`,
    locale === "zh" ? "内容摘要：" : "Content summary:",
    body.length > 6000 ? `${body.slice(0, 6000)}\n...` : body,
  ].join("\n");
}

export function mcpResourcePanelBody(params: {
  body: string;
  locale: Locale;
  recordWarning: string | null;
  threadId: string | null;
}): string {
  const { body, locale, recordWarning, threadId } = params;
  return [
    body ||
      (locale === "zh"
        ? "资源读取成功，但没有内容。"
        : "Resource read succeeded with no contents."),
    threadId
      ? recordStatusText({
          locale,
          successText:
            locale === "zh"
              ? `资源读取结果已写入线程：${threadId}`
              : `Resource read result written to thread: ${threadId}`,
          warning: recordWarning,
        })
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function mcpResourceOpenThreadActions(
  currentActions: LibraryPanelAction[] | undefined,
  threadId: string,
  locale: Locale,
): LibraryPanelAction[] {
  return [
    {
      id: "open-thread",
      label:
        locale === "zh"
          ? "打开资源验证线程"
          : "Open resource verification thread",
      threadId,
    },
    ...(currentActions ?? []).filter(
      (currentAction) =>
        !(
          currentAction.id === "open-thread" &&
          currentAction.threadId === threadId
        ),
    ),
  ];
}

export function mcpResourceReadResultPanel(
  panel: LibraryPanel | null,
  params: {
    body: string;
    locale: Locale;
    recordWarning: string | null;
    threadId: string | null;
  },
): LibraryPanel | null {
  return panel
    ? {
        ...panel,
        body: mcpResourcePanelBody(params),
        actions: params.threadId
          ? mcpResourceOpenThreadActions(
              panel.actions,
              params.threadId,
              params.locale,
            )
          : panel.actions,
        error: undefined,
      }
    : panel;
}

export function mcpToolRecordWarningText(locale: Locale): string {
  return locale === "zh"
    ? "工具调用结果写入后端线程失败"
    : "Unable to write tool result to backend thread";
}

export function mcpResourceRecordWarningText(locale: Locale): string {
  return locale === "zh"
    ? "资源读取结果写入后端线程失败"
    : "Unable to write resource result to backend thread";
}

function recordStatusText(params: {
  locale: Locale;
  successText: string;
  warning: string | null;
}): string {
  if (!params.warning) {
    return params.successText;
  }
  return params.locale === "zh"
    ? `记录警告：${params.warning}`
    : `Record warning: ${params.warning}`;
}
