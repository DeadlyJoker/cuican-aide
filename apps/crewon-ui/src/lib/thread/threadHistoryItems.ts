import type { Thread } from "@crewon-protocol/v2/Thread";
import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";
import type { Turn } from "@crewon-protocol/v2/Turn";

import type { CapabilityPanel } from "../capability/capabilityPanelTypes";
import type { LibraryItem } from "../domain/crewonDomain";
import type { Locale } from "../i18n";
import { formatUnixSeconds } from "../shared/timeFormatters";
import { compactOfficeMessageText, userMessageText } from "./threadModel";

function automationItemSummary(
  item: ThreadItem,
  locale: Locale,
): string | null {
  if (item.type === "userMessage") {
    const text = userMessageText(item).trim();
    return text
      ? `${locale === "zh" ? "请求" : "Request"}: ${compactOfficeMessageText(text)}`
      : null;
  }
  if (item.type === "agentMessage" && item.text.trim()) {
    return `${locale === "zh" ? "结果" : "Result"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "plan" && item.text.trim()) {
    return `${locale === "zh" ? "计划" : "Plan"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput?.trim();
    return [
      `${locale === "zh" ? "命令" : "Command"}: ${item.command}`,
      output ? compactOfficeMessageText(output.slice(0, 600)) : item.status,
    ].join("\n");
  }
  if (item.type === "mcpToolCall") {
    return `${locale === "zh" ? "MCP 调用" : "MCP call"}: ${item.server}.${item.tool} · ${item.status}`;
  }
  if (item.type === "dynamicToolCall") {
    return `${locale === "zh" ? "工具调用" : "Tool call"}: ${item.namespace ? `${item.namespace}.` : ""}${item.tool} · ${item.status}`;
  }
  if (item.type === "collabAgentToolCall") {
    return `${locale === "zh" ? "智能体协作" : "Agent collaboration"}: ${item.tool} · ${item.status}`;
  }
  if (item.type === "fileChange") {
    return `${locale === "zh" ? "文件改动" : "File changes"}: ${item.changes.length} · ${item.status}`;
  }
  if (item.type === "webSearch") {
    return `${locale === "zh" ? "搜索" : "Search"}: ${item.query}`;
  }
  return null;
}

function automationTurnMetrics(turn: Turn, locale: Locale): string {
  const commandCount = turn.items.filter(
    (item) => item.type === "commandExecution",
  ).length;
  const toolCount = turn.items.filter(
    (item) =>
      item.type === "mcpToolCall" ||
      item.type === "dynamicToolCall" ||
      item.type === "collabAgentToolCall",
  ).length;
  const fileChangeCount = turn.items.reduce(
    (count, item) =>
      item.type === "fileChange" ? count + item.changes.length : count,
    0,
  );
  const metrics = [
    commandCount
      ? `${commandCount} ${locale === "zh" ? "命令" : "commands"}`
      : null,
    toolCount ? `${toolCount} ${locale === "zh" ? "工具" : "tools"}` : null,
    fileChangeCount
      ? `${fileChangeCount} ${locale === "zh" ? "文件改动" : "file changes"}`
      : null,
  ].filter(Boolean);
  return metrics.length > 0
    ? metrics.join(" · ")
    : `${turn.items.length} ${locale === "zh" ? "项" : "items"}`;
}

function automationTurnDescription(
  turn: Turn,
  thread: Thread,
  locale: Locale,
): string {
  const summaries = turn.items
    .map((item) => automationItemSummary(item, locale))
    .filter((summary): summary is string => Boolean(summary));
  const summary = summaries.slice(0, 3).join("\n\n") || thread.preview || "";
  return summary.length > 420 ? `${summary.slice(0, 417)}...` : summary;
}

export function automationRunHistoryItems(
  thread: Thread,
  locale: Locale,
): LibraryItem[] {
  const runs = [...thread.turns]
    .reverse()
    .map((turn, index): LibraryItem => {
      const statusLabel =
        locale === "zh"
          ? turn.status === "completed"
            ? "完成"
            : turn.status === "inProgress"
              ? "运行中"
              : "失败"
          : turn.status === "completed"
            ? "Completed"
            : turn.status === "inProgress"
              ? "Running"
              : "Failed";

      return {
        title:
          locale === "zh"
            ? `运行记录 ${thread.turns.length - index}`
            : `Run ${thread.turns.length - index}`,
        meta: [
          statusLabel,
          formatUnixSeconds(turn.completedAt ?? turn.startedAt, locale),
          automationTurnMetrics(turn, locale),
        ]
          .filter(Boolean)
          .join(" · "),
        description:
          automationTurnDescription(turn, thread, locale) ||
          (locale === "zh" ? "暂无运行摘要" : "No run summary yet"),
        glyph:
          turn.status === "completed"
            ? "✓"
            : turn.status === "inProgress"
              ? "◷"
              : "!",
        accent:
          turn.status === "completed"
            ? "green"
            : turn.status === "inProgress"
              ? "blue"
              : "rose",
      };
    })
    .slice(0, 6);

  if (runs.length === 0) {
    return [
      {
        title: locale === "zh" ? "暂无运行记录" : "No run history",
        meta: locale === "zh" ? "等待首次运行" : "Waiting for first run",
        description:
          locale === "zh"
            ? "点击立即运行后，会把请求和结果写入后端执行线程。"
            : "Run it once to write the request and result into the backend execution thread.",
        glyph: "◷",
        accent: "slate",
      },
    ];
  }

  return [
    {
      title: locale === "zh" ? "后端运行记录" : "Backend run history",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 次运行`
          : `${thread.turns.length} runs`,
      description:
        locale === "zh"
          ? "来自 app-server 线程的最近运行记录。"
          : "Recent runs loaded from the app-server thread.",
      section: true,
    },
    ...runs,
  ];
}

function agentItemSummary(item: ThreadItem, locale: Locale): string | null {
  if (item.type === "userMessage") {
    const withoutConfig = userMessageText(item).trim();
    if (!withoutConfig) {
      return null;
    }
    const lines = withoutConfig
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return compactOfficeMessageText(
      lines.slice(0, 8).join("\n") || withoutConfig,
    );
  }
  if (item.type === "agentMessage" && item.text.trim()) {
    return `${locale === "zh" ? "响应" : "Response"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "plan" && item.text.trim()) {
    return `${locale === "zh" ? "计划" : "Plan"}: ${compactOfficeMessageText(item.text)}`;
  }
  if (item.type === "commandExecution") {
    return `${locale === "zh" ? "命令" : "Command"}: ${item.command}\n${item.aggregatedOutput?.trim().slice(0, 600) || item.status}`;
  }
  if (item.type === "mcpToolCall") {
    return `${locale === "zh" ? "MCP 工具" : "MCP tool"}: ${item.server}.${item.tool} · ${item.status}`;
  }
  if (item.type === "dynamicToolCall") {
    return `${locale === "zh" ? "动态工具" : "Dynamic tool"}: ${item.namespace ? `${item.namespace}.` : ""}${item.tool} · ${item.status}`;
  }
  if (item.type === "collabAgentToolCall") {
    return `${locale === "zh" ? "协作调用" : "Collaboration"}: ${item.tool} · ${item.status}`;
  }
  if (item.type === "fileChange") {
    return `${locale === "zh" ? "文件改动" : "File changes"}: ${item.changes.length} · ${item.status}`;
  }
  return null;
}

function agentTurnDescription(
  turn: Turn,
  thread: Thread,
  locale: Locale,
): string {
  const summaries = turn.items
    .map((item) => agentItemSummary(item, locale))
    .filter((summary): summary is string => Boolean(summary));
  const summary = summaries.slice(0, 3).join("\n\n") || thread.preview || "";
  return summary.length > 420 ? `${summary.slice(0, 417)}...` : summary;
}

export function agentThreadHistoryItems(
  thread: Thread,
  locale: Locale,
): LibraryItem[] {
  const entries = [...thread.turns]
    .reverse()
    .map((turn, index): LibraryItem => {
      const statusLabel =
        locale === "zh"
          ? turn.status === "completed"
            ? "完成"
            : turn.status === "inProgress"
              ? "保存中"
              : turn.status === "interrupted"
                ? "已中断"
                : "失败"
          : turn.status === "completed"
            ? "Completed"
            : turn.status === "inProgress"
              ? "Saving"
              : turn.status === "interrupted"
                ? "Interrupted"
                : "Failed";

      return {
        title:
          locale === "zh"
            ? `配置记录 ${thread.turns.length - index}`
            : `Config record ${thread.turns.length - index}`,
        meta: [
          statusLabel,
          formatUnixSeconds(turn.completedAt ?? turn.startedAt, locale),
          automationTurnMetrics(turn, locale),
        ]
          .filter(Boolean)
          .join(" · "),
        description:
          agentTurnDescription(turn, thread, locale) ||
          (locale === "zh" ? "暂无配置摘要" : "No configuration summary yet"),
        glyph:
          turn.status === "completed"
            ? "✓"
            : turn.status === "inProgress"
              ? "◷"
              : "!",
        accent:
          turn.status === "completed"
            ? "green"
            : turn.status === "inProgress"
              ? "blue"
              : "rose",
      };
    })
    .slice(0, 5);

  if (entries.length === 0) {
    return [
      {
        title: locale === "zh" ? "暂无后端记录" : "No backend records",
        meta: locale === "zh" ? "等待首次保存" : "Waiting for first save",
        description:
          locale === "zh"
            ? "保存后，会把智能体的模型、权限、MCP、Skill 和系统提示词写入后端记录。"
            : "Save to write model, permissions, MCP, skills, and system prompt into the backend record.",
        glyph: "◷",
        accent: "slate",
      },
    ];
  }

  return [
    {
      title: locale === "zh" ? "后端记录" : "Backend records",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 次保存`
          : `${thread.turns.length} saves`,
      description:
        locale === "zh"
          ? "来自 app-server 智能体线程的最近后端记录。"
          : "Recent backend records loaded from the app-server agent thread.",
      section: true,
    },
    ...entries,
  ];
}

export function toolThreadHistoryItems(
  thread: Thread,
  locale: Locale,
): LibraryItem[] {
  const entries = automationRunHistoryItems(thread, locale).filter(
    (item) => !item.section,
  );
  if (entries.length === 0) {
    return toolEmptyHistoryItems(locale);
  }

  return [
    {
      title: locale === "zh" ? "后端调用记录" : "Backend call history",
      meta:
        locale === "zh"
          ? `${thread.turns.length} 条记录`
          : `${thread.turns.length} records`,
      description:
        locale === "zh"
          ? "来自工具验证线程的最近调用与资源读取记录。"
          : "Recent calls and resource reads from the tool verification thread.",
      section: true,
    },
    ...entries,
  ];
}

export function toolEmptyHistoryItems(locale: Locale): LibraryItem[] {
  return [
    {
      title: locale === "zh" ? "暂无调用记录" : "No call history",
      meta: locale === "zh" ? "等待首次调用" : "Waiting for first call",
      description:
        locale === "zh"
          ? "调用 MCP 工具或读取资源后，结果会写入后端工具验证线程。"
          : "Call an MCP tool or read a resource to write results into the backend tool verification thread.",
      glyph: "◷",
      accent: "slate",
    },
  ];
}

export function threadHistoryDemoRefreshBody(locale: Locale): string {
  return locale === "zh"
    ? "会话历史已刷新（演示）。连接 app-server 后会调用 thread/turns/list。"
    : "Session history refreshed (demo). With app-server connected this calls thread/turns/list.";
}

export function threadHistoryDemoRefreshPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadHistoryPanel(panel, {
    body: threadHistoryDemoRefreshBody(locale),
    error: undefined,
  });
}

export function threadHistoryRefreshInProgressBody(locale: Locale): string {
  return locale === "zh"
    ? "正在读取分页会话历史..."
    : "Reading paged session history...";
}

export function threadHistoryRefreshInProgressPanel(
  panel: CapabilityPanel | null,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadHistoryPanel(panel, {
    body: threadHistoryRefreshInProgressBody(locale),
    error: undefined,
  });
}

export function threadHistoryRefreshSuccessBody(
  turnCount: number,
  locale: Locale,
): string {
  return locale === "zh"
    ? `已通过 thread/turns/list 刷新 ${turnCount} 轮历史。`
    : `Refreshed ${turnCount} turns through thread/turns/list.`;
}

export function threadHistoryRefreshSuccessPanel(
  panel: CapabilityPanel | null,
  turnCount: number,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadHistoryPanel(panel, {
    body: threadHistoryRefreshSuccessBody(turnCount, locale),
    error: undefined,
  });
}

export function threadHistoryRefreshFailureMessage(
  error: unknown,
  locale: Locale,
): string {
  return error instanceof Error
    ? error.message
    : locale === "zh"
      ? "刷新会话历史失败"
      : "Unable to refresh session history";
}

export function threadHistoryRefreshFailurePanel(
  panel: CapabilityPanel | null,
  error: unknown,
  locale: Locale,
): CapabilityPanel | null {
  return patchThreadHistoryPanel(panel, {
    error: threadHistoryRefreshFailureMessage(error, locale),
  });
}

function patchThreadHistoryPanel(
  panel: CapabilityPanel | null,
  patch: Partial<CapabilityPanel>,
): CapabilityPanel | null {
  return panel
    ? {
        ...panel,
        ...patch,
      }
    : panel;
}
