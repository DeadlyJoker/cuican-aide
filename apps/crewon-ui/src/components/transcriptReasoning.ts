import type { ThreadItem } from "@crewon-protocol/v2/ThreadItem";

type ReasoningItem = Extract<ThreadItem, { type: "reasoning" }>;

const LOW_SIGNAL_REASONING_PREFIXES = new Set([
  "assessing",
  "checking",
  "comparing",
  "considering",
  "drafting",
  "evaluating",
  "inspecting",
  "detailing",
  "investigating",
  "loading",
  "looking",
  "noting",
  "opening",
  "outlining",
  "planning",
  "preparing",
  "reading",
  "reviewing",
  "running",
  "scanning",
  "searching",
  "summarizing",
  "testing",
  "tracing",
  "updating",
  "verifying",
]);

const LOW_SIGNAL_REASONING_EXACT = new Set([
  "thinking",
  "thinking...",
  "正在思考",
  "思考中",
  "准备中",
]);

function sanitizeReasoningLine(line: string): string {
  return line.replace(/\s*<!--\s*-->\s*$/u, "").trimEnd();
}

function normalizedReasoningLine(line: string): string {
  return line.replace(/<!--\s*-->/gu, "").replace(/\s+/gu, " ").trim();
}

function isLowSignalReasoningLine(line: string): boolean {
  const normalized = normalizedReasoningLine(line);
  if (!normalized) {
    return true;
  }

  if (LOW_SIGNAL_REASONING_EXACT.has(normalized.toLowerCase())) {
    return true;
  }

  if (/[.!?。！？:：；;]/u.test(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u);
  const firstWord = words[0]?.toLowerCase();
  return Boolean(
    firstWord && LOW_SIGNAL_REASONING_PREFIXES.has(firstWord),
  );
}

function cleanedReasoningLines(lines: string[]): string[] {
  return lines
    .map(sanitizeReasoningLine)
    .filter((line) => normalizedReasoningLine(line).length > 0);
}

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

export function hasDisplayableReasoning(item: ReasoningItem): boolean {
  return reasoningDisplayLines(item).length > 0;
}
