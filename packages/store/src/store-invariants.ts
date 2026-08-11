import {
  MESSAGE_ROLES,
  MAX_AUTOMATION_INSTRUCTION_BYTES,
  ModelHistoryError,
  parseAutomationInvocationBinding,
  parseAutomationInvocationOrigin,
  accountThreadGoalAtToolBoundary,
  accountThreadGoalProgress,
  advanceRunGoalAccounting,
  computeRunGoalAccountingDelta,
  RunGoalAccountingError,
  ToolExecutionReceiptError,
  dispatchToolExecutionReceipt,
  markToolExecutionUnknownOutcome,
  resolveToolExecutionReceipt,
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  settleThreadGoalFromAccounting,
  projectEffectiveModelHistory,
  validateThreadRollbackArtifacts,
  validateToolExecutionReceipt,
  validateModelHistoryItem,
  validateProposedPlan,
  validateThreadGoal,
  isGoalRunnable,
  isModelHistoryMessageBacked,
  settleThreadGoalForRun,
  threadGoalContinuationPrompt,
  ThreadGoalError,
  validateThreadLifecycleEvent,
  validateThreadState,
  type ModelHistoryItem,
  type RunAttemptState,
  type RunState,
  type ToolExecutionReceiptState,
  type RunLifecycleEvent,
  type RunStepState,
  type ThreadLifecycleEvent,
  type ThreadGoal,
  type ThreadState,
} from "@crewon/domain";
import {
  parseExecutionProviderCheckpoint,
  RunStoreError,
  type BeginRunAttemptInput,
  type CommitLeasedRunTerminalInput,
  type CommitContextCompactionInput,
  type CommitAssistantSampleContinuationInput,
  type CommitToolExecutionCompletionInput,
  type CommitToolExecutionUnknownOutcomeInput,
  type CompleteRunAttemptInput,
  type CommitRunInput,
  type CommitTextRunCompletionInput,
  type CommitThreadInput,
  type CommitThreadResult,
  type CommitThreadRollbackInput,
  type CommitThreadRollbackResult,
  type CommitThreadGoalMutationInput,
  type CommitThreadGoalMutationResult,
  type CommitTurnStartInput,
  type MessageRecord,
  type InvalidatedMessage,
  type MessageView,
  type OutboxMessage,
  type OutboxRetryInput,
  type QueueClaimInput,
  type RunLocator,
  type RunReceiptQuery,
  type ThreadRunListQuery,
  type RunAttemptLocator,
  type RunAttemptTerminalMutation,
  type RunStepLocator,
  type RunGoalContinuationCommit,
  type RetryRunAttemptInput,
  type WorkItem,
  type WorkItemRetryInput,
  type ThreadLocator,
  type ThreadSpaceLocator,
  type ThreadRollbackReceiptQuery,
  type ThreadListQuery,
  type ThreadContinuationLocator,
  type ThreadModelState,
  type ModelHistoryAppend,
  type PrepareToolExecutionInput,
  type ToolExecutionActionLocator,
  type ToolExecutionReceiptLocator,
  type TransitionToolExecutionInput,
  type TurnStartReceiptQuery,
  type TurnStartGoalMutation,
  type GoalToolExecutionInput,
  type ThreadGoalContinuation,
  type ThreadGoalQueuedRunCancellation,
  type ThreadGoalRetainedRunUpdate,
} from "@crewon/application";

const MAX_PAGE_SIZE = 1_000;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_OUTBOX_MESSAGE_BYTES = 64 * 1024;
const MAX_WORK_ITEM_BYTES = 64 * 1024;
const MAX_LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;
const MAX_THREAD_EVENT_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_MODEL_HISTORY_ITEM_BYTES = 64 * 1024;

export function validateCommitInput(input: CommitRunInput): string {
  requireNonEmpty(input.tenantId, "tenant_id_invalid");
  requireBoundedString(
    input.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(input.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    input.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new RunStoreError("expected_revision_invalid");
  }
  if (input.events.length === 0) {
    throw new RunStoreError("events_empty");
  }
  const runId = input.events[0].identity.runId;
  requireNonEmpty(runId, "run_id_invalid");
  if (
    input.events[0].type === "run.created" &&
    input.events[0].data.tenantId !== input.tenantId
  ) {
    throw new RunStoreError("tenant_id_mismatch");
  }
  const admission = input.threadAdmission;
  if (admission !== undefined) {
    requireBoundedString(admission.threadId, 512, "thread_id_invalid");
    if (
      admission.kind !== "manualCompaction" ||
      !Number.isSafeInteger(admission.expectedThreadRevision) ||
      admission.expectedThreadRevision < 1 ||
      !Number.isSafeInteger(admission.expectedHistorySequence) ||
      admission.expectedHistorySequence < 1 ||
      (admission.expectedGoalRevision !== null &&
        (!Number.isSafeInteger(admission.expectedGoalRevision) ||
          admission.expectedGoalRevision < 1)) ||
      input.events[0].type !== "run.created" ||
      input.events[0].data.threadId !== admission.threadId ||
      input.events[0].data.purpose !== "manualCompaction" ||
      input.events[0].data.goalBinding !== null
    ) {
      throw new RunStoreError("manual_compaction_admission_invalid");
    }
  } else if (
    input.events[0].type === "run.created" &&
    input.events[0].data.purpose === "manualCompaction"
  ) {
    throw new RunStoreError("manual_compaction_admission_missing");
  }
  return runId;
}

export function validateRunReceiptQuery(query: RunReceiptQuery): void {
  requireBoundedString(query.tenantId, 256, "tenant_id_invalid");
  requireBoundedString(query.threadId, 512, "thread_id_invalid");
  requireBoundedString(
    query.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(query.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    query.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
}

export function validateManualCompactionAdmissionState(
  input: CommitRunInput,
  state: Readonly<{
    currentRun: RunState | null;
    nextRun: RunState;
    thread: ThreadState;
    historySequence: number;
    goal: ThreadGoal | null;
    hasActiveRun: boolean;
  }>,
): void {
  const admission = input.threadAdmission;
  if (admission === undefined) return;
  if (
    state.currentRun !== null ||
    state.nextRun.purpose !== "manualCompaction" ||
    state.nextRun.threadId !== admission.threadId ||
    state.thread.threadId !== admission.threadId ||
    state.thread.revision !== admission.expectedThreadRevision ||
    state.thread.status !== "active" ||
    state.historySequence !== admission.expectedHistorySequence ||
    (state.goal?.revision ?? null) !== admission.expectedGoalRevision ||
    state.goal?.status === "active" ||
    state.hasActiveRun
  ) {
    throw new RunStoreError("manual_compaction_admission_conflict");
  }
}

export function validateGoalToolExecutionInput(
  input: GoalToolExecutionInput,
): void {
  requireBoundedString(input.tenantId, 256, "tenant_id_invalid");
  requireBoundedString(input.threadId, 512, "thread_id_invalid");
  requireBoundedString(input.runId, 512, "run_id_invalid");
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  requireBoundedString(
    input.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(input.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    input.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
  requireBoundedString(input.request.segmentId, 512, "segment_id_invalid");
  requireBoundedString(input.request.callId, 512, "tool_call_id_invalid");
  if (
    input.request.kind !== "function" ||
    (input.request.name !== "get_goal" &&
      input.request.name !== "create_goal" &&
      input.request.name !== "update_goal") ||
    typeof input.request.input !== "string" ||
    new TextEncoder().encode(input.request.input).byteLength > 32 * 1024
  ) {
    throw new RunStoreError("goal_tool_request_invalid");
  }
  if (input.request.name === "create_goal") {
    if (input.proposedGoalId === null) {
      throw new RunStoreError("goal_tool_identity_invalid");
    }
    requireBoundedString(
      input.proposedGoalId,
      512,
      "goal_tool_identity_invalid",
    );
  } else if (input.proposedGoalId !== null) {
    throw new RunStoreError("goal_tool_identity_invalid");
  }
  parseQueueTimestamp(input.occurredAt, "goal_tool_timestamp_invalid");
  requireBoundedString(
    input.accountingEventId,
    512,
    "goal_accounting_event_id_invalid",
  );
  requireBoundedString(
    input.accountingOutboxMessageId,
    512,
    "goal_accounting_outbox_id_invalid",
  );
}

export function prepareGoalToolAccounting(
  input: GoalToolExecutionInput,
  run: RunState,
  evaluation: Readonly<{ isError: boolean }>,
): Readonly<{
  runState: RunState;
  runEvents: readonly RunLifecycleEvent[];
  outbox: readonly OutboxMessage[];
}> {
  if (
    evaluation.isError ||
    input.request.name !== "update_goal" ||
    run.goalAccounting?.attribution === null ||
    run.goalAccounting === null
  ) {
    return { runState: run, runEvents: [], outbox: [] };
  }
  let nextAccounting;
  try {
    nextAccounting = advanceRunGoalAccounting(run.goalAccounting, {
      currentUsage: run.usage,
      throughRunSequence: run.lastSequence,
      occurredAt: input.occurredAt,
      nextBinding: null,
      pendingSteering: null,
      trackTime: false,
    }).next;
  } catch (error) {
    throw mapRunGoalAccountingError(error);
  }
  const event: Extract<
    RunLifecycleEvent,
    { type: "run.goal.accounting.updated" }
  > = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: run.runId },
    eventId: input.accountingEventId,
    sequence: run.lastSequence + 1,
    occurredAt: input.occurredAt,
    type: "run.goal.accounting.updated",
    data: { next: nextAccounting },
  };
  const outbox: OutboxMessage = {
    messageId: input.accountingOutboxMessageId,
    tenantId: run.tenantId,
    runId: run.runId,
    topic: "run.updated",
    payload: {
      eventId: event.eventId,
      eventType: event.type,
      throughSequence: event.sequence,
    },
    createdAt: event.occurredAt,
  };
  validateEvents([event], run.runId, () => false);
  validateOutbox([outbox], run.runId, run.tenantId, () => false);
  validateRunEventOutbox(outbox, event);
  return {
    runState: reduceRunLifecycleEvent(run, event),
    runEvents: [event],
    outbox: [outbox],
  };
}

export function validateGoalToolRequestedEvent(
  input: GoalToolExecutionInput,
  event: RunLifecycleEvent | null,
): void {
  if (
    event?.type !== "tool.requested" ||
    event.identity.runId !== input.runId ||
    event.data.segmentId !== input.request.segmentId ||
    event.data.callId !== input.request.callId ||
    event.data.kind !== input.request.kind ||
    event.data.name !== input.request.name ||
    event.data.input !== input.request.input
  ) {
    throw new RunStoreError("goal_tool_request_not_durable");
  }
}

export function validateRunStepLocator(locator: RunStepLocator): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.runId, "run_id_invalid");
  requireNonEmpty(locator.stepId, "step_id_invalid");
}

export function validateToolExecutionReceiptLocator(
  locator: ToolExecutionReceiptLocator,
): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.runId, "run_id_invalid");
  requireNonEmpty(locator.receiptId, "tool_receipt_id_invalid");
}

export function validateToolExecutionActionLocator(
  locator: ToolExecutionActionLocator,
): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.runId, "run_id_invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(locator.actionDigest)) {
    throw new RunStoreError("tool_action_digest_invalid");
  }
}

export function validatePrepareToolExecutionInput(
  input: PrepareToolExecutionInput,
): void {
  try {
    validateToolExecutionReceipt(input.receipt);
  } catch (error) {
    throw normalizeToolExecutionReceiptError(error);
  }
  validateQueueLease(
    input.lease,
    input.receipt.workItemId,
    "tool_receipt_work_item_mismatch",
  );
  if (input.receipt.status !== "prepared" || input.receipt.revision !== 1) {
    throw new RunStoreError("tool_receipt_not_prepared");
  }
}

export function validateTransitionToolExecutionInput(
  input: TransitionToolExecutionInput,
): void {
  validateToolExecutionReceiptLocator(input);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1
  ) {
    throw new RunStoreError("tool_receipt_revision_invalid");
  }
}

export function validateToolExecutionCompletionInput(
  input: CommitToolExecutionCompletionInput,
): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  if (
    input.receipt.tenantId !== input.commit.tenantId ||
    input.receipt.runId !== runId ||
    !Number.isSafeInteger(input.receipt.expectedRevision) ||
    input.receipt.expectedRevision < 1
  ) {
    throw new RunStoreError("tool_receipt_completion_identity_invalid");
  }
  const possibleAccounting = input.commit.events.at(-1);
  const accounting =
    possibleAccounting?.type === "run.goal.accounting.updated"
      ? possibleAccounting
      : null;
  const completed = input.commit.events.at(accounting === null ? -1 : -2);
  const prefixLength =
    input.commit.events.length - (accounting === null ? 1 : 2);
  const resumed = prefixLength === 1 ? input.commit.events[0] : null;
  if (
    input.commit.events.length < 1 ||
    input.commit.events.length > 3 ||
    prefixLength < 0 ||
    prefixLength > 1 ||
    input.commit.workItems.length !== 0 ||
    completed?.type !== "tool.completed" ||
    (resumed !== null && resumed.type !== "run.resumed") ||
    (accounting !== null &&
      (accounting.sequence !== completed.sequence + 1 ||
        accounting.occurredAt !== completed.occurredAt)) ||
    input.history.items.length !== 1
  ) {
    throw new RunStoreError("tool_completion_shape_invalid");
  }
  const history = input.history.items[0];
  if (
    history?.type !== "tool_result" ||
    history.status !== "completed" ||
    history.runId !== runId ||
    history.segmentId !== completed.data.segmentId ||
    history.callId !== completed.data.callId ||
    history.kind !== completed.data.kind ||
    history.output !== completed.data.output ||
    history.isError !== completed.data.isError ||
    input.receipt.result.output !== completed.data.output ||
    input.receipt.result.isError !== completed.data.isError ||
    input.receipt.result.artifactRef !== completed.data.artifactRef ||
    input.receipt.resolvedAt !== completed.occurredAt ||
    input.attempt.stepId.trim().length === 0 ||
    input.attempt.finishedAt !== completed.occurredAt
  ) {
    throw new RunStoreError("tool_completion_mismatch");
  }
  validateRunAttemptMutation(input.commit.tenantId, runId, input.lease, {
    ...input.attempt,
    status: "completed",
    checkpointDigest: null,
  });
  return runId;
}

export function applyToolCompletionGoalMutation(
  current: ThreadGoal | null,
  input: CommitToolExecutionCompletionInput,
  run: RunState,
): ThreadGoal | null {
  const possibleAccounting = input.commit.events.at(-1);
  const accounting =
    possibleAccounting?.type === "run.goal.accounting.updated"
      ? possibleAccounting
      : null;
  const completed = input.commit.events.at(accounting === null ? -1 : -2);
  if (completed?.type !== "tool.completed") {
    throw new RunStoreError("tool_completion_shape_invalid");
  }

  let boundary;
  try {
    boundary = accountThreadGoalAtToolBoundary(
      current,
      run,
      completed.occurredAt,
    );
  } catch (error) {
    throw mapRunGoalAccountingError(error);
  }
  const next = applyTurnStartGoalMutation(current, input.goal, {
    tenantId: run.tenantId,
    threadId: run.threadId,
  });
  if (stableJson(next) !== stableJson(boundary.goalState)) {
    throw new RunStoreError("tool_goal_accounting_result_mismatch");
  }

  const cursor = run.goalAccounting;
  if (cursor === null || cursor.attribution === null) {
    if (accounting !== null) {
      throw new RunStoreError("tool_goal_accounting_unexpected");
    }
    return next;
  }
  if (
    accounting === null ||
    next === null ||
    (next.status !== "active" && next.status !== "budgetLimited")
  ) {
    throw new RunStoreError("tool_goal_accounting_missing");
  }
  const nextBinding = {
    goalId: next.goalId,
    revision: next.revision,
    objectiveDigest: cursor.attribution.objectiveDigest,
  };
  let pendingSteering = cursor.pendingSteering;
  if (boundary.crossedBudget) {
    const actual = accounting.data.next.pendingSteering;
    if (
      actual === null ||
      actual.kind !== "budgetLimited" ||
      actual.createdAt !== completed.occurredAt ||
      stableJson(actual.target) !== stableJson(nextBinding)
    ) {
      throw new RunStoreError("tool_goal_budget_steering_missing");
    }
    pendingSteering = actual;
  } else if (pendingSteering !== null) {
    pendingSteering = { ...pendingSteering, target: nextBinding };
  }

  try {
    const expected = advanceRunGoalAccounting(cursor, {
      currentUsage: run.usage,
      throughRunSequence: completed.sequence,
      occurredAt: completed.occurredAt,
      nextBinding,
      pendingSteering,
      trackTime: true,
    }).next;
    if (stableJson(expected) !== stableJson(accounting.data.next)) {
      throw new RunStoreError("tool_goal_accounting_transition_mismatch");
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw mapRunGoalAccountingError(error);
  }
  return next;
}

export function validateToolExecutionUnknownOutcomeInput(
  input: CommitToolExecutionUnknownOutcomeInput,
): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  validateQueueRetry({
    ...input.lease,
    retryAfterMs: input.retryAfterMs,
    reasonCode: "tool_outcome_unknown",
  });
  const event = input.commit.events[0];
  if (
    input.receipt.tenantId !== input.commit.tenantId ||
    input.receipt.runId !== runId ||
    !Number.isSafeInteger(input.receipt.expectedRevision) ||
    input.receipt.expectedRevision < 1 ||
    input.commit.events.length !== 1 ||
    input.commit.workItems.length !== 0 ||
    event?.type !== "run.reconciliation.required" ||
    event.data.receiptId !== input.receipt.receiptId ||
    input.receipt.observedAt !== event.occurredAt ||
    input.attempt.finishedAt !== event.occurredAt ||
    input.attempt.stepId.trim().length === 0
  ) {
    throw new RunStoreError("tool_unknown_outcome_mismatch");
  }
  validateRunAttemptMutation(input.commit.tenantId, runId, input.lease, {
    ...input.attempt,
    status: "failed",
    checkpointDigest: null,
    failure: { code: "tool_outcome_unknown", retryable: true },
  });
  return runId;
}

export function applyToolExecutionUnknownOutcome(
  current: ToolExecutionReceiptState,
  input: CommitToolExecutionUnknownOutcomeInput,
): ToolExecutionReceiptState {
  if (current.status === "dispatched") {
    return applyToolExecutionTransition(current, {
      tenantId: input.receipt.tenantId,
      runId: input.receipt.runId,
      receiptId: input.receipt.receiptId,
      lease: input.lease,
      expectedRevision: input.receipt.expectedRevision,
      transition: {
        kind: "unknownOutcome",
        occurredAt: input.receipt.observedAt,
        providerReceiptId: input.receipt.providerReceiptId,
      },
    });
  }
  if (
    current.tenantId !== input.receipt.tenantId ||
    current.runId !== input.receipt.runId ||
    current.receiptId !== input.receipt.receiptId ||
    current.workItemId !== input.lease.workItemId ||
    current.revision !== input.receipt.expectedRevision ||
    current.status !== "unknownOutcome" ||
    (input.receipt.providerReceiptId !== null &&
      current.providerReceiptId !== input.receipt.providerReceiptId)
  ) {
    throw new RunStoreError("tool_receipt_unknown_outcome_conflict");
  }
  return current;
}

export function validateContextCompactionInput(
  input: CommitContextCompactionInput,
): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  const event = input.commit.events[0];
  const completionEvent = input.commit.events[1];
  const history = input.history.items[0];
  const completesRun = input.completion === "completeRun";
  if (
    (input.completion !== "continueRun" && !completesRun) ||
    input.commit.events.length !== (completesRun ? 2 : 1) ||
    input.commit.workItems.length !== 0 ||
    event?.type !== "context.compacted" ||
    input.history.items.length !== 1 ||
    history?.type !== "compaction" ||
    history.runId !== runId ||
    history.itemId !== event.data.compactionItemId ||
    history.mode !== event.data.mode ||
    history.replacesThroughSequence !== event.data.replacesThroughSequence ||
    input.attempt.stepId !== event.data.stepId ||
    input.attempt.finishedAt !== event.occurredAt ||
    (completesRun &&
      (event.data.mode !== "manual" ||
        completionEvent?.type !== "run.completed" ||
        completionEvent.data.outputRef !== null ||
        completionEvent.occurredAt !== event.occurredAt)) ||
    (!completesRun && event.data.mode !== "auto")
  ) {
    throw new RunStoreError("context_compaction_mismatch");
  }
  validateRunAttemptMutation(input.commit.tenantId, runId, input.lease, {
    ...input.attempt,
    status: "completed",
    checkpointDigest: null,
  });
  return runId;
}

export function validateContextCompactionReplay(
  input: CommitContextCompactionInput,
  step: RunStepState | null,
  attempt: RunAttemptState | null,
): Readonly<{ step: RunStepState; attempt: RunAttemptState }> {
  if (
    step?.status !== "completed" ||
    step.currentAttemptId !== input.attempt.attemptId ||
    attempt?.status !== "completed" ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.terminalAt !== input.attempt.finishedAt ||
    attempt.checkpointDigest !== null
  ) {
    throw new RunStoreError("context_compaction_replay_conflict");
  }
  return { step, attempt };
}

export function validateContextCompactionRunAuthority(
  input: CommitContextCompactionInput,
  currentRun: RunState | null,
): void {
  if (input.completion !== "completeRun") return;
  const runId = input.commit.events[0]?.identity.runId;
  if (
    currentRun === null ||
    currentRun.tenantId !== input.commit.tenantId ||
    currentRun.runId !== runId ||
    currentRun.purpose !== "manualCompaction" ||
    currentRun.goalBinding !== null
  ) {
    throw new RunStoreError("manual_compaction_run_authority_mismatch");
  }
}

export function validateAssistantSampleContinuationInput(
  input: CommitAssistantSampleContinuationInput,
): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(input.lease, input.lease.workItemId, "work_item_id_invalid");
  if (!Number.isSafeInteger(input.sampleIndex) || input.sampleIndex < 1) {
    throw new RunStoreError("assistant_sample_index_invalid");
  }
  const history = input.history.items[0];
  const lastHistory = input.history.items.at(-1);
  const completed = input.commit.events.at(-1);
  const completedSegmentId =
    completed?.type === "segment.provider_continuation"
      ? completed.data.segmentId
      : null;
  if (
    input.history.items.length === 0 ||
    input.history.items.some(
      (item, index) =>
        item.type !== "message" ||
        item.role !== "assistant" ||
        item.source !== "assistant_completion" ||
        item.tenantId !== input.commit.tenantId ||
        item.threadId !== input.modelState.threadId ||
        item.runId !== runId ||
        item.segmentId !== completedSegmentId ||
        item.sequence !== input.history.expectedLastSequence + index + 1,
    ) ||
    history?.type !== "message" ||
    history.role !== "assistant" ||
    history.source !== "assistant_completion" ||
    history.runId !== runId ||
    completed?.type !== "segment.provider_continuation" ||
    completed.data.sampleIndex !== input.sampleIndex ||
    completed.data.throughHistorySequence !== lastHistory?.sequence ||
    completed.data.segmentId !== history.segmentId ||
    input.attempt.finishedAt !== completed.occurredAt ||
    input.commit.workItems.length !== 0 ||
    input.modelState.tenantId !== input.commit.tenantId ||
    input.modelState.threadId !== history.threadId ||
    input.modelState.throughHistorySequence !== lastHistory?.sequence
  ) {
    throw new RunStoreError("assistant_sample_continuation_mismatch");
  }
  validateThreadModelState(input.modelState);
  validateRunAttemptMutation(input.commit.tenantId, runId, input.lease, {
    ...input.attempt,
    status: "completed",
    checkpointDigest: null,
  });
  return runId;
}

export function validateToolExecutionCompletionReplay(
  input: CommitToolExecutionCompletionInput,
  receipt: ToolExecutionReceiptState,
  step: RunStepState | null,
  attempt: RunAttemptState | null,
): Readonly<{ step: RunStepState; attempt: RunAttemptState }> {
  if (
    receipt.status !== "completed" ||
    receipt.revision !== input.receipt.expectedRevision + 1 ||
    receipt.providerReceiptId !== input.receipt.providerReceiptId ||
    receipt.resolvedAt !== input.receipt.resolvedAt ||
    stableJson(receipt.result) !== stableJson(input.receipt.result) ||
    receipt.stepId !== input.attempt.stepId ||
    receipt.attemptId !== input.attempt.attemptId ||
    step?.status !== "completed" ||
    step.currentAttemptId !== input.attempt.attemptId ||
    attempt?.status !== "completed" ||
    attempt.workItemId !== input.lease.workItemId ||
    attempt.leaseEpoch !== input.lease.leaseEpoch ||
    attempt.terminalAt !== input.attempt.finishedAt ||
    attempt.checkpointDigest !== null
  ) {
    throw new RunStoreError("tool_completion_replay_conflict");
  }
  return { step, attempt };
}

export function applyToolExecutionTransition(
  current: ToolExecutionReceiptState,
  input: TransitionToolExecutionInput,
): ToolExecutionReceiptState {
  if (
    current.tenantId !== input.tenantId ||
    current.runId !== input.runId ||
    current.receiptId !== input.receiptId ||
    current.workItemId !== input.lease.workItemId
  ) {
    throw new RunStoreError("tool_receipt_not_found");
  }
  if (current.revision !== input.expectedRevision) {
    throw new RunStoreError("tool_receipt_revision_conflict");
  }
  try {
    switch (input.transition.kind) {
      case "dispatch":
        return dispatchToolExecutionReceipt(
          current,
          input.transition.occurredAt,
        );
      case "unknownOutcome":
        return markToolExecutionUnknownOutcome(current, {
          observedAt: input.transition.occurredAt,
          providerReceiptId: input.transition.providerReceiptId,
        });
      case "complete":
        return resolveToolExecutionReceipt(current, {
          status: "completed",
          resolvedAt: input.transition.occurredAt,
          providerReceiptId: input.transition.providerReceiptId,
          result: input.transition.result,
        });
      case "cancel":
        return resolveToolExecutionReceipt(current, {
          status: "canceled",
          resolvedAt: input.transition.occurredAt,
          providerReceiptId: input.transition.providerReceiptId,
        });
    }
  } catch (error) {
    throw normalizeToolExecutionReceiptError(error);
  }
}

function normalizeToolExecutionReceiptError(error: unknown): Error {
  return error instanceof ToolExecutionReceiptError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("tool_receipt_state_invalid", { cause: error });
}

export function validateRunAttemptLocator(locator: RunAttemptLocator): void {
  validateRunStepLocator(locator);
  requireNonEmpty(locator.attemptId, "attempt_id_invalid");
}

export function validateRunAttemptPage(
  locator: RunStepLocator,
  afterAttemptNumber: number,
  limit: number,
): void {
  validateRunStepLocator(locator);
  if (!Number.isSafeInteger(afterAttemptNumber) || afterAttemptNumber < 0) {
    throw new RunStoreError("attempt_cursor_invalid");
  }
  validateLimit(limit);
}

export function validateBeginRunAttemptInput(
  input: BeginRunAttemptInput,
): void {
  validateRunStepLocator(input);
  requireNonEmpty(input.attemptId, "attempt_id_invalid");
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  if (
    input.mode !== undefined &&
    input.mode !== "execute" &&
    input.mode !== "reconcile"
  ) {
    throw new RunStoreError("attempt_mode_invalid");
  }
  if (input.mode === "reconcile" && input.kind !== "tool") {
    throw new RunStoreError("attempt_reconcile_kind_invalid");
  }
  parseQueueTimestamp(input.startedAt, "attempt_started_at_invalid");
}

export function validateRetryRunAttemptInput(
  input: RetryRunAttemptInput,
): void {
  validateRunAttemptMutation(input.tenantId, input.runId, input.lease, {
    ...input.attempt,
    status: "failed",
  });
  if (input.attempt.failure.retryable !== true) {
    throw new RunStoreError("attempt_retryability_invalid");
  }
  validateQueueRetry({
    ...input.lease,
    retryAfterMs: input.retryAfterMs,
    reasonCode: input.attempt.failure.code,
  });
}

export function validateCompleteRunAttemptInput(
  input: CompleteRunAttemptInput,
): void {
  validateRunAttemptMutation(input.tenantId, input.runId, input.lease, {
    ...input.attempt,
    status: "completed",
  });
}

export function validateLeasedRunTerminalInput(
  input: CommitLeasedRunTerminalInput,
): string {
  const runId = validateCommitInput(input.commit);
  validateQueueLease(
    input.lease,
    input.lease.workItemId,
    "work_item_id_invalid",
  );
  if (
    (input.commit.events.length !== 1 && input.commit.events.length !== 2) ||
    input.commit.workItems.length !== 0
  ) {
    throw new RunStoreError("run_terminal_shape_invalid");
  }
  const event = input.commit.events.at(-1);
  if (event?.type !== "run.failed" && event?.type !== "run.canceled") {
    throw new RunStoreError("run_terminal_shape_invalid");
  }
  if (
    input.commit.events.length === 2 &&
    input.commit.events[0]?.type !== "run.goal.accounting.updated"
  ) {
    throw new RunStoreError("run_terminal_shape_invalid");
  }
  if (input.attempt === null) {
    return runId;
  }
  validateRunAttemptMutation(
    input.commit.tenantId,
    runId,
    input.lease,
    input.attempt,
  );
  if (
    input.attempt.finishedAt !== event.occurredAt ||
    (event.type === "run.failed" &&
      (input.attempt.status !== "failed" ||
        input.attempt.failure.code !== event.data.code ||
        input.attempt.failure.retryable !== event.data.retryable)) ||
    (event.type === "run.canceled" && input.attempt.status !== "canceled")
  ) {
    throw new RunStoreError("run_attempt_terminal_mismatch");
  }
  return runId;
}

function validateRunAttemptMutation(
  tenantId: string,
  runId: string,
  lease: BeginRunAttemptInput["lease"],
  attempt: RunAttemptTerminalMutation,
): void {
  validateRunAttemptLocator({
    tenantId,
    runId,
    stepId: attempt.stepId,
    attemptId: attempt.attemptId,
  });
  validateQueueLease(lease, lease.workItemId, "work_item_id_invalid");
  parseQueueTimestamp(attempt.finishedAt, "attempt_finished_at_invalid");
  if (
    attempt.checkpointDigest !== null &&
    !/^sha256:[a-f0-9]{64}$/.test(attempt.checkpointDigest)
  ) {
    throw new RunStoreError("attempt_checkpoint_digest_invalid");
  }
  if (attempt.status === "failed") {
    requireBoundedString(
      attempt.failure.code,
      256,
      "attempt_failure_code_invalid",
    );
  }
}

export function validateThreadCommitInput(input: CommitThreadInput): string {
  requireNonEmpty(input.tenantId, "tenant_id_invalid");
  requireBoundedString(
    input.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(input.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    input.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new RunStoreError("expected_revision_invalid");
  }
  if (
    input.tombstone !== undefined &&
    (input.tombstone.expectedActiveRunId !== null ||
      (input.tombstone.expectedGoalRevision !== null &&
        (!Number.isSafeInteger(input.tombstone.expectedGoalRevision) ||
          input.tombstone.expectedGoalRevision < 1)) ||
      input.events.at(-1)?.type !== "thread.deleted" ||
      input.events.at(-1)?.occurredAt !== input.tombstone.occurredAt)
  ) {
    throw new RunStoreError("thread_tombstone_fence_invalid");
  }
  if (input.events.length === 0) {
    throw new RunStoreError("thread_events_empty");
  }
  if (input.events.some((event) => event.type === "thread.rolled_back")) {
    throw new RunStoreError("thread_rollback_store_required");
  }
  const threadId = input.events[0].identity.threadId;
  requireNonEmpty(threadId, "thread_id_invalid");
  if (input.sourceFence !== undefined) {
    requireBoundedString(
      input.sourceFence.threadId,
      512,
      "thread_fork_source_id_invalid",
    );
    requireBoundedString(
      input.sourceFence.spaceId,
      256,
      "thread_fork_source_space_id_invalid",
    );
    if (
      input.sourceFence.threadId === threadId ||
      !Number.isSafeInteger(input.sourceFence.expectedRevision) ||
      input.sourceFence.expectedRevision < 1
    ) {
      throw new RunStoreError("thread_fork_source_invalid");
    }
  }
  const forkEvents = input.events.filter(
    (
      event,
    ): event is Extract<ThreadLifecycleEvent, { type: "thread.forked" }> =>
      event.type === "thread.forked",
  );
  if (input.sourceFence === undefined) {
    if (forkEvents.length > 0) {
      throw new RunStoreError("thread_fork_source_fence_missing");
    }
  } else {
    const forked = forkEvents[0];
    if (
      forkEvents.length !== 1 ||
      forked === undefined ||
      input.events.at(-1) !== forked ||
      input.events[0]?.type !== "thread.created" ||
      input.expectedRevision !== 0 ||
      input.history.expectedLastSequence !== 0 ||
      forked.data.sourceThreadId !== input.sourceFence.threadId ||
      forked.data.throughHistorySequence !== input.history.items.length ||
      forked.data.throughMessageSequence !== input.messages.length
    ) {
      throw new RunStoreError("thread_fork_shape_invalid");
    }
  }
  if (
    input.events[0].type === "thread.created" &&
    input.events[0].data.tenantId !== input.tenantId
  ) {
    throw new RunStoreError("tenant_id_mismatch");
  }
  return threadId;
}

export function validateThreadReceiptResult(
  value: unknown,
  locator: ThreadLocator,
): asserts value is CommitThreadResult {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "disposition",
      "state",
      "events",
      "messages",
      "historyItems",
    ]) ||
    value.disposition !== "committed" ||
    !isPlainObject(value.state) ||
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    !Array.isArray(value.messages) ||
    !Array.isArray(value.historyItems)
  ) {
    throw new RunStoreError("thread_idempotency_receipt_invalid");
  }
  const result = value as unknown as CommitThreadResult;
  try {
    validateThreadState(result.state);
    for (const event of result.events) {
      validateThreadLifecycleEvent(event);
    }
  } catch (error) {
    throw new RunStoreError("thread_idempotency_receipt_invalid", {
      cause: error,
    });
  }
  if (
    result.state.tenantId !== locator.tenantId ||
    result.state.threadId !== locator.threadId ||
    result.events.some(
      (event, index) =>
        event.identity.threadId !== locator.threadId ||
        event.sequence !==
          result.state.lastEventSequence - result.events.length + index + 1,
    ) ||
    result.events.at(-1)?.sequence !== result.state.lastEventSequence ||
    result.events.at(-1)?.occurredAt !== result.state.updatedAt
  ) {
    throw new RunStoreError("thread_idempotency_receipt_invalid");
  }
  try {
    validateThreadEvents(result.events, locator.threadId, () => false);
    validateMessages(
      result.messages,
      result.events,
      locator.threadId,
      locator.tenantId,
      () => false,
    );
    for (const item of result.historyItems) {
      validateModelHistoryItem(item);
      if (
        item.tenantId !== locator.tenantId ||
        item.threadId !== locator.threadId
      ) {
        throw new RunStoreError("thread_idempotency_receipt_invalid");
      }
    }
    validateModelHistoryPairing(result.historyItems);
  } catch (error) {
    if (
      error instanceof RunStoreError &&
      error.code === "thread_idempotency_receipt_invalid"
    ) {
      throw error;
    }
    throw new RunStoreError("thread_idempotency_receipt_invalid", {
      cause: error,
    });
  }
  validateThreadReceiptTerminalEvent(result);
}

export function validateThreadRollbackReceiptQuery(
  query: ThreadRollbackReceiptQuery,
): void {
  validateThreadLocator(query);
  requireBoundedString(
    query.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(query.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    query.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
}

export function prepareThreadRollbackCommit(
  input: CommitThreadRollbackInput,
  current: ThreadState | null,
  history: readonly ModelHistoryItem[],
  messages: readonly MessageRecord[],
): Readonly<{
  state: ThreadState;
  invalidatedMessages: readonly InvalidatedMessage[];
}> {
  const threadId = input.event.identity.threadId;
  validateThreadRollbackReceiptQuery({
    tenantId: input.tenantId,
    threadId,
    idempotency: input.idempotency,
  });
  if (
    !Number.isSafeInteger(input.expectedThreadRevision) ||
    input.expectedThreadRevision < 1 ||
    !Number.isSafeInteger(input.expectedHistorySequence) ||
    input.expectedHistorySequence < 0
  ) {
    throw new RunStoreError("thread_rollback_expected_revision_invalid");
  }
  if (
    current === null ||
    current.tenantId !== input.tenantId ||
    current.threadId !== threadId
  ) {
    throw new RunStoreError("thread_not_found");
  }
  if (current.revision !== input.expectedThreadRevision) {
    throw new RunStoreError("revision_conflict");
  }
  const historyHead = history.at(-1)?.sequence ?? 0;
  if (
    historyHead !== input.expectedHistorySequence ||
    input.marker.historyThroughSequence !== input.expectedHistorySequence ||
    input.marker.sequence !== input.expectedHistorySequence + 1
  ) {
    throw new RunStoreError("model_history_sequence_conflict");
  }
  try {
    validateThreadRollbackArtifacts(history, {
      boundary: {
        requestedTurns: input.event.data.requestedTurns,
        removedTurns: input.event.data.removedTurns,
        historyFromSequence: input.event.data.historyFromSequence,
        historyThroughSequence: input.event.data.historyThroughSequence,
        markerHistorySequence: input.event.data.markerHistorySequence,
      },
      marker: input.marker,
      event: input.event,
    });
  } catch (error) {
    throw new RunStoreError("thread_rollback_artifacts_invalid", {
      cause: error,
    });
  }
  let state: ThreadState;
  try {
    state = reduceThreadLifecycleEvent(current, input.event);
  } catch (error) {
    throw new RunStoreError("thread_rollback_event_invalid", { cause: error });
  }
  const invalidatedMessages = deriveRollbackMessageInvalidations(
    history,
    messages,
    input,
  );
  return { state, invalidatedMessages };
}

export function validateThreadRollbackReceiptResult(
  value: unknown,
  locator: ThreadLocator,
): asserts value is CommitThreadRollbackResult {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "disposition",
      "state",
      "event",
      "marker",
      "invalidatedMessages",
      "invalidatedContinuationCount",
      "invalidatedModelState",
    ]) ||
    value.disposition !== "committed" ||
    !isPlainObject(value.state) ||
    !isPlainObject(value.event) ||
    !isPlainObject(value.marker) ||
    !Array.isArray(value.invalidatedMessages) ||
    !Number.isSafeInteger(value.invalidatedContinuationCount) ||
    Number(value.invalidatedContinuationCount) < 0 ||
    typeof value.invalidatedModelState !== "boolean"
  ) {
    throw new RunStoreError("thread_rollback_receipt_invalid");
  }
  const result = value as unknown as CommitThreadRollbackResult;
  try {
    validateThreadState(result.state);
    validateThreadLifecycleEvent(result.event);
    validateModelHistoryItem(result.marker);
  } catch (error) {
    throw new RunStoreError("thread_rollback_receipt_invalid", {
      cause: error,
    });
  }
  if (
    result.event.type !== "thread.rolled_back" ||
    result.marker.type !== "rollback" ||
    result.state.tenantId !== locator.tenantId ||
    result.state.threadId !== locator.threadId ||
    result.state.status !== "active" ||
    result.event.identity.threadId !== locator.threadId ||
    result.event.sequence !== result.state.lastEventSequence ||
    result.event.occurredAt !== result.state.updatedAt ||
    result.marker.tenantId !== locator.tenantId ||
    result.marker.threadId !== locator.threadId ||
    result.marker.itemId !== result.event.data.markerItemId ||
    result.marker.threadEventId !== result.event.eventId ||
    result.marker.rollbackId !== result.event.data.rollbackId ||
    result.marker.requestedTurns !== result.event.data.requestedTurns ||
    result.marker.removedTurns !== result.event.data.removedTurns ||
    result.marker.historyFromSequence !==
      result.event.data.historyFromSequence ||
    result.marker.historyThroughSequence !==
      result.event.data.historyThroughSequence ||
    result.marker.sequence !== result.event.data.markerHistorySequence
  ) {
    throw new RunStoreError("thread_rollback_receipt_invalid");
  }
  const messageIds = new Set<string>();
  const messageSequences = new Set<number>();
  const historySequences = new Set<number>();
  for (const invalidated of result.invalidatedMessages) {
    if (
      !isPlainObject(invalidated) ||
      !isPlainObject(invalidated.invalidation) ||
      typeof invalidated.messageId !== "string" ||
      invalidated.messageId.trim().length === 0 ||
      !Number.isSafeInteger(invalidated.messageSequence) ||
      invalidated.messageSequence < 1 ||
      invalidated.invalidation.rollbackId !== result.marker.rollbackId ||
      invalidated.invalidation.markerItemId !== result.marker.itemId ||
      invalidated.invalidation.invalidatedAt !== result.event.occurredAt ||
      !Number.isSafeInteger(invalidated.invalidation.historySequence) ||
      invalidated.invalidation.historySequence <
        (result.marker.historyFromSequence ?? Number.MAX_SAFE_INTEGER) ||
      invalidated.invalidation.historySequence >
        result.marker.historyThroughSequence ||
      messageIds.has(invalidated.messageId) ||
      messageSequences.has(invalidated.messageSequence) ||
      historySequences.has(invalidated.invalidation.historySequence)
    ) {
      throw new RunStoreError("thread_rollback_receipt_invalid");
    }
    messageIds.add(invalidated.messageId);
    messageSequences.add(invalidated.messageSequence);
    historySequences.add(invalidated.invalidation.historySequence);
  }
}

function deriveRollbackMessageInvalidations(
  history: readonly ModelHistoryItem[],
  messages: readonly MessageRecord[],
  input: CommitThreadRollbackInput,
): readonly InvalidatedMessage[] {
  return deriveRollbackMessageInvalidationsFromLedger(
    history,
    history,
    messages,
    input,
  );
}

function deriveRollbackMessageInvalidationsFromLedger(
  historyBeforeMarker: readonly ModelHistoryItem[],
  ledgerHistory: readonly ModelHistoryItem[],
  messages: readonly MessageRecord[],
  input: Pick<CommitThreadRollbackInput, "tenantId" | "event" | "marker">,
): readonly InvalidatedMessage[] {
  const historyMessages = ledgerHistory.filter(isModelHistoryMessageBacked);
  if (historyMessages.length !== messages.length) {
    throw new RunStoreError("message_history_correlation_invalid");
  }
  const pairs = messages.map((message, index) => {
    const historyItem = historyMessages[index];
    if (
      historyItem === undefined ||
      message.tenantId !== input.tenantId ||
      message.threadId !== input.event.identity.threadId ||
      message.sequence !== index + 1 ||
      message.role !== historyItem.role ||
      message.content !== historyItem.content ||
      message.contentDigest !== historyItem.contentDigest ||
      message.createdAt !== historyItem.createdAt ||
      !messageOriginMatchesHistory(message, historyItem)
    ) {
      throw new RunStoreError("message_history_correlation_invalid");
    }
    return { message, historyItem };
  });
  const boundary = input.marker.historyFromSequence;
  if (boundary === null) return [];
  const effectiveTargetSequences = new Set(
    projectEffectiveModelHistory(historyBeforeMarker)
      .items.filter(
        (item) =>
          isModelHistoryMessageBacked(item) &&
          item.sequence >= boundary &&
          item.sequence <= input.marker.historyThroughSequence,
      )
      .map(({ sequence }) => sequence),
  );
  return pairs.flatMap(({ message, historyItem }) =>
    effectiveTargetSequences.has(historyItem.sequence)
      ? [
          {
            messageId: message.messageId,
            messageSequence: message.sequence,
            invalidation: {
              rollbackId: input.marker.rollbackId,
              markerItemId: input.marker.itemId,
              historySequence: historyItem.sequence,
              invalidatedAt: input.event.occurredAt,
            },
          },
        ]
      : [],
  );
}

function messageOriginMatchesHistory(
  message: MessageRecord,
  historyItem: Extract<ModelHistoryItem, { type: "message" }>,
): boolean {
  if (historyItem.source !== "automation_invocation") {
    return message.origin === null || message.origin === undefined;
  }
  return (
    message.origin !== null &&
    message.origin !== undefined &&
    stableJson(message.origin) === stableJson(historyItem.origin)
  );
}

export function validateThreadRollbackReceiptAuthority(
  result: CommitThreadRollbackResult,
  history: readonly ModelHistoryItem[],
  messages: readonly MessageRecord[],
  storedInvalidatedMessages: readonly InvalidatedMessage[],
  effects: Readonly<{
    invalidatedContinuationCount: number;
    invalidatedModelState: boolean;
  }>,
): void {
  const markerIndex = result.marker.sequence - 1;
  const storedMarker = history[markerIndex];
  if (
    storedMarker === undefined ||
    stableJson(storedMarker) !== stableJson(result.marker)
  ) {
    throw new RunStoreError("thread_rollback_receipt_authority_invalid");
  }
  const historyBeforeMarker = history.slice(0, markerIndex);
  try {
    validateThreadRollbackArtifacts(historyBeforeMarker, {
      boundary: {
        requestedTurns: result.event.data.requestedTurns,
        removedTurns: result.event.data.removedTurns,
        historyFromSequence: result.event.data.historyFromSequence,
        historyThroughSequence: result.event.data.historyThroughSequence,
        markerHistorySequence: result.event.data.markerHistorySequence,
      },
      marker: result.marker,
      event: result.event,
    });
  } catch (error) {
    throw new RunStoreError("thread_rollback_receipt_authority_invalid", {
      cause: error,
    });
  }
  const expectedInvalidations = deriveRollbackMessageInvalidationsFromLedger(
    historyBeforeMarker,
    history,
    messages,
    {
      tenantId: result.state.tenantId,
      event: result.event,
      marker: result.marker,
    },
  );
  if (
    stableJson(result.invalidatedMessages) !==
      stableJson(expectedInvalidations) ||
    stableJson(storedInvalidatedMessages) !==
      stableJson(expectedInvalidations) ||
    result.invalidatedContinuationCount !==
      effects.invalidatedContinuationCount ||
    result.invalidatedModelState !== effects.invalidatedModelState
  ) {
    throw new RunStoreError("thread_rollback_receipt_authority_invalid");
  }
}

function validateThreadReceiptTerminalEvent(result: CommitThreadResult): void {
  const event = result.events.at(-1);
  if (event === undefined) {
    throw new RunStoreError("thread_idempotency_receipt_invalid");
  }
  let valid: boolean;
  switch (event.type) {
    case "thread.created":
      valid =
        result.state.status === "active" &&
        result.state.revision === 1 &&
        result.state.title === event.data.title;
      break;
    case "thread.message.appended":
      valid =
        result.state.status === "active" &&
        result.state.lastMessageSequence === event.data.messageSequence;
      break;
    case "thread.forked":
      valid =
        result.state.status === "active" &&
        result.state.forkedFromThreadId === event.data.sourceThreadId &&
        result.state.forkedThroughHistorySequence ===
          event.data.throughHistorySequence;
      break;
    case "thread.archived":
      valid =
        result.state.status === "archived" &&
        result.state.archivedAt === event.occurredAt;
      break;
    case "thread.unarchived":
      valid =
        result.state.status === "active" && result.state.archivedAt === null;
      break;
    case "thread.renamed":
      valid =
        result.state.status !== "deleted" &&
        result.state.title === event.data.title;
      break;
    case "thread.rolled_back": {
      const marker = result.historyItems.at(-1);
      valid =
        result.state.status === "active" &&
        marker?.type === "rollback" &&
        marker.itemId === event.data.markerItemId &&
        marker.threadEventId === event.eventId &&
        marker.rollbackId === event.data.rollbackId &&
        marker.sequence === event.data.markerHistorySequence;
      break;
    }
    case "thread.deleted":
      valid =
        result.state.status === "deleted" &&
        result.state.title === null &&
        result.state.archivedAt === null &&
        result.state.deletedAt === event.occurredAt &&
        result.state.deletedByActorId === event.data.actorId;
      break;
  }
  if (!valid) {
    throw new RunStoreError("thread_idempotency_receipt_invalid");
  }
}

export function validateTextRunCompletionInput(
  input: CommitTextRunCompletionInput,
): { runId: string; threadId: string } {
  const runId = validateCommitInput({
    tenantId: input.tenantId,
    idempotency: input.idempotency,
    expectedRevision: input.run.expectedRevision,
    events: input.run.events,
    outbox: input.run.outbox,
    workItems: [],
  });
  const threadId = validateThreadCommitInput({
    tenantId: input.tenantId,
    idempotency: input.idempotency,
    expectedRevision: input.thread.expectedRevision,
    events: input.thread.events,
    messages: input.thread.messages,
    history: input.history,
  });
  const checkpointOffset = input.continuation.checkpoint === null ? 0 : 1;
  const checkpointEvent = checkpointOffset === 0 ? null : input.run.events[0];
  const segmentCompletedEvent = input.run.events[checkpointOffset];
  const runMessageEvent = input.run.events[checkpointOffset + 1];
  const possiblePlanEvent = input.run.events[checkpointOffset + 2];
  const planOffset = possiblePlanEvent?.type === "plan.proposed" ? 1 : 0;
  const possibleAccountingEvent =
    input.run.events[checkpointOffset + 2 + planOffset];
  const accountingOffset =
    possibleAccountingEvent?.type === "run.goal.accounting.updated" ? 1 : 0;
  const runCompletedEvent =
    input.run.events[checkpointOffset + 2 + planOffset + accountingOffset];
  if (
    input.run.events.length !==
      checkpointOffset + 3 + planOffset + accountingOffset ||
    (checkpointEvent !== null &&
      checkpointEvent.type !== "segment.checkpointed") ||
    segmentCompletedEvent?.type !== "segment.completed" ||
    runMessageEvent?.type !== "message.completed" ||
    runCompletedEvent?.type !== "run.completed" ||
    input.thread.events.length !== 1 ||
    input.thread.events[0]?.type !== "thread.message.appended" ||
    input.thread.messages.length !== 1 ||
    input.history.items.length !== 1
  ) {
    throw new RunStoreError("text_completion_shape_invalid");
  }
  const threadMessageEvent = input.thread.events[0];
  const message = input.thread.messages[0];
  const historyItem = input.history.items[0];
  if (
    message === undefined ||
    runMessageEvent.data.messageId !== message.messageId ||
    runMessageEvent.data.messageSequence !== message.sequence ||
    runMessageEvent.data.role !== message.role ||
    runMessageEvent.data.contentDigest !== message.contentDigest ||
    threadMessageEvent.data.messageId !== message.messageId ||
    threadMessageEvent.data.messageSequence !== message.sequence ||
    threadMessageEvent.data.role !== message.role ||
    threadMessageEvent.data.contentDigest !== message.contentDigest ||
    message.threadId !== threadId ||
    runCompletedEvent.data.outputRef !== `message:${message.messageId}` ||
    historyItem?.type !== "message" ||
    historyItem.role !== "assistant" ||
    historyItem.source !== "assistant_completion" ||
    historyItem.tenantId !== input.tenantId ||
    historyItem.threadId !== threadId ||
    historyItem.runId !== runId ||
    historyItem.segmentId !== segmentCompletedEvent.data.segmentId ||
    historyItem.content !== message.content ||
    historyItem.contentDigest !== message.contentDigest ||
    historyItem.createdAt !== message.createdAt
  ) {
    throw new RunStoreError("text_completion_message_mismatch");
  }
  validateRunAttemptMutation(input.tenantId, runId, input.lease, {
    ...input.attempt,
    status: "completed",
  });
  if (
    input.attempt.finishedAt !== runCompletedEvent.occurredAt ||
    input.attempt.checkpointDigest !==
      (checkpointEvent?.type === "segment.checkpointed"
        ? checkpointEvent.data.checkpointDigest
        : null)
  ) {
    throw new RunStoreError("text_completion_attempt_mismatch");
  }
  validateThreadContinuationLocator({
    tenantId: input.tenantId,
    threadId,
    agentVersionId: input.continuation.agentVersionId,
    adapterName: input.continuation.adapterName,
    adapterVersion: input.continuation.adapterVersion,
    modelId: input.continuation.modelId,
  });
  requireBoundedString(
    input.continuation.contextRevision,
    512,
    "context_revision_invalid",
  );
  if (input.continuation.checkpoint !== null) {
    let checkpoint: ReturnType<typeof parseExecutionProviderCheckpoint>;
    try {
      checkpoint = parseExecutionProviderCheckpoint(
        input.continuation.checkpoint,
      );
    } catch (error) {
      throw new RunStoreError("provider_checkpoint_invalid", { cause: error });
    }
    if (
      checkpoint.adapterName !== input.continuation.adapterName ||
      checkpoint.adapterVersion !== input.continuation.adapterVersion ||
      checkpoint.modelId !== input.continuation.modelId
    ) {
      throw new RunStoreError("provider_checkpoint_identity_mismatch");
    }
  }
  validateThreadModelState(input.modelState);
  if (
    input.modelState.tenantId !== input.tenantId ||
    input.modelState.threadId !== threadId ||
    input.modelState.agentVersionId !== input.continuation.agentVersionId ||
    input.modelState.adapterName !== input.continuation.adapterName ||
    input.modelState.adapterVersion !== input.continuation.adapterVersion ||
    input.modelState.modelId !== input.continuation.modelId ||
    input.modelState.throughHistorySequence !== historyItem.sequence ||
    input.modelState.contextRevision !== input.continuation.contextRevision ||
    input.modelState.updatedAt !== message.createdAt
  ) {
    throw new RunStoreError("thread_model_state_mismatch");
  }
  return { runId, threadId };
}

export function validateTextRunPlanCorrelation(
  input: CommitTextRunCompletionInput,
  currentRun: RunState,
): void {
  const message = input.thread.messages[0];
  const proposedPlan = message?.proposedPlan ?? null;
  const planEvents = input.run.events.filter(
    (event): event is Extract<RunLifecycleEvent, { type: "plan.proposed" }> =>
      event.type === "plan.proposed",
  );
  if (currentRun.collaborationMode !== "plan") {
    if (proposedPlan !== null || planEvents.length !== 0) {
      throw new RunStoreError("proposed_plan_mode_invalid");
    }
    return;
  }
  const event = planEvents[0];
  if (
    message === undefined ||
    proposedPlan === null ||
    planEvents.length !== 1 ||
    event === undefined ||
    proposedPlan.tenantId !== input.tenantId ||
    proposedPlan.threadId !== message.threadId ||
    proposedPlan.runId !== currentRun.runId ||
    proposedPlan.messageId !== message.messageId ||
    proposedPlan.content !== message.content ||
    proposedPlan.contentDigest !== message.contentDigest ||
    proposedPlan.createdAt !== message.createdAt ||
    event.identity.runId !== currentRun.runId ||
    event.data.planId !== proposedPlan.planId ||
    event.data.messageId !== message.messageId ||
    event.data.messageSequence !== message.sequence ||
    event.data.contentDigest !== message.contentDigest ||
    event.occurredAt !== message.createdAt
  ) {
    throw new RunStoreError("proposed_plan_completion_mismatch");
  }
}

export function validateTurnStartInput(input: CommitTurnStartInput): {
  runId: string;
  threadId: string;
} {
  const runId = validateCommitInput({
    tenantId: input.tenantId,
    idempotency: input.idempotency,
    expectedRevision: input.run.expectedRevision,
    events: input.run.events,
    outbox: input.run.outbox,
    workItems: input.run.workItems,
  });
  const threadId = validateThreadCommitInput({
    tenantId: input.tenantId,
    idempotency: input.idempotency,
    expectedRevision: input.thread.expectedRevision,
    events: input.thread.events,
    messages: input.thread.messages,
    history: input.thread.history,
  });
  const runEvent = input.run.events[0];
  const threadEvent = input.thread.events[0];
  const message = input.thread.messages[0];
  const historyItem = input.thread.history.items[0];
  if (
    input.run.expectedRevision !== 0 ||
    input.thread.expectedRevision < 1 ||
    input.run.events.length !== 1 ||
    runEvent?.type !== "run.created" ||
    input.thread.events.length !== 1 ||
    threadEvent?.type !== "thread.message.appended" ||
    input.thread.messages.length !== 1 ||
    message?.role !== "user" ||
    input.thread.history.items.length !== 1 ||
    historyItem?.type !== "message" ||
    historyItem.role !== "user" ||
    historyItem.source !== "thread_message" ||
    historyItem.runId !== null ||
    historyItem.segmentId !== null ||
    input.run.outbox.length !== 1 ||
    input.run.workItems.length !== 1
  ) {
    throw new RunStoreError("turn_start_shape_invalid");
  }
  if (
    runEvent.data.threadId !== threadId ||
    runEvent.data.tenantId !== input.tenantId ||
    threadEvent.data.messageId !== message.messageId ||
    threadEvent.data.messageSequence !== message.sequence ||
    threadEvent.data.role !== message.role ||
    threadEvent.data.contentDigest !== message.contentDigest ||
    message.threadId !== threadId ||
    historyItem.tenantId !== input.tenantId ||
    historyItem.threadId !== threadId ||
    historyItem.content !== message.content ||
    historyItem.contentDigest !== message.contentDigest ||
    historyItem.createdAt !== message.createdAt ||
    threadEvent.occurredAt !== message.createdAt ||
    runEvent.occurredAt !== message.createdAt
  ) {
    throw new RunStoreError("turn_start_message_mismatch");
  }
  if (
    (input.goal.kind === "clear" &&
      runEvent.data.collaborationMode !== "plan") ||
    (input.goal.kind !== "clear" &&
      runEvent.data.collaborationMode !== "default") ||
    (input.goal.kind === "set" && input.goal.goal.objective !== message.content)
  ) {
    throw new RunStoreError("turn_start_goal_mode_mismatch");
  }
  return { runId, threadId };
}

export function applyTurnStartGoalMutation(
  current: ThreadGoal | null,
  mutation: TurnStartGoalMutation,
  identity: Readonly<{ tenantId: string; threadId: string }>,
): ThreadGoal | null {
  const currentRevision = current?.revision ?? null;
  if (mutation.expectedRevision !== currentRevision) {
    throw new RunStoreError("goal_revision_conflict");
  }
  if (mutation.kind === "keep") return current;
  if (mutation.kind === "clear") return null;

  try {
    validateThreadGoal(mutation.goal);
  } catch (error) {
    throw error instanceof ThreadGoalError
      ? new RunStoreError(error.code, { cause: error })
      : error;
  }
  const next = mutation.goal;
  if (
    next.tenantId !== identity.tenantId ||
    next.threadId !== identity.threadId ||
    next.revision !== (current?.revision ?? 0) + 1 ||
    (current !== null &&
      current.status !== "complete" &&
      next.goalId !== current.goalId) ||
    (current !== null &&
      next.goalId === current.goalId &&
      next.createdAt !== current.createdAt)
  ) {
    throw new RunStoreError("goal_mutation_invalid");
  }
  return next;
}

export function validateThreadGoalMutationInput(
  input: CommitThreadGoalMutationInput,
): void {
  requireBoundedString(input.tenantId, 256, "tenant_id_invalid");
  requireBoundedString(input.threadId, 512, "thread_id_invalid");
  requireBoundedString(
    input.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(input.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    input.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
  if (
    input.expectedActiveRun !== null &&
    (typeof input.expectedActiveRun.runId !== "string" ||
      input.expectedActiveRun.runId.trim().length === 0 ||
      !Number.isSafeInteger(input.expectedActiveRun.expectedRevision) ||
      input.expectedActiveRun.expectedRevision < 1)
  ) {
    throw new RunStoreError("goal_active_run_fence_invalid");
  }
}

export function validateThreadGoalActiveRunFence(
  expected: CommitThreadGoalMutationInput["expectedActiveRun"],
  current: RunState | null,
): void {
  if (
    (expected === null) !== (current === null) ||
    (expected !== null &&
      current !== null &&
      (expected.runId !== current.runId ||
        expected.expectedRevision !== current.revision))
  ) {
    throw new RunStoreError("goal_active_run_conflict");
  }
}

export function shouldCancelQueuedRunForGoal(
  run: RunState | null,
  goal: ThreadGoal | null,
  trigger: "default" | "goalContinuation" | "goalActivation",
): boolean {
  if (
    run === null ||
    run.status !== "queued" ||
    run.collaborationMode !== "default" ||
    trigger === "default"
  ) {
    return false;
  }
  if (goal?.status !== "active") {
    return run.goalBinding !== null;
  }
  return !goalBindingMatchesGoal(run.goalBinding, goal);
}

export function reduceThreadGoalQueuedRunCancellation(
  input: ThreadGoalQueuedRunCancellation,
  current: RunState,
  eventIdExists: (eventId: string) => boolean,
  outboxIdExists: (messageId: string) => boolean,
): RunState {
  if (input.events.length !== 2 || input.outbox.length !== 2) {
    throw new RunStoreError("goal_queued_run_cancellation_invalid");
  }
  validateEvents(input.events, current.runId, eventIdExists);
  const requested = input.events[0];
  const canceled = input.events[1];
  if (
    requested?.type !== "run.cancel.requested" ||
    canceled?.type !== "run.canceled" ||
    requested.occurredAt !== canceled.occurredAt ||
    canceled.data.reasonCode !== "goal_mutated"
  ) {
    throw new RunStoreError("goal_queued_run_cancellation_invalid");
  }
  let next: RunState = current;
  for (const event of input.events) {
    next = reduceRunLifecycleEvent(next, event);
  }
  if (next.status !== "canceled") {
    throw new RunStoreError("goal_queued_run_cancellation_invalid");
  }
  validateOutbox(input.outbox, current.runId, current.tenantId, outboxIdExists);
  for (let index = 0; index < input.events.length; index += 1) {
    validateRunEventOutbox(input.outbox[index], input.events[index]);
  }
  return next;
}

export function reduceThreadGoalRetainedRunUpdate(
  input: ThreadGoalRetainedRunUpdate,
  currentRun: RunState,
  currentGoal: ThreadGoal | null,
  nextGoal: ThreadGoal | null,
  eventIdExists: (eventId: string) => boolean,
  outboxIdExists: (messageId: string) => boolean,
): RunState {
  if (
    currentRun.collaborationMode !== "default" ||
    input.events.length !== 1 ||
    input.outbox.length !== 1
  ) {
    throw new RunStoreError("goal_retained_run_update_invalid");
  }
  const event = input.events[0];
  if (event?.type !== "run.goal.accounting.updated") {
    throw new RunStoreError("goal_retained_run_update_invalid");
  }
  if (
    currentRun.goalAccounting === null &&
    currentRun.goalBinding !== null &&
    currentRun.status !== "queued"
  ) {
    throw new RunStoreError("goal_accounting_cursor_missing");
  }

  let accountedGoal = currentGoal;
  try {
    if (currentRun.goalAccounting?.attribution !== null) {
      const cursor = currentRun.goalAccounting;
      if (cursor !== null) {
        const delta = computeRunGoalAccountingDelta(
          cursor,
          currentRun.usage,
          currentRun.lastSequence,
          event.occurredAt,
        );
        accountedGoal = accountThreadGoalProgress(
          currentGoal,
          cursor,
          delta,
          event.occurredAt,
        );
      }
    }
  } catch (error) {
    throw mapRunGoalAccountingError(error);
  }
  if (
    nextGoal !== null &&
    (nextGoal.tokensUsed !== (accountedGoal?.tokensUsed ?? 0) ||
      nextGoal.timeUsedSeconds !== (accountedGoal?.timeUsedSeconds ?? 0))
  ) {
    throw new RunStoreError("goal_accounting_result_mismatch");
  }

  const nextBinding =
    nextGoal?.status === "active" || nextGoal?.status === "budgetLimited"
      ? {
          goalId: nextGoal.goalId,
          revision: nextGoal.revision,
          objectiveDigest:
            event.data.next.pendingSteering?.target.objectiveDigest ??
            currentRun.goalAccounting?.attribution?.objectiveDigest ??
            currentRun.goalBinding?.objectiveDigest ??
            "",
        }
      : null;
  const expectedSteeringKind = expectedGoalSteeringKind(
    currentRun,
    currentGoal,
    nextGoal,
  );
  if (
    (expectedSteeringKind === null) !==
      (event.data.next.pendingSteering === null) ||
    (expectedSteeringKind !== null &&
      event.data.next.pendingSteering?.kind !== expectedSteeringKind)
  ) {
    throw new RunStoreError("goal_steering_transition_invalid");
  }
  if (
    nextBinding !== null &&
    event.data.next.pendingSteering === null &&
    event.data.next.attribution !== null
  ) {
    nextBinding.objectiveDigest =
      currentRun.goalAccounting?.pendingSteering?.target.objectiveDigest ??
      currentRun.goalAccounting?.attribution?.objectiveDigest ??
      currentRun.goalBinding?.objectiveDigest ??
      "";
  }
  if (nextBinding !== null && nextBinding.objectiveDigest.length === 0) {
    throw new RunStoreError("goal_accounting_objective_digest_missing");
  }

  try {
    const expected = advanceRunGoalAccounting(currentRun.goalAccounting, {
      currentUsage: currentRun.usage,
      throughRunSequence: currentRun.lastSequence,
      occurredAt: event.occurredAt,
      nextBinding,
      pendingSteering: event.data.next.pendingSteering,
      trackTime: nextBinding !== null && currentRun.status !== "queued",
    }).next;
    if (stableJson(expected) !== stableJson(event.data.next)) {
      throw new RunStoreError("goal_accounting_transition_mismatch");
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw mapRunGoalAccountingError(error);
  }

  validateEvents(input.events, currentRun.runId, eventIdExists);
  const nextRun = reduceRunLifecycleEvent(currentRun, event);
  validateOutbox(
    input.outbox,
    currentRun.runId,
    currentRun.tenantId,
    outboxIdExists,
  );
  validateRunEventOutbox(input.outbox[0], event);
  return nextRun;
}

export function validateThreadGoalRetainedRunReceipt(
  retained: NonNullable<CommitThreadGoalMutationResult["retainedRun"]>,
  runState: RunState,
  goal: ThreadGoal | null,
  identity: Readonly<{ tenantId: string; threadId: string }>,
): void {
  if (
    retained.runEvents.length !== 1 ||
    retained.outbox.length !== 1 ||
    runState.tenantId !== identity.tenantId ||
    runState.threadId !== identity.threadId ||
    runState.collaborationMode !== "default" ||
    runState.status === "completed" ||
    runState.status === "failed" ||
    runState.status === "canceled"
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }
  const event = retained.runEvents[0];
  if (
    event?.type !== "run.goal.accounting.updated" ||
    event.identity.runId !== runState.runId ||
    event.sequence !== runState.lastSequence ||
    stableJson(event.data.next) !== stableJson(runState.goalAccounting)
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }
  const attribution = runState.goalAccounting?.attribution ?? null;
  const goalRetainsAttribution =
    goal?.status === "active" || goal?.status === "budgetLimited";
  if (
    goalRetainsAttribution !== (attribution !== null) ||
    (attribution !== null &&
      (goal === null ||
        attribution.goalId !== goal.goalId ||
        attribution.goalRevision !== goal.revision))
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }
  validateEvents(retained.runEvents, runState.runId, () => false);
  validateOutbox(
    retained.outbox,
    runState.runId,
    identity.tenantId,
    () => false,
  );
  validateRunEventOutbox(retained.outbox[0], event);
}

function expectedGoalSteeringKind(
  run: RunState,
  currentGoal: ThreadGoal | null,
  nextGoal: ThreadGoal | null,
): "objectiveUpdated" | "budgetLimited" | null {
  if (nextGoal === null) return null;
  if (nextGoal.status === "budgetLimited") return "budgetLimited";
  if (nextGoal.status !== "active") return null;
  if (
    currentGoal?.objective !== nextGoal.objective ||
    currentGoal?.status !== "active" ||
    run.goalAccounting?.attribution === null
  ) {
    return "objectiveUpdated";
  }
  return run.goalAccounting?.pendingSteering?.kind ?? null;
}

function mapRunGoalAccountingError(error: unknown): RunStoreError {
  return error instanceof RunGoalAccountingError
    ? new RunStoreError(error.code, { cause: error })
    : new RunStoreError("goal_accounting_transition_invalid", {
        cause: error,
      });
}

export function reduceThreadGoalContinuation(
  input: ThreadGoalContinuation,
  goal: ThreadGoal,
  thread: ThreadState,
  eventIdExists: (eventId: string) => boolean,
  outboxIdExists: (messageId: string) => boolean,
  workItemIdExists: (workItemId: string) => boolean,
): Readonly<{ runState: RunState; historyItem: ModelHistoryItem }> {
  if (
    goal.status !== "active" ||
    input.history.items.length !== 1 ||
    input.events.length !== 1 ||
    input.outbox.length !== 1 ||
    input.workItems.length !== 1
  ) {
    throw new RunStoreError("goal_activation_shape_invalid");
  }
  const historyItem = input.history.items[0]!;
  const event = input.events[0]!;
  const outbox = input.outbox[0]!;
  const workItem = input.workItems[0]!;
  if (event.type !== "run.created") {
    throw new RunStoreError("goal_activation_shape_invalid");
  }
  validateEvents(input.events, event.identity.runId, eventIdExists);
  const runState = reduceRunLifecycleEvent(null, event);
  const prompt = threadGoalContinuationPrompt(goal);
  if (
    runState.tenantId !== thread.tenantId ||
    runState.threadId !== thread.threadId ||
    runState.spaceId !== thread.spaceId ||
    runState.collaborationMode !== "default" ||
    !goalBindingMatchesGoal(runState.goalBinding, goal) ||
    historyItem.type !== "message" ||
    historyItem.role !== "user" ||
    historyItem.source !== "goal_continuation" ||
    historyItem.tenantId !== thread.tenantId ||
    historyItem.threadId !== thread.threadId ||
    historyItem.runId !== runState.runId ||
    historyItem.segmentId !== null ||
    historyItem.createdAt !== event.occurredAt ||
    historyItem.content !== prompt ||
    workItem.createdAt !== event.occurredAt
  ) {
    throw new RunStoreError("goal_activation_shape_invalid");
  }
  validateOutbox(input.outbox, runState.runId, thread.tenantId, outboxIdExists);
  validateRunEventOutbox(outbox, event);
  validateWorkItems(
    input.workItems,
    runState.runId,
    thread.tenantId,
    event.sequence,
    workItemIdExists,
    "goalActivation",
  );
  if (
    stableJson(workItem.payload) !==
    stableJson({
      throughSequence: 1,
      trigger: "goalActivation",
      goalId: goal.goalId,
      goalRevision: goal.revision,
    })
  ) {
    throw new RunStoreError("goal_activation_shape_invalid");
  }
  return { runState, historyItem };
}

function validateRunEventOutbox(
  outbox: OutboxMessage | undefined,
  event: RunLifecycleEvent | undefined,
): void {
  if (
    outbox === undefined ||
    event === undefined ||
    outbox.topic !== "run.updated" ||
    outbox.createdAt !== event.occurredAt ||
    stableJson(outbox.payload) !==
      stableJson({
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      })
  ) {
    throw new RunStoreError("run_outbox_mismatch");
  }
}

export function applyRunTerminalGoalMutation(
  current: ThreadGoal | null,
  mutation: TurnStartGoalMutation,
  run: import("@crewon/domain").RunState,
  event: Extract<
    RunLifecycleEvent,
    { type: "run.completed" | "run.failed" | "run.canceled" }
  >,
  events: readonly RunLifecycleEvent[] = [event],
): ThreadGoal | null {
  validateRunTerminalGoalAccounting(run, events, event);
  const next = applyTurnStartGoalMutation(current, mutation, {
    tenantId: run.tenantId,
    threadId: run.threadId,
  });
  let expected: ThreadGoal | null;
  try {
    const outcome =
      event.type === "run.failed"
        ? ({ kind: "failed", code: event.data.code } as const)
        : event.type === "run.canceled"
          ? ({ kind: "canceled" } as const)
          : ({ kind: "completed" } as const);
    expected =
      run.goalAccounting === null
        ? settleThreadGoalForRun(current, run, outcome, event.occurredAt)
        : settleThreadGoalFromAccounting(
            current,
            run,
            outcome,
            event.occurredAt,
          );
  } catch (error) {
    throw error instanceof ThreadGoalError
      ? new RunStoreError(error.code, { cause: error })
      : error;
  }
  if (stableJson(next) !== stableJson(expected)) {
    throw new RunStoreError("goal_settlement_mismatch");
  }
  return next;
}

function validateRunTerminalGoalAccounting(
  run: RunState,
  events: readonly RunLifecycleEvent[],
  terminal: Extract<
    RunLifecycleEvent,
    { type: "run.completed" | "run.failed" | "run.canceled" }
  >,
): void {
  const accountingEvents = events.filter(
    (item) => item.type === "run.goal.accounting.updated",
  );
  const requiresAccounting = run.goalAccounting?.attribution !== null;
  if (run.goalAccounting === null || !requiresAccounting) {
    if (accountingEvents.length !== 0) {
      throw new RunStoreError("run_terminal_goal_accounting_unexpected");
    }
    return;
  }
  const accounting = accountingEvents[0];
  if (
    accountingEvents.length !== 1 ||
    accounting?.type !== "run.goal.accounting.updated" ||
    events.at(-2) !== accounting ||
    accounting.occurredAt !== terminal.occurredAt ||
    accounting.sequence + 1 !== terminal.sequence
  ) {
    throw new RunStoreError("run_terminal_goal_accounting_missing");
  }
  try {
    const expected = advanceRunGoalAccounting(run.goalAccounting, {
      currentUsage: run.usage,
      throughRunSequence: accounting.sequence - 1,
      occurredAt: accounting.occurredAt,
      nextBinding: null,
      pendingSteering: null,
      trackTime: false,
    }).next;
    if (stableJson(expected) !== stableJson(accounting.data.next)) {
      throw new RunStoreError("run_terminal_goal_accounting_mismatch");
    }
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    throw mapRunGoalAccountingError(error);
  }
}

export function reduceGoalContinuationRun(
  input: RunGoalContinuationCommit | null,
  goal: ThreadGoal | null,
  previousRun: import("@crewon/domain").RunState,
  occurredAt: string,
  expectedHistorySequence: number,
): import("@crewon/domain").RunState | null {
  if (goal?.status !== "active") {
    if (input !== null) {
      throw new RunStoreError("goal_continuation_unexpected");
    }
    return null;
  }
  if (
    input === null ||
    input.events.length !== 1 ||
    input.outbox.length !== 1 ||
    input.workItems.length !== 1
  ) {
    throw new RunStoreError("goal_continuation_missing");
  }
  const event = input.events[0];
  const outbox = input.outbox[0];
  const workItem = input.workItems[0];
  if (
    event?.type !== "run.created" ||
    outbox === undefined ||
    workItem === undefined
  ) {
    throw new RunStoreError("goal_continuation_shape_invalid");
  }
  const prompt = threadGoalContinuationPrompt(goal);
  const historyItem = input.historyItem;
  const keys = Object.keys(workItem.payload).sort();
  if (
    historyItem.type !== "message" ||
    historyItem.role !== "user" ||
    historyItem.source !== "goal_continuation" ||
    historyItem.tenantId !== previousRun.tenantId ||
    historyItem.threadId !== previousRun.threadId ||
    historyItem.sequence !== expectedHistorySequence ||
    historyItem.runId !== event.identity.runId ||
    historyItem.segmentId !== null ||
    historyItem.createdAt !== occurredAt ||
    historyItem.content !== prompt ||
    event.occurredAt !== occurredAt ||
    event.identity.runId === previousRun.runId ||
    event.data.threadId !== previousRun.threadId ||
    event.data.tenantId !== previousRun.tenantId ||
    event.data.spaceId !== previousRun.spaceId ||
    event.data.createdByActorId !== previousRun.createdByActorId ||
    event.data.authorityId !== previousRun.authorityId ||
    event.data.runtimeGeneration !== previousRun.runtimeGeneration ||
    event.data.agentVersionId !== previousRun.agentVersionId ||
    event.data.policySnapshotId !== previousRun.policySnapshotId ||
    event.data.workspaceBindingId !== previousRun.workspaceBindingId ||
    event.data.collaborationMode !== "default" ||
    !goalBindingMatchesGoal(event.data.goalBinding, goal) ||
    outbox.tenantId !== previousRun.tenantId ||
    outbox.runId !== event.identity.runId ||
    outbox.topic !== "run.updated" ||
    outbox.createdAt !== occurredAt ||
    stableJson(outbox.payload) !==
      stableJson({
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      }) ||
    workItem.tenantId !== previousRun.tenantId ||
    workItem.runId !== event.identity.runId ||
    workItem.kind !== "run.execute" ||
    workItem.createdAt !== occurredAt ||
    stableJson(keys) !==
      stableJson([
        "goalId",
        "goalRevision",
        "previousRunId",
        "throughSequence",
        "trigger",
      ]) ||
    workItem.payload.throughSequence !== 1 ||
    workItem.payload.trigger !== "goalContinuation" ||
    workItem.payload.previousRunId !== previousRun.runId ||
    workItem.payload.goalId !== goal.goalId ||
    workItem.payload.goalRevision !== goal.revision
  ) {
    throw new RunStoreError("goal_continuation_shape_invalid");
  }
  try {
    return reduceRunLifecycleEvent(null, event);
  } catch (error) {
    throw new RunStoreError("goal_continuation_shape_invalid", {
      cause: error,
    });
  }
}

export function textCompletionHistoryAppend(
  input: CommitTextRunCompletionInput,
): ModelHistoryAppend {
  return {
    expectedLastSequence: input.history.expectedLastSequence,
    items:
      input.goalContinuation === null
        ? input.history.items
        : [...input.history.items, input.goalContinuation.historyItem],
  };
}

export function validateTurnStartGoalBinding(
  goal: ThreadGoal | null,
  input: CommitTurnStartInput,
): void {
  const created = input.run.events[0];
  if (created?.type !== "run.created") {
    throw new RunStoreError("turn_start_shape_invalid");
  }
  const matches =
    goal !== null && isGoalRunnable(goal.status)
      ? goalBindingMatchesGoal(created.data.goalBinding, goal)
      : created.data.goalBinding === null;
  if (!matches) {
    throw new RunStoreError("turn_start_goal_binding_mismatch");
  }
}

function goalBindingMatchesGoal(
  binding: import("@crewon/domain").RunGoalBinding | null,
  goal: ThreadGoal,
): boolean {
  return (
    binding !== null &&
    binding.goalId === goal.goalId &&
    binding.revision === goal.revision
  );
}

export function validateTurnStartReceiptQuery(
  query: TurnStartReceiptQuery,
): void {
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireBoundedString(query.threadId, 512, "thread_id_invalid");
  requireBoundedString(
    query.idempotency.scope,
    512,
    "idempotency_scope_invalid",
  );
  requireBoundedString(query.idempotency.key, 256, "idempotency_key_invalid");
  requireBoundedString(
    query.idempotency.requestFingerprint,
    64 * 1024,
    "idempotency_fingerprint_invalid",
  );
}

export function validateThreadContinuationLocator(
  locator: ThreadContinuationLocator,
): void {
  requireBoundedString(locator.tenantId, 256, "tenant_id_invalid");
  requireBoundedString(locator.threadId, 512, "thread_id_invalid");
  requireBoundedString(locator.agentVersionId, 512, "agent_version_id_invalid");
  requireBoundedString(locator.adapterName, 128, "adapter_name_invalid");
  requireBoundedString(locator.adapterVersion, 128, "adapter_version_invalid");
  requireBoundedString(locator.modelId, 256, "model_id_invalid");
}

export function validateThreadModelState(state: ThreadModelState): void {
  if (state.schemaVersion !== "crewon.thread-model-state.v0") {
    throw new RunStoreError("thread_model_state_invalid");
  }
  validateThreadContinuationLocator({
    tenantId: state.tenantId,
    threadId: state.threadId,
    agentVersionId: state.agentVersionId,
    adapterName: state.adapterName,
    adapterVersion: state.adapterVersion,
    modelId: state.modelId,
  });
  if (
    !Number.isSafeInteger(state.contextWindowTokens) ||
    state.contextWindowTokens < 1 ||
    (state.autoCompactAtTokens !== null &&
      (!Number.isSafeInteger(state.autoCompactAtTokens) ||
        state.autoCompactAtTokens < 1 ||
        state.autoCompactAtTokens >= state.contextWindowTokens)) ||
    !Number.isSafeInteger(state.throughHistorySequence) ||
    state.throughHistorySequence < 1
  ) {
    throw new RunStoreError("thread_model_state_invalid");
  }
  requireBoundedString(
    state.contextRevision,
    512,
    "thread_model_state_invalid",
  );
  if (state.latestUsage !== null) {
    const { inputTokens, outputTokens, totalTokens } = state.latestUsage;
    if (
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0 ||
      !Number.isSafeInteger(totalTokens) ||
      totalTokens !== inputTokens + outputTokens
    ) {
      throw new RunStoreError("thread_model_state_invalid");
    }
  }
  parseQueueTimestamp(state.updatedAt, "thread_model_state_invalid");
}

export function validateThreadEvents(
  events: readonly ThreadLifecycleEvent[],
  threadId: string,
  eventIdExists: (eventId: string) => boolean,
): void {
  const eventIds = new Set<string>();
  for (const event of events) {
    requireNonEmpty(event.eventId, "thread_event_id_invalid");
    if (event.identity.threadId !== threadId) {
      throw new RunStoreError("thread_id_mismatch");
    }
    if (eventIds.has(event.eventId) || eventIdExists(event.eventId)) {
      throw new RunStoreError("thread_event_id_conflict");
    }
    eventIds.add(event.eventId);
    if (encodedJsonSize(event) > MAX_THREAD_EVENT_BYTES) {
      throw new RunStoreError("thread_event_too_large");
    }
  }
}

export function validateMessages(
  messages: readonly MessageRecord[],
  events: readonly ThreadLifecycleEvent[],
  threadId: string,
  tenantId: string,
  messageIdExists: (messageId: string) => boolean,
): void {
  const appended = events.filter(
    (
      event,
    ): event is Extract<
      ThreadLifecycleEvent,
      { type: "thread.message.appended" }
    > => event.type === "thread.message.appended",
  );
  if (messages.length !== appended.length) {
    throw new RunStoreError("message_event_count_mismatch");
  }
  const messageIds = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.invalidation !== undefined) {
      throw new RunStoreError("message_invalidation_write_forbidden");
    }
    if (!Object.hasOwn(message, "origin")) {
      throw new RunStoreError("message_origin_missing");
    }
    requireNonEmpty(message.messageId, "message_id_invalid");
    requireNonEmpty(message.createdAt, "message_created_at_invalid");
    requireNonEmpty(message.content, "message_content_invalid");
    if (message.threadId !== threadId) {
      throw new RunStoreError("message_thread_id_mismatch");
    }
    if (message.tenantId !== tenantId) {
      throw new RunStoreError("message_tenant_id_mismatch");
    }
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
      throw new RunStoreError("message_sequence_invalid");
    }
    if (!MESSAGE_ROLES.includes(message.role)) {
      throw new RunStoreError("message_role_invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(message.contentDigest)) {
      throw new RunStoreError("message_content_digest_invalid");
    }
    if (message.origin !== null) {
      try {
        const origin = parseAutomationInvocationOrigin(message.origin);
        if (
          message.role !== "user" ||
          origin.binding.instructionDigest !== message.contentDigest
        ) {
          throw new RunStoreError("message_automation_origin_mismatch");
        }
        if (
          new TextEncoder().encode(message.content).byteLength >
          MAX_AUTOMATION_INSTRUCTION_BYTES
        ) {
          throw new RunStoreError("message_automation_content_too_large");
        }
      } catch (error) {
        if (error instanceof RunStoreError) throw error;
        throw new RunStoreError("message_origin_invalid", { cause: error });
      }
    }
    if (
      new TextEncoder().encode(message.content).byteLength > MAX_MESSAGE_BYTES
    ) {
      throw new RunStoreError("message_content_too_large");
    }
    validateMessageProposedPlan(message);
    if (
      messageIds.has(message.messageId) ||
      messageIdExists(message.messageId)
    ) {
      throw new RunStoreError("message_id_conflict");
    }
    messageIds.add(message.messageId);
    const event = appended[index];
    if (
      event === undefined ||
      event.data.messageId !== message.messageId ||
      event.data.messageSequence !== message.sequence ||
      event.data.role !== message.role ||
      event.data.contentDigest !== message.contentDigest ||
      event.occurredAt !== message.createdAt
    ) {
      throw new RunStoreError("message_event_mismatch");
    }
    if (encodedJsonSize(message) > MAX_THREAD_EVENT_BYTES) {
      throw new RunStoreError("message_too_large");
    }
  }
}

export function validateMessageProposedPlan(message: MessageRecord): void {
  const proposedPlan = message.proposedPlan;
  if (proposedPlan === undefined || proposedPlan === null) return;
  try {
    validateProposedPlan(proposedPlan);
  } catch (error) {
    throw new RunStoreError("proposed_plan_invalid", { cause: error });
  }
  if (
    message.role !== "assistant" ||
    proposedPlan.tenantId !== message.tenantId ||
    proposedPlan.threadId !== message.threadId ||
    proposedPlan.messageId !== message.messageId ||
    proposedPlan.content !== message.content ||
    proposedPlan.contentDigest !== message.contentDigest ||
    proposedPlan.createdAt !== message.createdAt
  ) {
    throw new RunStoreError("proposed_plan_message_mismatch");
  }
}

export function validateMessagePage(
  locator: ThreadLocator,
  afterSequence: number,
  limit: number,
): void {
  validateThreadLocator(locator);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RunStoreError("after_sequence_invalid");
  }
  validateLimit(limit);
}

export function validateMessageView(view: MessageView): void {
  if (view !== "standard" && view !== "audit") {
    throw new RunStoreError("message_view_invalid");
  }
}

export function validateModelHistoryPage(
  locator: ThreadLocator,
  afterSequence: number,
  limit: number,
): void {
  validateThreadLocator(locator);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RunStoreError("model_history_cursor_invalid");
  }
  validateLimit(limit);
}

export function validateModelHistoryAppend(
  append: ModelHistoryAppend,
  locator: ThreadLocator,
  existing: readonly ModelHistoryItem[],
  itemIdExists: (itemId: string) => boolean,
): void {
  const actualLastSequence = existing.at(-1)?.sequence ?? 0;
  validateModelHistoryAppendShape(
    append,
    locator,
    actualLastSequence,
    itemIdExists,
  );
  validateModelHistoryPairing([...existing, ...append.items]);
}

export function validateRunHistoryCorrelation(
  events: readonly RunLifecycleEvent[],
  history: ModelHistoryAppend | null,
): void {
  const steeringEvents = events.filter(
    (event) => event.type === "run.goal.steering.consumed",
  );
  const steeringItems =
    history?.items.filter(
      (item) => item.type === "message" && item.source === "goal_steering",
    ) ?? [];
  if (steeringEvents.length === 0 && steeringItems.length === 0) return;
  if (
    steeringEvents.length !== 1 ||
    steeringItems.length !== 1 ||
    history?.items.length !== 1
  ) {
    throw new RunStoreError("goal_steering_history_mismatch");
  }
  const event = steeringEvents[0]!;
  const item = steeringItems[0]!;
  if (
    item.type !== "message" ||
    item.source !== "goal_steering" ||
    item.runId !== event.identity.runId ||
    item.segmentId !== null ||
    item.role !== "user" ||
    item.createdAt !== event.occurredAt
  ) {
    throw new RunStoreError("goal_steering_history_mismatch");
  }
}

export function validateModelHistoryAppendShape(
  append: ModelHistoryAppend,
  locator: ThreadLocator,
  actualLastSequence: number,
  itemIdExists: (itemId: string) => boolean,
): void {
  validateThreadLocator(locator);
  if (
    !Number.isSafeInteger(append.expectedLastSequence) ||
    append.expectedLastSequence < 0
  ) {
    throw new RunStoreError("model_history_expected_sequence_invalid");
  }
  if (!Number.isSafeInteger(actualLastSequence) || actualLastSequence < 0) {
    throw new RunStoreError("stored_model_history_sequence_invalid");
  }
  if (append.expectedLastSequence !== actualLastSequence) {
    throw new RunStoreError("model_history_sequence_conflict");
  }

  const itemIds = new Set<string>();
  let nextSequence = actualLastSequence + 1;
  for (const item of append.items) {
    try {
      validateModelHistoryItem(item);
    } catch (error) {
      throw new RunStoreError(
        error instanceof ModelHistoryError
          ? error.code
          : "model_history_item_invalid",
        { cause: error },
      );
    }
    if (item.tenantId !== locator.tenantId) {
      throw new RunStoreError("model_history_tenant_id_mismatch");
    }
    if (item.threadId !== locator.threadId) {
      throw new RunStoreError("model_history_thread_id_mismatch");
    }
    if (item.sequence !== nextSequence) {
      throw new RunStoreError("model_history_sequence_gap");
    }
    if (itemIds.has(item.itemId) || itemIdExists(item.itemId)) {
      throw new RunStoreError("model_history_item_id_conflict");
    }
    if (encodedJsonSize(item) > MAX_MODEL_HISTORY_ITEM_BYTES) {
      throw new RunStoreError("model_history_item_too_large");
    }
    itemIds.add(item.itemId);
    nextSequence += 1;
  }
}

export function validateModelHistoryPairing(
  items: readonly ModelHistoryItem[],
): void {
  const pending = new Map<
    string,
    Extract<ModelHistoryItem, { type: "tool_call" }>
  >();
  const completed = new Set<string>();
  for (const item of items) {
    if (item.type === "tool_call") {
      const key = modelHistoryCallKey(item.runId, item.callId);
      if (pending.has(key) || completed.has(key)) {
        throw new RunStoreError("model_history_tool_call_duplicate");
      }
      pending.set(key, item);
      continue;
    }
    if (item.type === "tool_result") {
      const key = modelHistoryCallKey(item.runId, item.callId);
      const call = pending.get(key);
      if (
        call === undefined ||
        call.kind !== item.kind ||
        call.segmentId !== item.segmentId
      ) {
        throw new RunStoreError("model_history_tool_result_orphaned");
      }
      pending.delete(key);
      completed.add(key);
      continue;
    }
    if (pending.size > 0) {
      throw new RunStoreError("model_history_tool_result_missing");
    }
  }
}

function modelHistoryCallKey(runId: string | null, callId: string): string {
  return `${runId ?? ""}\u0000${callId}`;
}

export function validateThreadLocator(locator: ThreadLocator): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.threadId, "thread_id_invalid");
}

export function validateThreadSpaceLocator(locator: ThreadSpaceLocator): void {
  validateThreadLocator(locator);
  requireNonEmpty(locator.spaceId, "space_id_invalid");
}

export function validateThreadListQuery(query: ThreadListQuery): void {
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireNonEmpty(query.spaceId, "space_id_invalid");
  validateLimit(query.limit);
  if (query.before !== null) {
    parseQueueTimestamp(query.before.updatedAt, "thread_cursor_invalid");
    requireNonEmpty(query.before.threadId, "thread_cursor_invalid");
  }
}

export function validateThreadRunListQuery(query: ThreadRunListQuery): void {
  requireNonEmpty(query.tenantId, "tenant_id_invalid");
  requireNonEmpty(query.spaceId, "space_id_invalid");
  requireNonEmpty(query.threadId, "thread_id_invalid");
  validateLimit(query.limit);
  if (query.before !== null) {
    parseQueueTimestamp(query.before.updatedAt, "run_cursor_invalid");
    requireNonEmpty(query.before.runId, "run_cursor_invalid");
  }
}

export function validateEvents(
  events: readonly RunLifecycleEvent[],
  runId: string,
  eventIdExists: (eventId: string) => boolean,
): void {
  const eventIds = new Set<string>();
  for (const event of events) {
    requireNonEmpty(event.eventId, "event_id_invalid");
    if (event.identity.runId !== runId) {
      throw new RunStoreError("run_id_mismatch");
    }
    if (eventIds.has(event.eventId) || eventIdExists(event.eventId)) {
      throw new RunStoreError("event_id_conflict");
    }
    eventIds.add(event.eventId);
    if (encodedJsonSize(event) > MAX_EVENT_BYTES) {
      throw new RunStoreError("event_too_large");
    }
  }
}

export function validateOutbox(
  messages: readonly OutboxMessage[],
  runId: string,
  tenantId: string,
  messageIdExists: (messageId: string) => boolean,
): void {
  const messageIds = new Set<string>();
  for (const message of messages) {
    requireNonEmpty(message.messageId, "outbox_message_id_invalid");
    requireNonEmpty(message.topic, "outbox_topic_invalid");
    requireNonEmpty(message.createdAt, "outbox_created_at_invalid");
    if (message.runId !== runId) {
      throw new RunStoreError("outbox_run_id_mismatch");
    }
    if (message.tenantId !== tenantId) {
      throw new RunStoreError("outbox_tenant_id_mismatch");
    }
    if (
      messageIds.has(message.messageId) ||
      messageIdExists(message.messageId)
    ) {
      throw new RunStoreError("outbox_message_conflict");
    }
    messageIds.add(message.messageId);
    if (encodedJsonSize(message) > MAX_OUTBOX_MESSAGE_BYTES) {
      throw new RunStoreError("outbox_message_too_large");
    }
  }
}

export function validateWorkItems(
  workItems: readonly WorkItem[],
  runId: string,
  tenantId: string,
  throughSequence: number,
  workItemIdExists: (workItemId: string) => boolean,
  payloadKind:
    | "default"
    | "goalContinuation"
    | "goalActivation"
    | "automationInvocation"
    | "manualCompaction" = "default",
): void {
  const workItemIds = new Set<string>();
  for (const workItem of workItems) {
    requireNonEmpty(workItem.workItemId, "work_item_id_invalid");
    requireNonEmpty(workItem.createdAt, "work_item_created_at_invalid");
    if (workItem.kind !== "run.execute") {
      throw new RunStoreError("work_item_kind_invalid");
    }
    const payloadKeys = Object.keys(workItem.payload).sort();
    const payloadValid =
      payloadKind === "default"
        ? stableJson(payloadKeys) === stableJson(["throughSequence"])
        : payloadKind === "goalContinuation"
          ? stableJson(payloadKeys) ===
            stableJson([
              "goalId",
              "goalRevision",
              "previousRunId",
              "throughSequence",
              "trigger",
            ])
          : payloadKind === "goalActivation"
            ? stableJson(payloadKeys) ===
              stableJson([
                "goalId",
                "goalRevision",
                "throughSequence",
                "trigger",
              ])
            : payloadKind === "automationInvocation"
              ? stableJson(payloadKeys) ===
                stableJson([
                  "binding",
                  "schemaVersion",
                  "throughSequence",
                  "trigger",
                ])
              : stableJson(payloadKeys) ===
                stableJson([
                  "expectedHistorySequence",
                  "schemaVersion",
                  "throughSequence",
                  "trigger",
                ]);
    if (!payloadValid || workItem.payload.throughSequence !== throughSequence) {
      throw new RunStoreError("work_item_payload_invalid");
    }
    if (
      payloadKind === "goalContinuation" &&
      (workItem.payload.trigger !== "goalContinuation" ||
        typeof workItem.payload.previousRunId !== "string" ||
        workItem.payload.previousRunId.trim().length === 0 ||
        typeof workItem.payload.goalId !== "string" ||
        workItem.payload.goalId.trim().length === 0 ||
        !Number.isSafeInteger(workItem.payload.goalRevision) ||
        Number(workItem.payload.goalRevision) < 1)
    ) {
      throw new RunStoreError("work_item_payload_invalid");
    }
    if (
      payloadKind === "goalActivation" &&
      (workItem.payload.trigger !== "goalActivation" ||
        typeof workItem.payload.goalId !== "string" ||
        workItem.payload.goalId.trim().length === 0 ||
        !Number.isSafeInteger(workItem.payload.goalRevision) ||
        Number(workItem.payload.goalRevision) < 1)
    ) {
      throw new RunStoreError("work_item_payload_invalid");
    }
    if (
      payloadKind === "automationInvocation" &&
      (workItem.payload.trigger !== "automationInvocation" ||
        workItem.payload.schemaVersion !==
          "crewon.automation-invocation-work-item.v0")
    ) {
      throw new RunStoreError("work_item_payload_invalid");
    }
    if (payloadKind === "automationInvocation") {
      try {
        const binding = parseAutomationInvocationBinding(
          workItem.payload.binding,
        );
        if (binding.runId !== workItem.runId) {
          throw new RunStoreError("work_item_payload_invalid");
        }
      } catch (error) {
        if (error instanceof RunStoreError) throw error;
        throw new RunStoreError("work_item_payload_invalid", { cause: error });
      }
    }
    if (
      payloadKind === "manualCompaction" &&
      (workItem.payload.trigger !== "manualCompaction" ||
        workItem.payload.schemaVersion !==
          "crewon.manual-compaction-work-item.v0" ||
        !Number.isSafeInteger(workItem.payload.expectedHistorySequence) ||
        Number(workItem.payload.expectedHistorySequence) < 1)
    ) {
      throw new RunStoreError("work_item_payload_invalid");
    }
    if (workItem.runId !== runId) {
      throw new RunStoreError("work_item_run_id_mismatch");
    }
    if (workItem.tenantId !== tenantId) {
      throw new RunStoreError("work_item_tenant_id_mismatch");
    }
    if (
      workItemIds.has(workItem.workItemId) ||
      workItemIdExists(workItem.workItemId)
    ) {
      throw new RunStoreError("work_item_conflict");
    }
    workItemIds.add(workItem.workItemId);
    if (encodedJsonSize(workItem) > MAX_WORK_ITEM_BYTES) {
      throw new RunStoreError("work_item_too_large");
    }
  }
}

export function validateQueueClaim(input: QueueClaimInput): void {
  requireBoundedString(input.ownerId, 256, "lease_owner_id_invalid");
  requireBoundedString(input.leaseId, 256, "lease_id_invalid");
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1 ||
    input.leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new RunStoreError("lease_duration_invalid");
  }
}

export function validateQueueLease(
  input: {
    ownerId: string;
    leaseId: string;
    leaseEpoch: number;
  },
  itemId: string,
  itemIdCode: string,
): void {
  requireNonEmpty(itemId, itemIdCode);
  requireBoundedString(input.ownerId, 256, "lease_owner_id_invalid");
  requireBoundedString(input.leaseId, 256, "lease_id_invalid");
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) {
    throw new RunStoreError("lease_epoch_invalid");
  }
}

export function validateQueueRetry(
  input: OutboxRetryInput | WorkItemRetryInput,
): void {
  if (
    !Number.isSafeInteger(input.retryAfterMs) ||
    input.retryAfterMs < 0 ||
    input.retryAfterMs > MAX_RETRY_AFTER_MS
  ) {
    throw new RunStoreError("queue_retry_delay_invalid");
  }
  requireBoundedString(input.reasonCode, 256, "queue_retry_reason_invalid");
}

export function validateClaimedLease(
  lease: {
    ownerId: string;
    leaseId: string;
    epoch: number;
  },
  expected: {
    ownerId: string;
    leaseId: string;
    leaseEpoch: number;
  },
  expiresAtMs: number,
  now: number,
  status: string,
  settledStatus: string,
): void {
  if (status === settledStatus) {
    throw new RunStoreError("queue_item_already_settled");
  }
  if (
    status !== "leased" ||
    lease.ownerId !== expected.ownerId ||
    lease.leaseId !== expected.leaseId ||
    lease.epoch !== expected.leaseEpoch
  ) {
    throw new RunStoreError("stale_lease");
  }
  if (expiresAtMs <= now) {
    throw new RunStoreError("lease_expired");
  }
}

export function parseQueueTimestamp(value: string, code: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !value.endsWith("Z")) {
    throw new RunStoreError(code);
  }
  return timestamp;
}

export function validateEventPage(
  locator: RunLocator,
  afterSequence: number,
  limit: number,
): void {
  validateRunLocator(locator);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new RunStoreError("after_sequence_invalid");
  }
  validateLimit(limit);
}

export function validateRunLocator(locator: RunLocator): void {
  requireNonEmpty(locator.tenantId, "tenant_id_invalid");
  requireNonEmpty(locator.runId, "run_id_invalid");
}

export function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RunStoreError("page_limit_invalid");
  }
}

export function requireNonEmpty(value: string, code: string): void {
  if (value.trim().length === 0) {
    throw new RunStoreError(code);
  }
}

function requireBoundedString(
  value: string,
  maxBytes: number,
  code: string,
): void {
  requireNonEmpty(value, code);
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RunStoreError(code);
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stabilize(value, new WeakSet<object>(), 0));
}

function encodedJsonSize(value: unknown): number {
  return new TextEncoder().encode(stableJson(value)).byteLength;
}

function stabilize(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > 32) {
    throw new RunStoreError("non_json_value");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RunStoreError("non_json_value");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new RunStoreError("non_json_value");
    }
    ancestors.add(value);
    const result = value.map((item) => stabilize(item, ancestors, depth + 1));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value) || ancestors.has(value)) {
    throw new RunStoreError("non_json_value");
  }
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) {
      throw new RunStoreError("non_json_value");
    }
    result[key] = stabilize(item, ancestors, depth + 1);
  }
  ancestors.delete(value);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}
