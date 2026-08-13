import type { ThreadItem } from "@crewon-ui-model/v2/ThreadItem";

import type { Locale } from "../lib/i18n";

type DynamicToolCall = Extract<ThreadItem, { type: "dynamicToolCall" }>;

function normalizedDynamicToolName(item: DynamicToolCall): string {
  return [item.namespace, item.tool].filter(Boolean).join(" ").toLowerCase();
}

export function dynamicToolKindLabel(
  item: DynamicToolCall,
  locale: Locale,
): string {
  const normalized = normalizedDynamicToolName(item);
  if (normalized.includes("skill")) {
    return "Skill";
  }

  return locale === "zh" ? "工具" : "Tool";
}

export function transcriptToolRoleLabel(
  item: ThreadItem,
  locale: Locale,
): string | null {
  switch (item.type) {
    case "mcpToolCall":
      return "MCP";
    case "dynamicToolCall":
      return dynamicToolKindLabel(item, locale);
    case "collabAgentToolCall":
      return locale === "zh" ? "协作 Agent" : "Agent";
    case "subAgentActivity":
      return locale === "zh" ? "子 Agent" : "Subagent";
    default:
      return null;
  }
}

export function transcriptProcessBucketLabel(
  item: ThreadItem,
  locale: Locale,
): string {
  const toolLabel = transcriptToolRoleLabel(item, locale);
  if (toolLabel) {
    return toolLabel;
  }

  switch (item.type) {
    case "reasoning":
      return locale === "zh" ? "推理" : "reasoning";
    case "commandExecution":
      return locale === "zh" ? "命令" : "commands";
    case "fileChange":
      return locale === "zh" ? "文件" : "files";
    default:
      return locale === "zh" ? "过程" : "steps";
  }
}
