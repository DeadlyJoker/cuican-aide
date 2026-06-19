import type { Thread } from "@crewon-protocol/v2/Thread";

import type { Locale } from "../i18n";
import type { OfficeMessage, OfficeWorkspace } from "../domain/crewonDomain";
import {
  compactOfficeMessageText,
  threadTitle,
  userMessageText,
} from "../thread/threadModel";

function officeMessageTime(
  timestamp: number | null | undefined,
  locale: Locale,
): string {
  if (!timestamp) {
    return locale === "zh" ? "刚刚" : "now";
  }
  return new Date(timestamp * 1000).toLocaleString(
    locale === "zh" ? "zh-CN" : "en-US",
    {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    },
  );
}

function userOfficeMessageText(text: string, locale: Locale): string {
  const withoutConfig = text.trim();
  const zhPrefixMatch = withoutConfig.match(
    /^办公室「.*」群聊消息：([\s\S]*)$/,
  );
  if (zhPrefixMatch?.[1]) {
    return compactOfficeMessageText(zhPrefixMatch[1]);
  }
  const enPrefixMatch = withoutConfig.match(
    /^Office ".*" group chat message: ([\s\S]*)$/,
  );
  if (enPrefixMatch?.[1]) {
    return compactOfficeMessageText(enPrefixMatch[1]);
  }
  if (
    withoutConfig.startsWith(
      locale === "zh" ? "绑定办公室：" : "Bind office:",
    ) ||
    withoutConfig.startsWith(
      locale === "zh" ? "创建办公室：" : "Create office:",
    )
  ) {
    return "";
  }
  return compactOfficeMessageText(withoutConfig);
}

export function officeMessagesFromThread(
  thread: Thread,
  locale: Locale,
): OfficeMessage[] {
  const messages: OfficeMessage[] = [];
  for (const turn of thread.turns) {
    const time = officeMessageTime(turn.completedAt ?? turn.startedAt, locale);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        const text = userOfficeMessageText(userMessageText(item), locale);
        if (text) {
          messages.push({
            author: locale === "zh" ? "你" : "You",
            glyph: "@",
            accent: "blue",
            time,
            text,
          });
        }
        continue;
      }
      if (item.type === "agentMessage" && item.text.trim()) {
        messages.push({
          author: locale === "zh" ? "Crewon" : "Crewon",
          glyph: "C",
          accent: "green",
          time,
          text: compactOfficeMessageText(item.text),
        });
        continue;
      }
      if (item.type === "plan" && item.text.trim()) {
        messages.push({
          author: locale === "zh" ? "计划" : "Plan",
          glyph: "✓",
          accent: "violet",
          time,
          text: compactOfficeMessageText(item.text),
          kind: "task",
        });
        continue;
      }
      if (item.type === "commandExecution") {
        messages.push({
          author: locale === "zh" ? "终端" : "Terminal",
          glyph: "$",
          accent: item.exitCode === 0 ? "green" : "amber",
          time,
          text: compactOfficeMessageText(
            [
              item.command,
              item.aggregatedOutput
                ? item.aggregatedOutput.slice(0, 800)
                : item.status,
            ].join("\n"),
          ),
          kind: "task",
        });
        continue;
      }
      if (item.type === "collabAgentToolCall") {
        messages.push({
          author: locale === "zh" ? "智能体协作" : "Agent collaboration",
          glyph: "A",
          accent: "cyan",
          time,
          text: compactOfficeMessageText(
            [
              `${locale === "zh" ? "工具" : "Tool"}: ${item.tool}`,
              `${locale === "zh" ? "状态" : "Status"}: ${item.status}`,
              item.prompt ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
          kind: "task",
        });
      }
    }
  }
  return messages;
}

export function mergeOfficeMessages(
  baseMessages: OfficeMessage[],
  backendMessages: OfficeMessage[],
): OfficeMessage[] {
  const seen = new Set(
    baseMessages.map(
      (message) =>
        `${message.kind ?? "message"}:${message.author}:${message.text}`,
    ),
  );
  const merged = [...baseMessages];
  for (const message of backendMessages) {
    const key = `${message.kind ?? "message"}:${message.author}:${message.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

export function workspaceFromBackendThread(
  thread: Thread,
  locale: Locale,
): OfficeWorkspace {
  const title = threadTitle(thread, locale === "zh" ? "办公室" : "Office");
  return {
    goal:
      thread.preview ||
      (locale === "zh"
        ? `围绕「${title}」进行多智能体协作。`
        : `Coordinate multi-agent work for "${title}".`),
    threadId: thread.id,
    backendStatus: "connected",
    members: [
      {
        name: locale === "zh" ? "协调者" : "Coordinator",
        role: locale === "zh" ? "办公室调度" : "Office coordination",
        glyph: "@",
        accent: "blue",
        status: locale === "zh" ? "已连接后端线程" : "Backend thread connected",
        online: true,
      },
    ],
    messages: [
      {
        author: locale === "zh" ? "系统" : "System",
        glyph: "⌗",
        accent: "slate",
        time: locale === "zh" ? "刚刚" : "now",
        kind: "system",
        text:
          locale === "zh"
            ? `已连接办公室后端会话：${title}`
            : `Connected office backend session: ${title}`,
      },
      ...officeMessagesFromThread(thread, locale),
    ],
    tasks: [],
  };
}

export function newBackendOfficeWorkspace(
  title: string,
  threadId: string,
  locale: Locale,
): OfficeWorkspace {
  const goal =
    locale === "zh"
      ? `围绕「${title}」进行多智能体协作，沉淀任务、审批和交付物。`
      : `Coordinate multi-agent work for "${title}", keeping tasks, approvals, and artifacts.`;
  return {
    goal,
    threadId,
    backendStatus: "connected",
    members: [
      {
        name: locale === "zh" ? "协调者" : "Coordinator",
        role: locale === "zh" ? "办公室调度" : "Office coordination",
        glyph: "@",
        accent: "blue",
        status: locale === "zh" ? "已绑定后端线程" : "Backend thread bound",
        online: true,
      },
    ],
    messages: [
      {
        author: locale === "zh" ? "系统" : "System",
        glyph: "⌗",
        accent: "blue",
        time: locale === "zh" ? "现在" : "now",
        kind: "system",
        text:
          locale === "zh"
            ? "办公室已创建，并绑定到真实 app-server 线程。"
            : "Office created and bound to a real app-server thread.",
      },
    ],
    tasks: [
      {
        title: locale === "zh" ? "招募智能体" : "Recruit agents",
        owner: locale === "zh" ? "协调者" : "Coordinator",
        status: "todo",
      },
    ],
  };
}
