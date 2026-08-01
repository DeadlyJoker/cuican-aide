import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

const LOW_SIGNAL_REASONING_PREFIXES = new Set([
  "analyzing",
  "assessing",
  "checking",
  "collecting",
  "comparing",
  "compiling",
  "considering",
  "determining",
  "drafting",
  "evaluating",
  "examining",
  "exploring",
  "fetching",
  "filtering",
  "finding",
  "gathering",
  "identifying",
  "inspecting",
  "detailing",
  "investigating",
  "listing",
  "loading",
  "looking",
  "mapping",
  "noting",
  "opening",
  "outlining",
  "parsing",
  "planning",
  "polling",
  "preparing",
  "querying",
  "reading",
  "resolving",
  "reviewing",
  "running",
  "scanning",
  "searching",
  "selecting",
  "summarizing",
  "testing",
  "tracing",
  "updating",
  "validating",
  "verifying",
  "waiting",
  "writing",
]);

const LOW_SIGNAL_REASONING_EXACT = new Set([
  "thinking",
  "thinking...",
  "正在思考",
  "思考中",
  "准备中",
]);

function stripReasoningMarkup(line: string): string {
  let text = line.replace(/<!--\s*-->/gu, "");
  for (let pass = 0; pass < 3; pass += 1) {
    text = text
      .replace(/\*\*([^*]+)\*\*/gu, "$1")
      .replace(/\*([^*]+)\*/gu, "$1")
      .replace(/__([^_]+)__/gu, "$1")
      .replace(/_([^_]+)_/gu, "$1")
      .replace(/`([^`]+)`/gu, "$1");
  }
  return text.replace(/\s+/gu, " ").trim();
}

function sanitizeReasoningLine(line: string): string {
  return stripReasoningMarkup(line.replace(/\s*<!--\s*-->\s*$/u, ""));
}

function normalizedReasoningLine(line: string): string {
  return stripReasoningMarkup(line).toLowerCase();
}

export function isLowSignalReasoningLine(line: string): boolean {
  const normalized = normalizedReasoningLine(line);
  if (!normalized) {
    return true;
  }

  if (LOW_SIGNAL_REASONING_EXACT.has(normalized)) {
    return true;
  }

  // Real thinking sentences usually carry terminal punctuation. Ignore dots
  // inside filenames like ARCHITECTURE.md so breadcrumbs stay low-signal.
  if (
    /[.!?。！？](?:\s|$)/u.test(normalized) ||
    /[:：；;]/u.test(normalized)
  ) {
    return false;
  }

  const words = normalized.split(/\s+/u);
  const firstWord = words[0];
  if (firstWord && LOW_SIGNAL_REASONING_PREFIXES.has(firstWord)) {
    return true;
  }

  return Boolean(
    firstWord && words.length <= 8 && /^[a-z]+ing$/u.test(firstWord),
  );
}

function cleanedReasoningLines(lines: string[]): string[] {
  return lines
    .map(sanitizeReasoningLine)
    .filter((line) => normalizedReasoningLine(line).length > 0);
}

/** High-signal thinking only — used when a single reasoning item has real prose. */
export function reasoningDisplayLines(item: ReasoningItem): string[] {
  const contentLines = cleanedReasoningLines(item.content).filter(
    (line) => !isLowSignalReasoningLine(line),
  );
  if (contentLines.length > 0) {
    return contentLines;
  }

  return cleanedReasoningLines(item.summary).filter(
    (line) => !isLowSignalReasoningLine(line),
  );
}

/**
 * All cleaned process steps for a reasoning item, including short breadcrumbs.
 * Cursor/Codex still surface these as a collapsed "Thought · N steps" row.
 * Summary titles and content lines are merged (deduped) so neither is dropped.
 */
export function reasoningProcessLines(item: ReasoningItem): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of [
    ...cleanedReasoningLines(item.summary),
    ...cleanedReasoningLines(item.content),
  ]) {
    const key = normalizedReasoningLine(line);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

export function hasProcessReasoning(item: ReasoningItem): boolean {
  return reasoningProcessLines(item).length > 0;
}

export function hasDisplayableReasoning(item: ReasoningItem): boolean {
  return reasoningDisplayLines(item).length > 0;
}

/** Tool/action items that should dominate the process stream over reasoning. */
export function isActionProcessItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "webSearch":
    case "imageView":
    case "imageGeneration":
      return true;
    default:
      return false;
  }
}

export function aggregateReasoningItems(
  items: ReasoningItem[],
  id: string,
): ReasoningItem {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    for (const line of reasoningProcessLines(item)) {
      const key = normalizedReasoningLine(line);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      lines.push(line);
    }
  }

  return {
    type: "reasoning",
    id,
    summary: lines,
    content: [],
  };
}
