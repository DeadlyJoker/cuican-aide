import {
  projectEffectiveModelHistory,
  type ModelHistoryItem,
} from "@crewon/domain";

import {
  ContextHistoryError,
  normalizeContextHistoryEntries,
  type ContextHistoryItem,
  type ContextHistoryRepair,
  type ContextProjectionEntry,
} from "./normalize-context-history.ts";

export const CONTEXT_COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export type ModelContextProjection = Readonly<{
  items: readonly ContextHistoryItem[];
  sourceSequences: readonly number[];
  revision: string;
  historyRewritten: boolean;
  repairs: readonly ContextHistoryRepair[];
  throughHistorySequence: number;
  compactedThroughSequence: number | null;
  byteLength: number;
}>;

/** Builds the model-visible view while keeping canonical Model History append-only. */
export function projectModelHistory(
  history: readonly ModelHistoryItem[],
  options: Readonly<{ maxItems?: number; maxBytes?: number }> = {},
): ModelContextProjection {
  validateHistorySequence(history);
  const effective = projectEffectiveModelHistory(history);
  let lastCompactionIndex = -1;
  for (const [index, item] of effective.items.entries()) {
    if (item.type === "compaction") {
      lastCompactionIndex = index;
    }
  }
  const lastCompaction =
    lastCompactionIndex < 0 ? null : effective.items[lastCompactionIndex];
  if (lastCompaction !== null && lastCompaction.type !== "compaction") {
    throw new ContextHistoryError("context_compaction_projection_invalid");
  }

  const entries: ContextProjectionEntry[] = [];
  if (lastCompaction?.type === "compaction") {
    for (const retained of lastCompaction.retainedUserMessages) {
      entries.push({
        sourceSequence: lastCompaction.sequence,
        item: { type: "message", role: "user", content: retained.content },
      });
    }
    entries.push({
      sourceSequence: lastCompaction.sequence,
      item: {
        type: "message",
        role: "user",
        content: `${CONTEXT_COMPACTION_SUMMARY_PREFIX}\n${lastCompaction.summary}`,
      },
    });
  }

  for (const item of effective.items) {
    if (
      lastCompaction?.type === "compaction" &&
      item.sequence <= lastCompaction.replacesThroughSequence
    ) {
      continue;
    }
    if (item === lastCompaction) {
      continue;
    }
    if (item.type === "compaction") {
      continue;
    }
    entries.push({ sourceSequence: item.sequence, item: projectItem(item) });
  }
  const normalized = normalizeContextHistoryEntries(entries, options);
  const latestRewrite =
    lastCompaction?.type === "compaction" &&
    (effective.latestRollback === null ||
      lastCompaction.sequence > effective.latestRollback.sequence)
      ? lastCompaction
      : effective.latestRollback;
  return {
    ...normalized,
    revision: latestRewrite?.itemId ?? "canonical",
    historyRewritten: latestRewrite !== null || normalized.historyRewritten,
    throughHistorySequence: effective.throughHistorySequence,
    compactedThroughSequence:
      lastCompaction?.type === "compaction"
        ? lastCompaction.replacesThroughSequence
        : null,
  };
}

export function projectedContinuationStart(
  projection: ModelContextProjection,
  input: Readonly<{
    contextRevision: string;
    throughHistorySequence: number;
  }>,
): number | null {
  if (
    input.contextRevision !== projection.revision ||
    !Number.isSafeInteger(input.throughHistorySequence) ||
    input.throughHistorySequence < 1
  ) {
    return null;
  }
  let boundaryIndex = -1;
  for (const [index, sequence] of projection.sourceSequences.entries()) {
    if (sequence <= input.throughHistorySequence) {
      boundaryIndex = index;
    }
  }
  const boundary = projection.items[boundaryIndex];
  const start = boundaryIndex + 1;
  return boundary?.type === "message" && boundary.role === "assistant"
    ? start
    : null;
}

function validateHistorySequence(history: readonly ModelHistoryItem[]): void {
  if (history.length === 0) {
    throw new ContextHistoryError("context_history_empty");
  }
  for (const [index, item] of history.entries()) {
    if (item.sequence !== index + 1) {
      throw new ContextHistoryError("context_history_sequence_gap");
    }
  }
}

function projectItem(
  item: Exclude<ModelHistoryItem, { type: "compaction" | "rollback" }>,
): ContextHistoryItem {
  switch (item.type) {
    case "message":
      if (item.role === "tool") {
        throw new ContextHistoryError("legacy_tool_message_unsupported");
      }
      return { type: "message", role: item.role, content: item.content };
    case "tool_call":
      return {
        type: "tool_call",
        kind: item.kind,
        callId: item.callId,
        name: item.name,
        input: item.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        kind: item.kind,
        callId: item.callId,
        output: item.output,
      };
  }
}
