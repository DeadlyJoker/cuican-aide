import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";

import type { Locale } from "../lib/i18n";

type DynamicToolCall = Extract<ThreadItem, { type: "dynamicToolCall" }>;

const LOCAL_WORKSPACE_TOOL_NAMES = new Set([
  "git_status",
  "list_files",
  "read_file",
  "run_ui_test",
]);

function normalizedDynamicToolName(item: DynamicToolCall): string {
  return [item.namespace, item.tool].filter(Boolean).join(" ").toLowerCase();
}

export function isLocalWorkspaceDynamicTool(item: DynamicToolCall): boolean {
  if (
    item.namespace === "workspace" &&
    LOCAL_WORKSPACE_TOOL_NAMES.has(item.tool)
  ) {
    return true;
  }
  return item.tool.startsWith("mcp__workspace_checks__");
}

export function dynamicToolDisplayName(
  item: DynamicToolCall,
  locale: Locale,
): string {
  const rawName = item.tool.startsWith("mcp__workspace_checks__")
    ? item.tool.slice("mcp__workspace_checks__".length)
    : item.tool;
  if (!isLocalWorkspaceDynamicTool(item)) {
    return item.namespace ? `${item.namespace}.${item.tool}` : item.tool;
  }
  const labels: Record<string, readonly [zh: string, en: string]> = {
    git_status: ["检查 Git 状态", "Check Git status"],
    list_files: ["浏览工作区目录", "List workspace files"],
    read_file: ["读取工作区文件", "Read workspace file"],
    run_ui_test: ["运行界面回归", "Run UI regression"],
  };
  const label = labels[rawName];
  return label?.[locale === "zh" ? 0 : 1] ?? rawName;
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
