import {
  RunStoreError,
  type ModelHistoryAppend,
  type ThreadLocator,
} from "@crewon/application";
import type { ModelHistoryItem } from "@crewon/domain";
import { validateModelHistoryAppendShape } from "./store-invariants.ts";

export type StoredHistoryToolCall = Readonly<{
  runId: string;
  callId: string;
  segmentId: string;
  kind: "function" | "custom";
  completed: boolean;
}>;

export type ModelHistoryAppendState = Readonly<{
  lastSequence: number;
  pendingToolCallCount: number;
  /** Only identities referenced by this append, never the complete tool ledger. */
  referencedToolCalls: ReadonlyMap<string, StoredHistoryToolCall>;
}>;

export function historyToolCallKey(
  runId: string | null,
  callId: string,
): string {
  return JSON.stringify([runId, callId]);
}

/** Validates an append against durable scalar state and exact indexed tool lookups. */
export function validateModelHistoryIncrementalAppend(
  append: ModelHistoryAppend,
  locator: ThreadLocator,
  state: ModelHistoryAppendState,
  itemIdExists: (itemId: string) => boolean,
): number {
  validateModelHistoryAppendShape(
    append,
    locator,
    state.lastSequence,
    itemIdExists,
  );
  return validateModelHistoryIncrementalPairing(append.items, state);
}

/** Pairing half for adapters that validated shape before looking up tool identities. */
export function validateModelHistoryIncrementalPairing(
  items: readonly ModelHistoryItem[],
  state: ModelHistoryAppendState,
): number {
  if (
    !Number.isSafeInteger(state.pendingToolCallCount) ||
    state.pendingToolCallCount < 0
  ) {
    throw new RunStoreError("model_history_append_state_invalid");
  }
  let pendingCount = state.pendingToolCallCount;
  const newCalls = new Map<
    string,
    Extract<ModelHistoryItem, { type: "tool_call" }>
  >();
  const completed = new Set<string>();
  for (const item of items) {
    if (item.type === "tool_call") {
      const key = historyToolCallKey(item.runId, item.callId);
      if (newCalls.has(key) || state.referencedToolCalls.has(key)) {
        throw new RunStoreError("model_history_tool_call_duplicate");
      }
      newCalls.set(key, item);
      pendingCount += 1;
      if (!Number.isSafeInteger(pendingCount))
        throw new RunStoreError("model_history_append_state_invalid");
    } else if (item.type === "tool_result") {
      const key = historyToolCallKey(item.runId, item.callId);
      const existing = state.referencedToolCalls.get(key);
      const call = newCalls.get(key) ?? existing;
      if (
        call === undefined ||
        completed.has(key) ||
        existing?.completed === true ||
        call.kind !== item.kind ||
        call.segmentId !== item.segmentId
      ) {
        throw new RunStoreError("model_history_tool_result_orphaned");
      }
      pendingCount -= 1;
      if (pendingCount < 0)
        throw new RunStoreError("model_history_append_state_invalid");
      completed.add(key);
    } else if (pendingCount > 0) {
      throw new RunStoreError("model_history_tool_result_missing");
    }
  }
  return pendingCount;
}
