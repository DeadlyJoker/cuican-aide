import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { UserInput } from "@crewon/app-server-protocol/v2/UserInput";
import type { Locale } from "../i18n";

export function slugifySkillName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace-skill"
  );
}

export function appMentionSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

export function promptPreview(text: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  return normalizedText.length > 72
    ? `${normalizedText.slice(0, 69)}...`
    : normalizedText;
}

export function userInputToText(input: UserInput[], locale: Locale): string {
  return input
    .map((item) => {
      switch (item.type) {
        case "text":
          return item.text;
        case "image":
          return locale === "zh" ? "图片" : "Image";
        case "localImage":
          return item.path;
        case "skill":
          return `@${item.name}`;
        case "mention":
          return item.path;
      }
    })
    .join("\n");
}

export function itemPreview(item: ThreadItem, locale: Locale): string {
  switch (item.type) {
    case "userMessage":
      return userInputToText(item.content, locale);
    case "agentMessage":
      return item.text;
    case "reasoning":
      return [...item.summary, ...item.content].join("\n");
    case "commandExecution":
      return item.aggregatedOutput ?? item.command;
    case "fileChange":
      return locale === "zh"
        ? `${item.changes.length} 个文件变更`
        : `${item.changes.length} file change${item.changes.length === 1 ? "" : "s"}`;
    case "mcpToolCall":
      return `${item.server}.${item.tool}`;
    case "dynamicToolCall":
      return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
    case "plan":
      return item.text;
    case "webSearch":
      return item.query;
    case "imageView":
      return item.path;
    case "imageGeneration":
      return item.revisedPrompt ?? item.result;
    case "hookPrompt":
      return locale === "zh" ? "Hook 提示" : "Hook prompt";
    case "collabAgentToolCall":
      return item.prompt ?? item.tool;
    case "subAgentActivity":
      return item.agentPath;
    case "enteredReviewMode":
    case "exitedReviewMode":
      return item.review;
    case "contextCompaction":
      return locale === "zh" ? "上下文已压缩" : "Context compacted";
  }
}

export function formatRelativeTime(
  epochSeconds: number,
  locale: Locale,
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000 - epochSeconds),
  );

  if (elapsedSeconds < 60) {
    return locale === "zh" ? "刚刚" : "now";
  }

  if (elapsedSeconds < 3600) {
    const minutes = Math.floor(elapsedSeconds / 60);
    return locale === "zh" ? `${minutes} 分钟前` : `${minutes}m`;
  }

  if (elapsedSeconds < 86400) {
    const hours = Math.floor(elapsedSeconds / 3600);
    return locale === "zh" ? `${hours} 小时前` : `${hours}h`;
  }

  const days = Math.floor(elapsedSeconds / 86400);
  return locale === "zh" ? `${days} 天前` : `${days}d`;
}

export function formatThreadTimestamp(
  epochSeconds: number,
  locale: Locale,
): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(epochSeconds * 1000));
}
