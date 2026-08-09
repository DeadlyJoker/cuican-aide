import {
  MAX_MODEL_HISTORY_ROLLBACK_TURNS,
  ModelHistoryError,
  validateModelHistoryItem,
  type ModelHistoryItem,
} from "./model-history.ts";
import {
  validateThreadLifecycleEvent,
  type ThreadLifecycleEvent,
} from "./thread-lifecycle.ts";

export type ModelHistoryRollbackMarker = Extract<
  ModelHistoryItem,
  { type: "rollback" }
>;
export type EffectiveModelHistoryItem = Exclude<
  ModelHistoryItem,
  { type: "rollback" }
>;

export type ThreadRollbackBoundary = Readonly<{
  requestedTurns: number;
  removedTurns: number;
  historyFromSequence: number | null;
  historyThroughSequence: number;
  markerHistorySequence: number;
}>;

export type EffectiveModelHistory = Readonly<{
  items: readonly EffectiveModelHistoryItem[];
  rollbackMarkers: readonly ModelHistoryRollbackMarker[];
  latestRollback: ModelHistoryRollbackMarker | null;
  throughHistorySequence: number;
}>;

export type ThreadRollbackArtifacts = Readonly<{
  boundary: ThreadRollbackBoundary;
  marker: ModelHistoryRollbackMarker;
  event: Extract<ThreadLifecycleEvent, { type: "thread.rolled_back" }>;
}>;

export type CreateThreadRollbackInput = Readonly<{
  tenantId: string;
  threadId: string;
  actorId: string;
  rollbackId: string;
  markerItemId: string;
  threadEventId: string;
  threadEventSequence: number;
  occurredAt: string;
  requestedTurns: number;
}>;

/** Derives an append-only rollback boundary from canonical history. */
export function planModelHistoryRollback(
  history: readonly ModelHistoryItem[],
  requestedTurns: number,
): ThreadRollbackBoundary {
  const replayed = replayEffectiveHistory(history);
  return planFromEffectiveItems(
    replayed.items,
    requestedTurns,
    replayed.throughHistorySequence,
  );
}

/**
 * Creates the correlated marker/event pair without accepting caller-provided boundary fields.
 * Stores must persist both artifacts atomically after their own authorization and CAS checks.
 */
export function createThreadRollbackArtifacts(
  history: readonly ModelHistoryItem[],
  input: CreateThreadRollbackInput,
): ThreadRollbackArtifacts {
  const boundary = planModelHistoryRollback(history, input.requestedTurns);
  const first = history[0];
  if (
    first !== undefined &&
    (first.tenantId !== input.tenantId || first.threadId !== input.threadId)
  ) {
    throw new ModelHistoryError("model_history_rollback_identity_mismatch");
  }
  const marker: ModelHistoryRollbackMarker = {
    schemaVersion: "crewon.model-history-item.v0",
    type: "rollback",
    itemId: input.markerItemId,
    tenantId: input.tenantId,
    threadId: input.threadId,
    sequence: boundary.markerHistorySequence,
    runId: null,
    segmentId: null,
    createdAt: input.occurredAt,
    rollbackId: input.rollbackId,
    threadEventId: input.threadEventId,
    requestedTurns: boundary.requestedTurns,
    removedTurns: boundary.removedTurns,
    historyFromSequence: boundary.historyFromSequence,
    historyThroughSequence: boundary.historyThroughSequence,
  };
  const event: Extract<ThreadLifecycleEvent, { type: "thread.rolled_back" }> = {
    schemaVersion: "crewon.thread-event.v0",
    type: "thread.rolled_back",
    identity: { threadId: input.threadId },
    eventId: input.threadEventId,
    sequence: input.threadEventSequence,
    occurredAt: input.occurredAt,
    data: {
      actorId: input.actorId,
      rollbackId: input.rollbackId,
      markerItemId: input.markerItemId,
      ...boundary,
    },
  };
  const artifacts = { boundary, marker, event };
  validateThreadRollbackArtifacts(history, artifacts);
  return artifacts;
}

/** Validates persisted correlation and recomputes the boundary from the pre-marker history. */
export function validateThreadRollbackArtifacts(
  historyBeforeMarker: readonly ModelHistoryItem[],
  artifacts: ThreadRollbackArtifacts,
): void {
  const { boundary, marker, event } = artifacts;
  validateModelHistoryItem(marker);
  validateThreadLifecycleEvent(event);
  const expected = planModelHistoryRollback(
    historyBeforeMarker,
    marker.requestedTurns,
  );
  if (
    !sameBoundary(boundary, expected) ||
    marker.sequence !== expected.markerHistorySequence ||
    marker.removedTurns !== expected.removedTurns ||
    marker.historyFromSequence !== expected.historyFromSequence ||
    marker.historyThroughSequence !== expected.historyThroughSequence ||
    marker.threadId !== event.identity.threadId ||
    marker.threadEventId !== event.eventId ||
    marker.createdAt !== event.occurredAt ||
    marker.rollbackId !== event.data.rollbackId ||
    marker.itemId !== event.data.markerItemId ||
    event.data.requestedTurns !== expected.requestedTurns ||
    event.data.removedTurns !== expected.removedTurns ||
    event.data.historyFromSequence !== expected.historyFromSequence ||
    event.data.historyThroughSequence !== expected.historyThroughSequence ||
    event.data.markerHistorySequence !== expected.markerHistorySequence
  ) {
    throw new ModelHistoryError("model_history_rollback_boundary_mismatch");
  }
  const first = historyBeforeMarker[0];
  if (
    first !== undefined &&
    (marker.tenantId !== first.tenantId || marker.threadId !== first.threadId)
  ) {
    throw new ModelHistoryError("model_history_rollback_identity_mismatch");
  }
  replayEffectiveHistory([...historyBeforeMarker, marker]);
}

/** Projects canonical history through every durable rollback tombstone. */
export function projectEffectiveModelHistory(
  history: readonly ModelHistoryItem[],
): EffectiveModelHistory {
  return replayEffectiveHistory(history);
}

export function isHistorySequenceRolledBack(
  boundary: ThreadRollbackBoundary,
  sequence: number,
): boolean {
  return (
    boundary.historyFromSequence !== null &&
    sequence >= boundary.historyFromSequence &&
    sequence <= boundary.historyThroughSequence
  );
}

function replayEffectiveHistory(
  history: readonly ModelHistoryItem[],
): EffectiveModelHistory {
  validateRawHistory(history);
  let items: EffectiveModelHistoryItem[] = [];
  const rollbackMarkers: ModelHistoryRollbackMarker[] = [];
  for (const item of history) {
    if (item.type !== "rollback") {
      items.push(item);
      continue;
    }
    const expected = planFromEffectiveItems(
      items,
      item.requestedTurns,
      item.historyThroughSequence,
    );
    if (
      item.removedTurns !== expected.removedTurns ||
      item.historyFromSequence !== expected.historyFromSequence ||
      item.sequence !== expected.markerHistorySequence
    ) {
      throw new ModelHistoryError("model_history_rollback_boundary_mismatch");
    }
    if (expected.historyFromSequence !== null) {
      items = items.filter(
        ({ sequence }) => sequence < expected.historyFromSequence!,
      );
    }
    rollbackMarkers.push(item);
  }
  return {
    items,
    rollbackMarkers,
    latestRollback: rollbackMarkers.at(-1) ?? null,
    throughHistorySequence: history.at(-1)?.sequence ?? 0,
  };
}

function planFromEffectiveItems(
  items: readonly EffectiveModelHistoryItem[],
  requestedTurns: number,
  historyThroughSequence: number,
): ThreadRollbackBoundary {
  if (
    !Number.isSafeInteger(requestedTurns) ||
    requestedTurns < 1 ||
    requestedTurns > MAX_MODEL_HISTORY_ROLLBACK_TURNS
  ) {
    throw new ModelHistoryError("model_history_rollback_turns_invalid");
  }
  let cutIndex = items.length;
  let removedTurns = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (!isInstructionBoundary(item)) {
      continue;
    }
    cutIndex = index;
    removedTurns += 1;
    if (removedTurns === requestedTurns) {
      break;
    }
  }
  if (removedTurns > 0) {
    const firstInstructionIndex = items.findIndex(isInstructionBoundary);
    while (
      cutIndex > firstInstructionIndex &&
      isContextualUpdate(items[cutIndex - 1]!)
    ) {
      cutIndex -= 1;
    }
  }
  return {
    requestedTurns,
    removedTurns,
    historyFromSequence:
      removedTurns === 0 ? null : (items[cutIndex]?.sequence ?? null),
    historyThroughSequence,
    markerHistorySequence: historyThroughSequence + 1,
  };
}

function validateRawHistory(history: readonly ModelHistoryItem[]): void {
  let tenantId: string | null = null;
  let threadId: string | null = null;
  for (const [index, item] of history.entries()) {
    validateModelHistoryItem(item);
    if (item.sequence !== index + 1) {
      throw new ModelHistoryError("model_history_sequence_gap");
    }
    tenantId ??= item.tenantId;
    threadId ??= item.threadId;
    if (item.tenantId !== tenantId || item.threadId !== threadId) {
      throw new ModelHistoryError("model_history_identity_mismatch");
    }
  }
}

function isInstructionBoundary(item: EffectiveModelHistoryItem): boolean {
  return (
    item.type === "message" &&
    item.role === "user" &&
    item.source === "thread_message"
  );
}

function isContextualUpdate(item: EffectiveModelHistoryItem): boolean {
  return (
    item.type === "message" &&
    item.role === "user" &&
    (item.source === "goal_continuation" || item.source === "goal_steering")
  );
}

function sameBoundary(
  left: ThreadRollbackBoundary,
  right: ThreadRollbackBoundary,
): boolean {
  return (
    left.requestedTurns === right.requestedTurns &&
    left.removedTurns === right.removedTurns &&
    left.historyFromSequence === right.historyFromSequence &&
    left.historyThroughSequence === right.historyThroughSequence &&
    left.markerHistorySequence === right.markerHistorySequence
  );
}
