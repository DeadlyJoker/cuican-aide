import {
  ThreadGoalError,
  validateThreadGoal,
  type ThreadGoal,
} from "./thread-goal.ts";

export const MAX_THREAD_GOAL_EVENT_BYTES = 32 * 1024;

type ThreadGoalEventBase = Readonly<{
  schemaVersion: "crewon.thread-goal-event.v0";
  tenantId: string;
  threadId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
}>;

export type ThreadGoalEvent =
  | (ThreadGoalEventBase & {
      type: "goal.updated";
      data: Readonly<{ goal: ThreadGoal }>;
    })
  | (ThreadGoalEventBase & {
      type: "goal.cleared";
      data: Readonly<{
        previousGoalId: string;
        previousRevision: number;
      }>;
    });

export type ThreadGoalEventState = Readonly<{
  tenantId: string;
  threadId: string;
  lastSequence: number;
  lastEventId: string;
  currentGoal: ThreadGoal | null;
  latestGoalId: string;
  latestGoalRevision: number;
  updatedAt: string;
}>;

export type ThreadGoalEventPageBoundary = Readonly<{
  tenantId: string;
  threadId: string;
  afterSequence: number;
}>;

export type PublicThreadGoal = Omit<ThreadGoal, "schemaVersion" | "tenantId">;

export type PublicThreadGoalEvent =
  | Readonly<{
      schemaVersion: "crewon.thread-goal-event.v0";
      threadId: string;
      eventId: string;
      sequence: number;
      occurredAt: string;
      type: "goal.updated";
      data: Readonly<{ goal: PublicThreadGoal }>;
    }>
  | Readonly<{
      schemaVersion: "crewon.thread-goal-event.v0";
      threadId: string;
      eventId: string;
      sequence: number;
      occurredAt: string;
      type: "goal.cleared";
      data: Readonly<{
        previousGoalId: string;
        previousRevision: number;
      }>;
    }>;

export class ThreadGoalEventError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ThreadGoalEventError";
    this.code = code;
  }
}

export function validateThreadGoalEvent(
  value: unknown,
): asserts value is ThreadGoalEvent {
  requireEventSize(value);
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "tenantId",
      "threadId",
      "eventId",
      "sequence",
      "occurredAt",
      "type",
      "data",
    ]) ||
    value.schemaVersion !== "crewon.thread-goal-event.v0"
  ) {
    throw new ThreadGoalEventError("goal_event_envelope_invalid");
  }
  requireBounded(value.tenantId, 256, "goal_event_tenant_id_invalid");
  requireBounded(value.threadId, 512, "goal_event_thread_id_invalid");
  requireBounded(value.eventId, 512, "goal_event_id_invalid");
  requirePositiveInteger(value.sequence, "goal_event_sequence_invalid");
  requireTimestamp(value.occurredAt, "goal_event_occurred_at_invalid");

  if (value.type === "goal.updated") {
    if (!hasExactKeys(value.data, ["goal"])) {
      throw new ThreadGoalEventError("goal_event_updated_data_invalid");
    }
    validateGoalSnapshot(value.data.goal);
    if (
      value.data.goal.tenantId !== value.tenantId ||
      value.data.goal.threadId !== value.threadId ||
      value.data.goal.updatedAt !== value.occurredAt
    ) {
      throw new ThreadGoalEventError("goal_event_snapshot_mismatch");
    }
    return;
  }

  if (value.type === "goal.cleared") {
    if (!hasExactKeys(value.data, ["previousGoalId", "previousRevision"])) {
      throw new ThreadGoalEventError("goal_event_cleared_data_invalid");
    }
    requireBounded(
      value.data.previousGoalId,
      512,
      "goal_event_previous_goal_id_invalid",
    );
    requirePositiveInteger(
      value.data.previousRevision,
      "goal_event_previous_revision_invalid",
    );
    return;
  }

  throw new ThreadGoalEventError("goal_event_type_invalid");
}

export function reduceThreadGoalEvent(
  state: ThreadGoalEventState | null,
  event: ThreadGoalEvent,
): ThreadGoalEventState {
  validateThreadGoalEvent(event);
  if (state === null) {
    if (event.sequence !== 1) {
      throw new ThreadGoalEventError("goal_event_sequence_gap");
    }
    return stateFromFirstEvent(event);
  }
  if (event.tenantId !== state.tenantId) {
    throw new ThreadGoalEventError("goal_event_tenant_mismatch");
  }
  if (event.threadId !== state.threadId) {
    throw new ThreadGoalEventError("goal_event_thread_mismatch");
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new ThreadGoalEventError("goal_event_sequence_gap");
  }
  if (Date.parse(event.occurredAt) < Date.parse(state.updatedAt)) {
    throw new ThreadGoalEventError("goal_event_time_regressed");
  }

  if (event.type === "goal.updated") {
    validateSnapshotProgress(state.currentGoal, event.data.goal);
    return {
      ...state,
      lastSequence: event.sequence,
      lastEventId: event.eventId,
      currentGoal: event.data.goal,
      latestGoalId: event.data.goal.goalId,
      latestGoalRevision: event.data.goal.revision,
      updatedAt: event.occurredAt,
    };
  }

  if (state.currentGoal === null) {
    throw new ThreadGoalEventError("goal_event_already_cleared");
  }
  if (
    event.data.previousGoalId !== state.currentGoal.goalId ||
    event.data.previousRevision !== state.currentGoal.revision
  ) {
    throw new ThreadGoalEventError("goal_event_clear_identity_mismatch");
  }
  return {
    ...state,
    lastSequence: event.sequence,
    lastEventId: event.eventId,
    currentGoal: null,
    latestGoalId: event.data.previousGoalId,
    latestGoalRevision: event.data.previousRevision,
    updatedAt: event.occurredAt,
  };
}

export function replayThreadGoalEvents(
  events: readonly ThreadGoalEvent[],
): ThreadGoalEventState {
  let state: ThreadGoalEventState | null = null;
  for (const event of events) {
    state = reduceThreadGoalEvent(state, event);
  }
  if (state === null) {
    throw new ThreadGoalEventError("goal_events_empty");
  }
  return state;
}

/** Validates one catch-up page without requiring the preceding Goal snapshot. */
export function validateThreadGoalEventPageBoundary(
  events: readonly ThreadGoalEvent[],
  boundary: ThreadGoalEventPageBoundary,
): void {
  requireBounded(boundary.tenantId, 256, "goal_event_tenant_id_invalid");
  requireBounded(boundary.threadId, 512, "goal_event_thread_id_invalid");
  requireNonNegativeInteger(
    boundary.afterSequence,
    "goal_event_page_boundary_invalid",
  );
  if (!Array.isArray(events)) {
    throw new ThreadGoalEventError("goal_event_page_invalid");
  }

  const eventIds = new Set<string>();
  let previousOccurredAt: string | null = null;
  for (const [index, event] of events.entries()) {
    validateThreadGoalEvent(event);
    const expectedSequence = boundary.afterSequence + index + 1;
    if (!Number.isSafeInteger(expectedSequence)) {
      throw new ThreadGoalEventError("goal_event_sequence_overflow");
    }
    if (event.sequence !== expectedSequence) {
      throw new ThreadGoalEventError("goal_event_page_sequence_gap");
    }
    if (event.tenantId !== boundary.tenantId) {
      throw new ThreadGoalEventError("goal_event_tenant_mismatch");
    }
    if (event.threadId !== boundary.threadId) {
      throw new ThreadGoalEventError("goal_event_thread_mismatch");
    }
    if (eventIds.has(event.eventId)) {
      throw new ThreadGoalEventError("goal_event_page_duplicate_id");
    }
    if (
      previousOccurredAt !== null &&
      Date.parse(event.occurredAt) < Date.parse(previousOccurredAt)
    ) {
      throw new ThreadGoalEventError("goal_event_time_regressed");
    }
    eventIds.add(event.eventId);
    previousOccurredAt = event.occurredAt;
  }
}

/** Removes tenant authority fields before an event is exposed over SSE. */
export function projectPublicThreadGoalEvent(
  event: ThreadGoalEvent,
): PublicThreadGoalEvent {
  validateThreadGoalEvent(event);
  const base = {
    schemaVersion: event.schemaVersion,
    threadId: event.threadId,
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
  };
  if (event.type === "goal.cleared") {
    return { ...base, type: event.type, data: { ...event.data } };
  }
  const {
    schemaVersion: _schemaVersion,
    tenantId: _tenantId,
    ...goal
  } = event.data.goal;
  return { ...base, type: event.type, data: { goal } };
}

function stateFromFirstEvent(event: ThreadGoalEvent): ThreadGoalEventState {
  if (event.type === "goal.updated") {
    return {
      tenantId: event.tenantId,
      threadId: event.threadId,
      lastSequence: event.sequence,
      lastEventId: event.eventId,
      currentGoal: event.data.goal,
      latestGoalId: event.data.goal.goalId,
      latestGoalRevision: event.data.goal.revision,
      updatedAt: event.occurredAt,
    };
  }
  return {
    tenantId: event.tenantId,
    threadId: event.threadId,
    lastSequence: event.sequence,
    lastEventId: event.eventId,
    currentGoal: null,
    latestGoalId: event.data.previousGoalId,
    latestGoalRevision: event.data.previousRevision,
    updatedAt: event.occurredAt,
  };
}

function validateGoalSnapshot(value: unknown): asserts value is ThreadGoal {
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "tenantId",
      "threadId",
      "goalId",
      "revision",
      "objective",
      "status",
      "tokenBudget",
      "tokensUsed",
      "timeUsedSeconds",
      "createdAt",
      "updatedAt",
    ])
  ) {
    throw new ThreadGoalEventError("goal_event_snapshot_invalid");
  }
  try {
    validateThreadGoal(value as ThreadGoal);
  } catch (error) {
    throw new ThreadGoalEventError(
      error instanceof ThreadGoalError
        ? `goal_event_snapshot:${error.code}`
        : "goal_event_snapshot_invalid",
    );
  }
}

function validateSnapshotProgress(
  previous: ThreadGoal | null,
  next: ThreadGoal,
): void {
  if (previous === null) return;
  if (
    next.goalId !== previous.goalId ||
    next.createdAt !== previous.createdAt ||
    next.revision !== previous.revision + 1 ||
    next.tokensUsed < previous.tokensUsed ||
    next.timeUsedSeconds < previous.timeUsedSeconds
  ) {
    throw new ThreadGoalEventError("goal_event_snapshot_progress_invalid");
  }
}

function requireEventSize(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ThreadGoalEventError("goal_event_not_serializable");
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      MAX_THREAD_GOAL_EVENT_BYTES
  ) {
    throw new ThreadGoalEventError("goal_event_too_large");
  }
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireBounded(value: unknown, maxBytes: number, code: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new ThreadGoalEventError(code);
  }
}

function requirePositiveInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new ThreadGoalEventError(code);
  }
}

function requireNonNegativeInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ThreadGoalEventError(code);
  }
}

function requireTimestamp(value: unknown, code: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ThreadGoalEventError(code);
  }
}
