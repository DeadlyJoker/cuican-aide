import { createHash, randomUUID } from "node:crypto";
import {
  RunStoreError,
  type ModelHistoryContextCheckpoint,
  type ModelHistoryContextProgress,
  type ModelHistoryContextState,
  type ModelHistoryContextStore,
  type ThreadLocator,
} from "@crewon/application";
import {
  isModelHistoryInstructionBoundary,
  validateModelHistoryItem,
  type ModelHistoryItem,
} from "@crewon/domain";
import {
  stableJson,
  validateModelHistoryPage,
  validateThreadLocator,
} from "./store-invariants.ts";

type State = {
  through: number;
  fingerprint: string;
  lastDigest: string | null;
  latestRollback: number | null;
  active: number[];
  instructions: number[];
  compactions: number[];
  content: number[];
};
type ContentItem = Exclude<
  ModelHistoryItem,
  { type: "compaction" | "rollback" }
>;

/** Sequence references only. The owner supplies immutable canonical items without cloning history. */
export class InMemoryModelHistoryContextStore
  implements ModelHistoryContextStore
{
  readonly #loadHistory: (
    locator: ThreadLocator,
  ) => readonly ModelHistoryItem[] | null;
  readonly #states = new Map<string, State>();

  constructor(
    loadHistory: (locator: ThreadLocator) => readonly ModelHistoryItem[] | null,
  ) {
    this.#loadHistory = loadHistory;
  }

  async prepare(locator: ThreadLocator): Promise<ModelHistoryContextProgress> {
    validateThreadLocator(locator);
    const history = this.#loadHistory(locator);
    if (history === null) throw new RunStoreError("model_history_not_found");
    const key = stableJson([locator.tenantId, locator.threadId]);
    let state = this.#states.get(key);
    if (
      state !== undefined &&
      (state.through > history.length ||
        (state.through > 0 &&
          hash(stableJson(history[state.through - 1])) !== state.lastDigest))
    ) {
      this.#states.delete(key);
      state = undefined;
    }
    state ??= {
      through: 0,
      fingerprint: hash(
        stableJson(["crewon.context-index.v1", key, randomUUID()]),
      ),
      lastDigest: null,
      latestRollback: null,
      active: [],
      instructions: [],
      compactions: [],
      content: [],
    };
    try {
      const through = Math.min(history.length, state.through + 100);
      while (state.through < through) {
        const item = history[state.through]!;
        validateModelHistoryItem(item);
        if (
          item.tenantId !== locator.tenantId ||
          item.threadId !== locator.threadId ||
          item.sequence !== state.through + 1
        )
          invalid();
        if (item.type === "rollback") applyRollback(state, history, item);
        else {
          state.active.push(item.sequence);
          if (isModelHistoryInstructionBoundary(item))
            state.instructions.push(item.sequence);
          if (item.type === "compaction") state.compactions.push(item.sequence);
          else state.content.push(item.sequence);
        }
        const digest = hash(stableJson(item));
        state.through = item.sequence;
        state.fingerprint = hash(
          `${state.fingerprint}\n${item.sequence}\n${digest}`,
        );
        state.lastDigest = digest;
      }
      this.#states.set(key, state);
      return {
        processedThroughSequence: state.through,
        targetSequence: history.length,
        context:
          state.through === history.length
            ? contextState(state, history)
            : null,
      };
    } catch (error) {
      // Only derived state is discarded; canonical authority is never mutated here.
      this.#states.delete(key);
      throw error;
    }
  }

  async listItems(
    locator: ThreadLocator,
    checkpoint: ModelHistoryContextCheckpoint,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ContentItem[]> {
    validateModelHistoryPage(locator, afterSequence, limit);
    if (limit > 100)
      throw new RunStoreError("model_history_context_page_limit_invalid");
    const history = this.#loadHistory(locator);
    const state = this.#states.get(
      stableJson([locator.tenantId, locator.threadId]),
    );
    if (
      history === null ||
      state === undefined ||
      state.through !== history.length ||
      state.through !== checkpoint.throughHistorySequence ||
      state.fingerprint !== checkpoint.fingerprint ||
      (state.through > 0 &&
        hash(stableJson(history[state.through - 1])) !== state.lastDigest)
    ) {
      throw new RunStoreError("model_history_context_changed");
    }
    const cursor = Math.max(
      afterSequence,
      lastCompaction(state, history)?.replacesThroughSequence ?? 0,
    );
    let start = lowerBound(state.content, cursor);
    if (state.content[start] === cursor) start += 1;
    return structuredClone(
      state.content
        .slice(start, start + limit)
        .map((sequence) => history[sequence - 1]!),
    ) as ContentItem[];
  }
}

function applyRollback(
  state: State,
  history: readonly ModelHistoryItem[],
  marker: Extract<ModelHistoryItem, { type: "rollback" }>,
): void {
  const removed = Math.min(marker.requestedTurns, state.instructions.length);
  let cut =
    removed === 0
      ? null
      : state.instructions[state.instructions.length - removed]!;
  if (cut !== null) {
    let index = lowerBound(state.active, cut);
    const firstInstruction = lowerBound(state.active, state.instructions[0]!);
    while (index > firstInstruction) {
      const previous = history[state.active[index - 1]! - 1]!;
      if (
        previous.type !== "message" ||
        previous.role !== "user" ||
        (previous.source !== "goal_continuation" &&
          previous.source !== "goal_steering")
      )
        break;
      index -= 1;
    }
    cut = state.active[index]!;
  }
  if (
    marker.removedTurns !== removed ||
    marker.historyFromSequence !== cut ||
    marker.historyThroughSequence !== marker.sequence - 1
  ) {
    throw new RunStoreError("model_history_rollback_boundary_mismatch");
  }
  if (cut !== null) {
    for (const list of [
      state.active,
      state.instructions,
      state.compactions,
      state.content,
    ])
      list.length = lowerBound(list, cut);
  }
  state.latestRollback = marker.sequence;
}

function contextState(
  state: State,
  history: readonly ModelHistoryItem[],
): ModelHistoryContextState {
  const latestRollback =
    state.latestRollback === null ? null : history[state.latestRollback - 1]!;
  if (latestRollback !== null && latestRollback.type !== "rollback") invalid();
  return structuredClone({
    checkpoint: {
      throughHistorySequence: state.through,
      fingerprint: state.fingerprint,
    },
    lastItem: history[state.through - 1] ?? null,
    lastCompaction: lastCompaction(state, history),
    latestRollback:
      latestRollback as ModelHistoryContextState["latestRollback"],
  });
}

function lastCompaction(
  state: State,
  history: readonly ModelHistoryItem[],
): ModelHistoryContextState["lastCompaction"] {
  const sequence = state.compactions.at(-1);
  if (sequence === undefined) return null;
  const item = history[sequence - 1]!;
  if (item.type !== "compaction") invalid();
  return item as ModelHistoryContextState["lastCompaction"];
}

function lowerBound(values: readonly number[], needle: number): number {
  let start = 0;
  let end = values.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (values[middle]! < needle) start = middle + 1;
    else end = middle;
  }
  return start;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function invalid(): never {
  throw new RunStoreError("model_history_context_invalid");
}
