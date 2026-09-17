import {
  RunStoreError,
  type ModelHistoryAppend,
  type ThreadLocator,
} from "@crewon/application";
import type { ModelHistoryItem } from "@crewon/domain";
import {
  historyToolCallKey,
  validateModelHistoryIncrementalPairing,
  type ModelHistoryAppendState,
  type StoredHistoryToolCall,
} from "./model-history-append-validation.ts";
import { validateModelHistoryAppendShape } from "./store-invariants.ts";

type State = {
  lastSequence: number;
  pendingToolCallCount: number;
  /** Positive call sequence while pending, negative after its result commits. */
  calls: Map<string, number>;
};

/** Derived identities and sequence references; never copies historical tool bodies. */
export class InMemoryModelHistoryAppendIndex {
  readonly #states = new Map<string, State>();
  readonly #history: (threadId: string) => readonly ModelHistoryItem[];

  constructor(history: (threadId: string) => readonly ModelHistoryItem[]) {
    this.#history = history;
  }

  validate(
    append: ModelHistoryAppend,
    locator: ThreadLocator,
    itemIdExists: (itemId: string) => boolean,
  ): void {
    validateModelHistoryAppendShape(
      append,
      locator,
      this.state(locator, []).lastSequence,
      itemIdExists,
    );
    validateModelHistoryIncrementalPairing(
      append.items,
      this.state(locator, append.items),
    );
  }

  /** Reads only the head and tool identities referenced by this append. No lazy history scan. */
  state(
    locator: ThreadLocator,
    items: readonly ModelHistoryItem[],
  ): ModelHistoryAppendState {
    const history = this.#history(locator.threadId);
    const stored = this.#states.get(scope(locator));
    const lastSequence = stored?.lastSequence ?? 0;
    if (
      lastSequence !== history.length ||
      lastSequence !== (history.at(-1)?.sequence ?? 0)
    )
      throw new RunStoreError("model_history_append_state_stale");
    const referencedToolCalls = new Map<string, StoredHistoryToolCall>();
    for (const item of items) {
      if (item.type !== "tool_call" && item.type !== "tool_result") continue;
      const key = historyToolCallKey(item.runId, item.callId);
      if (referencedToolCalls.has(key)) continue;
      const sequence = stored?.calls.get(key);
      if (sequence === undefined) continue;
      const call = history[Math.abs(sequence) - 1];
      if (
        call?.type !== "tool_call" ||
        call.runId === null ||
        call.segmentId === null ||
        call.tenantId !== locator.tenantId ||
        call.threadId !== locator.threadId ||
        historyToolCallKey(call.runId, call.callId) !== key
      )
        throw new RunStoreError("model_history_append_state_invalid");
      referencedToolCalls.set(key, {
        runId: call.runId,
        callId: call.callId,
        segmentId: call.segmentId,
        kind: call.kind,
        completed: sequence < 0,
      });
    }
    return {
      lastSequence,
      pendingToolCallCount: stored?.pendingToolCallCount ?? 0,
      referencedToolCalls,
    };
  }

  /** Called only by the owner's synchronous append, after all commit validation succeeds. */
  committed(items: readonly ModelHistoryItem[]): void {
    if (items.length === 0) return;
    const key = scope(items[0]!);
    let state = this.#states.get(key);
    if (state === undefined) {
      state = { lastSequence: 0, pendingToolCallCount: 0, calls: new Map() };
      this.#states.set(key, state);
    }
    for (const item of items) {
      if (item.type === "tool_call") {
        state.calls.set(
          historyToolCallKey(item.runId, item.callId),
          item.sequence,
        );
        state.pendingToolCallCount++;
      } else if (item.type === "tool_result") {
        const callKey = historyToolCallKey(item.runId, item.callId);
        state.calls.set(callKey, -state.calls.get(callKey)!);
        state.pendingToolCallCount--;
      }
      state.lastSequence = item.sequence;
    }
  }
}

function scope(locator: ThreadLocator): string {
  return JSON.stringify([locator.tenantId, locator.threadId]);
}
