import {
  THREAD_GOAL_ACCOUNTING_POLICY,
  ThreadGoalError,
  threadGoalChargedTokens,
  type GoalRunTerminalOutcome,
  type RunGoalBinding,
  type ThreadGoal,
  type ThreadGoalStatus,
} from "./thread-goal.ts";
import type { RunState, RunUsage } from "./run-lifecycle.ts";

export type RunGoalAttribution = Readonly<{
  goalId: string;
  goalRevision: number;
  objectiveDigest: string;
}>;

export type RunGoalSteeringHandoff = Readonly<{
  handoffId: string;
  kind: "objectiveUpdated" | "budgetLimited";
  target: RunGoalBinding;
  createdAt: string;
}>;

/** Durable per-Run cursor for incremental Goal usage and steering handoff. */
export type RunGoalAccountingCursor = Readonly<{
  schemaVersion: "crewon.run-goal-accounting.v0";
  revision: number;
  policy: typeof THREAD_GOAL_ACCOUNTING_POLICY;
  throughRunSequence: number;
  accountedUsage: RunUsage;
  timeBaselineAt: string | null;
  attribution: RunGoalAttribution | null;
  pendingSteering: RunGoalSteeringHandoff | null;
  updatedAt: string;
}>;

export type RunGoalAccountingDelta = Readonly<{
  throughRunSequence: number;
  accountedUsage: RunUsage;
  tokenDelta: number;
  timeDeltaSeconds: number;
  nextTimeBaselineAt: string | null;
}>;

export type ThreadGoalToolBoundaryAccounting = Readonly<{
  goalState: ThreadGoal | null;
  crossedBudget: boolean;
}>;

export type AdvanceRunGoalAccountingInput = Readonly<{
  currentUsage: RunUsage;
  throughRunSequence: number;
  occurredAt: string;
  nextBinding: RunGoalBinding | null;
  pendingSteering: RunGoalSteeringHandoff | null;
  trackTime: boolean;
}>;

export class RunGoalAccountingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RunGoalAccountingError";
    this.code = code;
  }
}

export function createRunGoalAccountingCursor(
  binding: RunGoalBinding,
  occurredAt: string,
): RunGoalAccountingCursor {
  validateTimestamp(occurredAt, "goal_accounting_updated_at_invalid");
  validateBinding(binding);
  return {
    schemaVersion: "crewon.run-goal-accounting.v0",
    revision: 1,
    policy: THREAD_GOAL_ACCOUNTING_POLICY,
    throughRunSequence: 1,
    accountedUsage: zeroUsage(),
    timeBaselineAt: null,
    attribution: {
      goalId: binding.goalId,
      goalRevision: binding.revision,
      objectiveDigest: binding.objectiveDigest,
    },
    pendingSteering: null,
    updatedAt: occurredAt,
  };
}

export function startRunGoalAccounting(
  cursor: RunGoalAccountingCursor | null,
  throughRunSequence: number,
  occurredAt: string,
): RunGoalAccountingCursor | null {
  if (cursor === null) return null;
  validateRunGoalAccountingCursor(cursor);
  requirePositiveInteger(
    throughRunSequence,
    "goal_accounting_sequence_invalid",
  );
  validateTimestamp(occurredAt, "goal_accounting_updated_at_invalid");
  if (
    throughRunSequence <= cursor.throughRunSequence ||
    Date.parse(occurredAt) < Date.parse(cursor.updatedAt)
  ) {
    throw new RunGoalAccountingError("goal_accounting_start_invalid");
  }
  return {
    ...cursor,
    revision: increment(cursor.revision, "goal_accounting_revision_overflow"),
    throughRunSequence,
    timeBaselineAt: occurredAt,
    updatedAt: occurredAt,
  };
}

export function validateRunGoalAccountingCursor(
  cursor: RunGoalAccountingCursor,
): void {
  if (
    !isPlainObject(cursor) ||
    cursor.schemaVersion !== "crewon.run-goal-accounting.v0" ||
    cursor.policy !== THREAD_GOAL_ACCOUNTING_POLICY
  ) {
    throw new RunGoalAccountingError("goal_accounting_cursor_invalid");
  }
  requirePositiveInteger(cursor.revision, "goal_accounting_revision_invalid");
  requirePositiveInteger(
    cursor.throughRunSequence,
    "goal_accounting_sequence_invalid",
  );
  validateUsage(cursor.accountedUsage);
  if (cursor.timeBaselineAt !== null) {
    validateTimestamp(
      cursor.timeBaselineAt,
      "goal_accounting_time_baseline_invalid",
    );
  }
  validateTimestamp(cursor.updatedAt, "goal_accounting_updated_at_invalid");
  if (
    cursor.timeBaselineAt !== null &&
    Date.parse(cursor.timeBaselineAt) > Date.parse(cursor.updatedAt)
  ) {
    throw new RunGoalAccountingError("goal_accounting_time_baseline_invalid");
  }
  if (cursor.attribution !== null) {
    requireNonEmpty(
      cursor.attribution.goalId,
      "goal_accounting_goal_id_invalid",
    );
    requirePositiveInteger(
      cursor.attribution.goalRevision,
      "goal_accounting_goal_revision_invalid",
    );
    if (!/^sha256:[a-f0-9]{64}$/.test(cursor.attribution.objectiveDigest)) {
      throw new RunGoalAccountingError(
        "goal_accounting_objective_digest_invalid",
      );
    }
  }
  if (cursor.pendingSteering !== null) {
    const handoff = cursor.pendingSteering;
    requireNonEmpty(handoff.handoffId, "goal_steering_handoff_id_invalid");
    if (
      handoff.kind !== "objectiveUpdated" &&
      handoff.kind !== "budgetLimited"
    ) {
      throw new RunGoalAccountingError("goal_steering_kind_invalid");
    }
    validateBinding(handoff.target);
    validateTimestamp(handoff.createdAt, "goal_steering_created_at_invalid");
    if (
      cursor.attribution === null ||
      cursor.attribution.goalId !== handoff.target.goalId ||
      cursor.attribution.goalRevision !== handoff.target.revision ||
      cursor.attribution.objectiveDigest !== handoff.target.objectiveDigest ||
      Date.parse(handoff.createdAt) > Date.parse(cursor.updatedAt)
    ) {
      throw new RunGoalAccountingError("goal_steering_target_invalid");
    }
  }
}

export function reduceRunGoalAccountingUpdate(
  current: RunGoalAccountingCursor | null,
  next: RunGoalAccountingCursor,
  runUsage: RunUsage,
  currentRunSequence: number,
  occurredAt: string,
): RunGoalAccountingCursor {
  if (current !== null) validateRunGoalAccountingCursor(current);
  validateRunGoalAccountingCursor(next);
  validateUsage(runUsage);
  requirePositiveInteger(
    currentRunSequence,
    "goal_accounting_sequence_invalid",
  );
  validateTimestamp(occurredAt, "goal_accounting_updated_at_invalid");
  if (
    next.revision !== (current?.revision ?? 0) + 1 ||
    next.updatedAt !== occurredAt ||
    next.throughRunSequence > currentRunSequence ||
    next.throughRunSequence < (current?.throughRunSequence ?? 1) ||
    usageRegressed(
      current?.accountedUsage ?? zeroUsage(),
      next.accountedUsage,
    ) ||
    usageRegressed(next.accountedUsage, runUsage)
  ) {
    throw new RunGoalAccountingError("goal_accounting_update_invalid");
  }
  return next;
}

export function consumeRunGoalSteering(
  cursor: RunGoalAccountingCursor,
  handoffId: string,
  occurredAt: string,
): RunGoalAccountingCursor {
  validateRunGoalAccountingCursor(cursor);
  requireNonEmpty(handoffId, "goal_steering_handoff_id_invalid");
  validateTimestamp(occurredAt, "goal_accounting_updated_at_invalid");
  if (
    cursor.pendingSteering?.handoffId !== handoffId ||
    Date.parse(occurredAt) < Date.parse(cursor.updatedAt)
  ) {
    throw new RunGoalAccountingError("goal_steering_not_current");
  }
  return {
    ...cursor,
    revision: increment(cursor.revision, "goal_accounting_revision_overflow"),
    pendingSteering: null,
    updatedAt: occurredAt,
  };
}

export function computeRunGoalAccountingDelta(
  cursor: RunGoalAccountingCursor,
  currentUsage: RunUsage,
  throughRunSequence: number,
  occurredAt: string,
): RunGoalAccountingDelta {
  validateRunGoalAccountingCursor(cursor);
  validateUsage(currentUsage);
  requirePositiveInteger(
    throughRunSequence,
    "goal_accounting_sequence_invalid",
  );
  validateTimestamp(occurredAt, "goal_accounting_updated_at_invalid");
  if (
    throughRunSequence < cursor.throughRunSequence ||
    usageRegressed(cursor.accountedUsage, currentUsage) ||
    Date.parse(occurredAt) < Date.parse(cursor.updatedAt)
  ) {
    throw new RunGoalAccountingError("goal_accounting_usage_regressed");
  }
  const usageDelta: RunUsage = {
    inputTokens: currentUsage.inputTokens - cursor.accountedUsage.inputTokens,
    cachedInputTokens:
      currentUsage.cachedInputTokens - cursor.accountedUsage.cachedInputTokens,
    outputTokens:
      currentUsage.outputTokens - cursor.accountedUsage.outputTokens,
    totalTokens: currentUsage.totalTokens - cursor.accountedUsage.totalTokens,
  };
  validateUsage(usageDelta);
  let timeDeltaSeconds = 0;
  let nextTimeBaselineAt = cursor.timeBaselineAt;
  if (cursor.attribution !== null && cursor.timeBaselineAt !== null) {
    const baselineMs = Date.parse(cursor.timeBaselineAt);
    const elapsedMs = Date.parse(occurredAt) - baselineMs;
    if (elapsedMs < 0) {
      throw new RunGoalAccountingError("goal_accounting_time_regressed");
    }
    timeDeltaSeconds = Math.floor(elapsedMs / 1_000);
    nextTimeBaselineAt = new Date(
      baselineMs + timeDeltaSeconds * 1_000,
    ).toISOString();
  }
  return {
    throughRunSequence,
    accountedUsage: { ...currentUsage },
    tokenDelta: threadGoalChargedTokens(usageDelta),
    timeDeltaSeconds,
    nextTimeBaselineAt,
  };
}

/**
 * Closes the current accounting interval and atomically opens the next one.
 * The full Run usage watermark is retained so future accounting policies can
 * never reinterpret an already-settled interval.
 */
export function advanceRunGoalAccounting(
  current: RunGoalAccountingCursor | null,
  input: AdvanceRunGoalAccountingInput,
): Readonly<{
  delta: RunGoalAccountingDelta;
  next: RunGoalAccountingCursor;
}> {
  validateUsage(input.currentUsage);
  requirePositiveInteger(
    input.throughRunSequence,
    "goal_accounting_sequence_invalid",
  );
  validateTimestamp(input.occurredAt, "goal_accounting_updated_at_invalid");
  if (input.nextBinding !== null) validateBinding(input.nextBinding);
  if (
    input.pendingSteering !== null &&
    (input.nextBinding === null ||
      input.pendingSteering.target.goalId !== input.nextBinding.goalId ||
      input.pendingSteering.target.revision !== input.nextBinding.revision ||
      input.pendingSteering.target.objectiveDigest !==
        input.nextBinding.objectiveDigest)
  ) {
    throw new RunGoalAccountingError("goal_steering_target_invalid");
  }
  if (input.nextBinding === null && input.trackTime) {
    throw new RunGoalAccountingError("goal_accounting_time_tracking_invalid");
  }

  const delta =
    current === null
      ? {
          throughRunSequence: input.throughRunSequence,
          accountedUsage: { ...input.currentUsage },
          tokenDelta: 0,
          timeDeltaSeconds: 0,
          nextTimeBaselineAt: null,
        }
      : computeRunGoalAccountingDelta(
          current,
          input.currentUsage,
          input.throughRunSequence,
          input.occurredAt,
        );
  const nextTimeBaselineAt =
    input.nextBinding === null || !input.trackTime
      ? null
      : current?.attribution === null || current?.timeBaselineAt === null
        ? input.occurredAt
        : delta.nextTimeBaselineAt;
  const next: RunGoalAccountingCursor = {
    schemaVersion: "crewon.run-goal-accounting.v0",
    revision: (current?.revision ?? 0) + 1,
    policy: THREAD_GOAL_ACCOUNTING_POLICY,
    throughRunSequence: input.throughRunSequence,
    accountedUsage: { ...input.currentUsage },
    timeBaselineAt: nextTimeBaselineAt,
    attribution:
      input.nextBinding === null
        ? null
        : {
            goalId: input.nextBinding.goalId,
            goalRevision: input.nextBinding.revision,
            objectiveDigest: input.nextBinding.objectiveDigest,
          },
    pendingSteering: input.pendingSteering,
    updatedAt: input.occurredAt,
  };
  validateRunGoalAccountingCursor(next);
  return { delta, next };
}

export function accountThreadGoalProgress(
  current: ThreadGoal | null,
  cursor: RunGoalAccountingCursor,
  delta: RunGoalAccountingDelta,
  occurredAt: string,
): ThreadGoal | null {
  validateRunGoalAccountingCursor(cursor);
  validateTimestamp(occurredAt, "goal_updated_at_invalid");
  const attribution = cursor.attribution;
  if (attribution === null) return current;
  if (
    current === null ||
    current.goalId !== attribution.goalId ||
    current.revision !== attribution.goalRevision
  ) {
    throw new RunGoalAccountingError("goal_accounting_attribution_mismatch");
  }
  if (current.status !== "active" && current.status !== "budgetLimited") {
    throw new RunGoalAccountingError("goal_accounting_inactive_attribution");
  }
  if (Date.parse(occurredAt) < Date.parse(current.updatedAt)) {
    throw new RunGoalAccountingError("goal_accounting_time_regressed");
  }
  const tokensUsed = add(
    current.tokensUsed,
    delta.tokenDelta,
    "goal_tokens_used_overflow",
  );
  const timeUsedSeconds = add(
    current.timeUsedSeconds,
    delta.timeDeltaSeconds,
    "goal_time_used_seconds_overflow",
  );
  const status: ThreadGoalStatus =
    current.status === "active" &&
    current.tokenBudget !== null &&
    tokensUsed >= current.tokenBudget
      ? "budgetLimited"
      : current.status;
  if (
    tokensUsed === current.tokensUsed &&
    timeUsedSeconds === current.timeUsedSeconds &&
    status === current.status
  ) {
    return current;
  }
  return {
    ...current,
    status,
    tokensUsed,
    timeUsedSeconds,
    updatedAt: occurredAt,
  };
}

/**
 * Accounts one ordinary Tool-finish boundary without applying terminal Run
 * semantics. A durable Goal revision is consumed only when usage, whole-second
 * time, or the budget status actually changes.
 */
export function accountThreadGoalAtToolBoundary(
  current: ThreadGoal | null,
  run: RunState,
  occurredAt: string,
): ThreadGoalToolBoundaryAccounting {
  const cursor = run.goalAccounting;
  if (
    run.collaborationMode === "plan" ||
    cursor === null ||
    cursor.attribution === null
  ) {
    return { goalState: current, crossedBudget: false };
  }
  if (run.status !== "running") {
    throw new RunGoalAccountingError("goal_accounting_run_not_running");
  }

  const delta = computeRunGoalAccountingDelta(
    cursor,
    run.usage,
    run.lastSequence,
    occurredAt,
  );
  const accounted = accountThreadGoalProgress(
    current,
    cursor,
    delta,
    occurredAt,
  );
  if (accounted === current) {
    return { goalState: current, crossedBudget: false };
  }
  if (accounted === null || current === null) {
    throw new RunGoalAccountingError("goal_accounting_attribution_mismatch");
  }

  const crossedBudget =
    current.status === "active" && accounted.status === "budgetLimited";
  return {
    goalState: {
      ...accounted,
      revision: increment(current.revision, "goal_revision_overflow"),
    },
    crossedBudget,
  };
}

export function settleThreadGoalFromAccounting(
  current: ThreadGoal | null,
  run: RunState,
  outcome: GoalRunTerminalOutcome,
  occurredAt: string,
): ThreadGoal | null {
  const cursor = run.goalAccounting;
  if (cursor === null || cursor.attribution === null) return current;
  const delta = computeRunGoalAccountingDelta(
    cursor,
    run.usage,
    run.lastSequence,
    occurredAt,
  );
  const accounted = accountThreadGoalProgress(
    current,
    cursor,
    delta,
    occurredAt,
  );
  if (accounted === null || current === null) {
    throw new RunGoalAccountingError("goal_accounting_attribution_mismatch");
  }
  const usageLimited =
    outcome.kind === "failed" &&
    outcome.code === "responses_usage_limit_reached";
  const status: ThreadGoalStatus = usageLimited
    ? "usageLimited"
    : accounted.status === "budgetLimited"
      ? "budgetLimited"
      : outcome.kind === "failed"
        ? "blocked"
        : "active";
  if (accounted === current && status === current.status) {
    return current;
  }
  return {
    ...accounted,
    revision: increment(current.revision, "goal_revision_overflow"),
    status,
    updatedAt: occurredAt,
  };
}

function validateBinding(binding: RunGoalBinding): void {
  requireNonEmpty(binding.goalId, "goal_accounting_goal_id_invalid");
  requirePositiveInteger(
    binding.revision,
    "goal_accounting_goal_revision_invalid",
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(binding.objectiveDigest)) {
    throw new RunGoalAccountingError(
      "goal_accounting_objective_digest_invalid",
    );
  }
}

function validateUsage(usage: RunUsage): void {
  if (
    !isPlainObject(usage) ||
    !isNonNegativeInteger(usage.inputTokens) ||
    !isNonNegativeInteger(usage.cachedInputTokens) ||
    !isNonNegativeInteger(usage.outputTokens) ||
    !isNonNegativeInteger(usage.totalTokens) ||
    usage.cachedInputTokens > usage.inputTokens ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new RunGoalAccountingError("goal_accounting_usage_invalid");
  }
}

function usageRegressed(previous: RunUsage, next: RunUsage): boolean {
  return (
    next.inputTokens < previous.inputTokens ||
    next.cachedInputTokens < previous.cachedInputTokens ||
    next.outputTokens < previous.outputTokens ||
    next.totalTokens < previous.totalTokens
  );
}

function zeroUsage(): RunUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function add(left: number, right: number, code: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RunGoalAccountingError(code);
  }
  return result;
}

function increment(value: number, code: string): number {
  return add(value, 1, code);
}

function requirePositiveInteger(value: unknown, code: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RunGoalAccountingError(code);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireNonEmpty(
  value: unknown,
  code: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunGoalAccountingError(code);
  }
}

function validateTimestamp(value: string, code: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new RunGoalAccountingError(code);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
