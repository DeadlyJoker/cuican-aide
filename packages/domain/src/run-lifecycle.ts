import {
  parseAutomationInvocationOrigin,
  type AutomationInvocationOrigin,
} from "./automation.ts";
import {
  runRateLimitSnapshotError,
  type RunRateLimitSnapshot,
} from "./rate-limit-snapshot.ts";
import {
  validateRunGoalBinding,
  type RunCollaborationMode,
  type RunGoalBinding,
} from "./thread-goal.ts";
import {
  RunGoalAccountingError,
  consumeRunGoalSteering,
  createRunGoalAccountingCursor,
  reduceRunGoalAccountingUpdate,
  startRunGoalAccounting,
  type RunGoalAccountingCursor,
} from "./run-goal-accounting.ts";

export const RUN_STATUSES = [
  "queued",
  "running",
  "waitingApproval",
  "suspended",
  "reconciling",
  "completed",
  "failed",
  "canceled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunPurpose = "turn" | "manualCompaction";

export type RunUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

type RunEventBase = Readonly<{
  schemaVersion: "crewon.run-event.v0";
  identity: Readonly<{ runId: string }>;
  eventId: string;
  sequence: number;
  occurredAt: string;
}>;

export type RunLifecycleEvent =
  | (RunEventBase & {
      type: "run.created";
      data: Readonly<{
        threadId: string;
        tenantId: string;
        spaceId: string;
        createdByActorId: string;
        authorityId: string;
        runtimeGeneration: string;
        agentVersionId: string;
        policySnapshotId: string;
        workspaceBindingId: string | null;
        collaborationMode: RunCollaborationMode;
        goalBinding: RunGoalBinding | null;
        /** Absent on legacy events and normalized to a normal user Turn. */
        purpose?: RunPurpose;
        /** Absent only on legacy events; the reducer normalizes absence to null. */
        origin?: AutomationInvocationOrigin | null;
      }>;
    })
  | (RunEventBase & {
      type: "run.started";
      data: Readonly<Record<string, never>>;
    })
  | (RunEventBase & {
      type: "run.approval.required";
      data: Readonly<{ approvalId: string; actionDigest: string }>;
    })
  | (RunEventBase & {
      type: "run.resumed";
      data: Readonly<{ reasonCode: string }>;
    })
  | (RunEventBase & {
      type: "run.suspended";
      data: Readonly<{ reasonCode: string }>;
    })
  | (RunEventBase & {
      type: "run.reconciliation.required";
      data: Readonly<{ receiptId: string }>;
    })
  | (RunEventBase & {
      type: "run.cancel.requested";
      data: Readonly<{ actorId: string }>;
    })
  | (RunEventBase & {
      type: "run.completed";
      data: Readonly<{ outputRef: string | null }>;
    })
  | (RunEventBase & {
      type: "run.failed";
      data: Readonly<{ code: string; retryable: boolean }>;
    })
  | (RunEventBase & {
      type: "run.canceled";
      data: Readonly<{ reasonCode: string }>;
    })
  | (RunEventBase & {
      type: "run.goal.accounting.updated";
      data: Readonly<{ next: RunGoalAccountingCursor }>;
    })
  | (RunEventBase & {
      type: "run.goal.steering.consumed";
      data: Readonly<{ handoffId: string }>;
    })
  | (RunEventBase & {
      type: "segment.started";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        attempt: number;
      }>;
    })
  | (RunEventBase & {
      type: "model.sampling.retry";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        samplingAttempt: number;
        maxRetries: number;
        code: string;
        discardedOutput: boolean;
      }>;
    })
  | (RunEventBase & {
      type: "model.transport.fallback";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        fromTransport: string;
        toTransport: string;
        code: string;
        discardedOutput: boolean;
      }>;
    })
  | (RunEventBase & {
      type: "model.output.delta";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        delta: string;
      }>;
    })
  | (RunEventBase & {
      type: "model.reasoning.summary";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        kind: "delta" | "partAdded";
        summaryIndex: number;
        delta?: string;
      }>;
    })
  | (RunEventBase & {
      type: "tool.requested";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        callId: string;
        kind: "function" | "custom";
        name: string;
        input: string;
      }>;
    })
  | (RunEventBase & {
      type: "tool.completed";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        callId: string;
        kind: "function" | "custom";
        name: string;
        output: string;
        isError: boolean;
        artifactRef: string | null;
        outputTruncated: boolean;
      }>;
    })
  | (RunEventBase & {
      type: "context.compacted";
      data: Readonly<{
        stepId: string;
        compactionItemId: string;
        mode: "auto" | "manual";
        replacesThroughSequence: number;
        inputTokens: number;
        /** Absent on legacy events and normalized to zero. */
        cachedInputTokens?: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    })
  | (RunEventBase & {
      type: "rate_limit.updated";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        snapshot: RunRateLimitSnapshot;
      }>;
    })
  | (RunEventBase & {
      type: "usage.recorded";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        inputTokens: number;
        /** Absent on legacy events and normalized to zero. */
        cachedInputTokens?: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    })
  | (RunEventBase & {
      type: "segment.checkpointed";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        checkpointDigest: string;
      }>;
    })
  | (RunEventBase & {
      type: "segment.completed";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
      }>;
    })
  | (RunEventBase & {
      type: "segment.provider_continuation";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        sampleIndex: number;
        throughHistorySequence: number;
      }>;
    })
  | (RunEventBase & {
      type: "segment.failed";
      data: Readonly<{
        segmentId: string;
        segmentSequence: number;
        code: string;
        retryable: boolean;
      }>;
    })
  | (RunEventBase & {
      type: "plan.proposed";
      data: Readonly<{
        planId: string;
        messageId: string;
        messageSequence: number;
        contentDigest: string;
      }>;
    })
  | (RunEventBase & {
      type: "message.completed";
      data: Readonly<{
        messageId: string;
        messageSequence: number;
        role: "assistant";
        contentDigest: string;
      }>;
    });

export type RunState = Readonly<{
  runId: string;
  threadId: string;
  tenantId: string;
  spaceId: string;
  createdByActorId: string;
  authorityId: string;
  runtimeGeneration: string;
  agentVersionId: string;
  policySnapshotId: string;
  workspaceBindingId: string | null;
  collaborationMode: RunCollaborationMode;
  /** Absent only on legacy snapshots created before Run purpose was durable. */
  purpose?: RunPurpose;
  /** Absent only on legacy snapshots; all newly reduced state uses null or a validated origin. */
  origin?: AutomationInvocationOrigin | null;
  goalBinding: RunGoalBinding | null;
  goalAccounting: RunGoalAccountingCursor | null;
  usage: RunUsage;
  status: RunStatus;
  revision: number;
  lastSequence: number;
  cancelRequested: boolean;
  waitingApproval: Readonly<{
    approvalId: string;
    actionDigest: string;
  }> | null;
  suspensionReasonCode: string | null;
  reconciliationReceiptId: string | null;
  outputRef: string | null;
  failure: Readonly<{ code: string; retryable: boolean }> | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}>;

export class RunLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RunLifecycleError";
    this.code = code;
  }
}

export function reduceRunLifecycleEvent(
  state: RunState | null,
  event: RunLifecycleEvent,
): RunState {
  validateEventEnvelope(event);
  if (state === null) {
    return createRun(event);
  }

  if (event.identity.runId !== state.runId) {
    throw new RunLifecycleError("run_id_mismatch");
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw new RunLifecycleError("sequence_gap");
  }
  if (isTerminal(state.status)) {
    throw new RunLifecycleError("terminal_state");
  }
  validateCancelProgress(state, event.type);

  const next = {
    ...state,
    revision: state.revision + 1,
    lastSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "run.created":
      throw new RunLifecycleError("run_already_created");
    case "run.started":
      requireStatus(state, event.type, ["queued"]);
      return {
        ...next,
        status: "running",
        goalAccounting: mapGoalAccountingError(() =>
          startRunGoalAccounting(
            state.goalAccounting,
            event.sequence,
            event.occurredAt,
          ),
        ),
      };
    case "run.approval.required":
      requireStatus(state, event.type, ["running"]);
      requireNonEmpty(event.data.approvalId, "approval_id_invalid");
      requireNonEmpty(event.data.actionDigest, "action_digest_invalid");
      return {
        ...next,
        status: "waitingApproval",
        waitingApproval: event.data,
      };
    case "run.resumed":
      requireStatus(state, event.type, [
        "waitingApproval",
        "suspended",
        "reconciling",
      ]);
      requireNonEmpty(event.data.reasonCode, "resume_reason_invalid");
      return {
        ...next,
        status: "running",
        waitingApproval: null,
        suspensionReasonCode: null,
        reconciliationReceiptId: null,
      };
    case "run.suspended":
      requireStatus(state, event.type, ["running"]);
      requireNonEmpty(event.data.reasonCode, "suspension_reason_invalid");
      return {
        ...next,
        status: "suspended",
        suspensionReasonCode: event.data.reasonCode,
      };
    case "run.reconciliation.required":
      requireStatus(state, event.type, ["running"]);
      requireNonEmpty(event.data.receiptId, "receipt_id_invalid");
      return {
        ...next,
        status: "reconciling",
        reconciliationReceiptId: event.data.receiptId,
      };
    case "run.cancel.requested":
      requireNonEmpty(event.data.actorId, "cancel_actor_invalid");
      return { ...next, cancelRequested: true };
    case "run.completed":
      requireStatus(state, event.type, ["running"]);
      requireNullableNonEmpty(event.data.outputRef, "output_ref_invalid");
      return {
        ...next,
        status: "completed",
        outputRef: event.data.outputRef,
        terminalAt: event.occurredAt,
      };
    case "run.failed":
      requireStatus(state, event.type, [
        "queued",
        "running",
        "waitingApproval",
        "suspended",
        "reconciling",
      ]);
      requireNonEmpty(event.data.code, "failure_code_invalid");
      return {
        ...next,
        status: "failed",
        failure: event.data,
        terminalAt: event.occurredAt,
      };
    case "run.canceled":
      requireNonEmpty(event.data.reasonCode, "cancel_reason_invalid");
      if (!state.cancelRequested) {
        throw new RunLifecycleError("cancel_not_requested");
      }
      if (state.status === "reconciling") {
        throw new RunLifecycleError("reconciliation_pending");
      }
      return { ...next, status: "canceled", terminalAt: event.occurredAt };
    case "run.goal.accounting.updated":
      return {
        ...next,
        goalAccounting: mapGoalAccountingError(() =>
          reduceRunGoalAccountingUpdate(
            state.goalAccounting,
            event.data.next,
            state.usage,
            state.lastSequence,
            event.occurredAt,
          ),
        ),
      };
    case "run.goal.steering.consumed":
      if (state.goalAccounting === null) {
        throw new RunLifecycleError("goal_accounting_cursor_missing");
      }
      return {
        ...next,
        goalAccounting: mapGoalAccountingError(() =>
          consumeRunGoalSteering(
            state.goalAccounting!,
            event.data.handoffId,
            event.occurredAt,
          ),
        ),
      };
    case "segment.started":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requirePositiveInteger(event.data.attempt, "segment_attempt_invalid");
      return next;
    case "model.output.delta":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireBoundedNonEmpty(
        event.data.delta,
        16 * 1024,
        "model_output_delta_invalid",
      );
      return next;
    case "model.reasoning.summary":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireNonNegativeInteger(
        event.data.summaryIndex,
        "model_reasoning_index_invalid",
      );
      if (event.data.kind === "delta") {
        if (event.data.delta === undefined) {
          throw new RunLifecycleError("model_reasoning_delta_invalid");
        }
        requireBoundedNonEmpty(
          event.data.delta,
          16 * 1024,
          "model_reasoning_delta_invalid",
        );
      } else if (event.data.kind !== "partAdded") {
        throw new RunLifecycleError("model_reasoning_kind_invalid");
      }
      return next;
    case "model.sampling.retry":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requirePositiveInteger(
        event.data.samplingAttempt,
        "sampling_attempt_invalid",
      );
      requirePositiveInteger(event.data.maxRetries, "sampling_retries_invalid");
      if (event.data.samplingAttempt > event.data.maxRetries) {
        throw new RunLifecycleError("sampling_attempt_invalid");
      }
      requireNonEmpty(event.data.code, "sampling_retry_code_invalid");
      if (typeof event.data.discardedOutput !== "boolean") {
        throw new RunLifecycleError("sampling_retry_discard_invalid");
      }
      return next;
    case "model.transport.fallback":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireNonEmpty(event.data.fromTransport, "model_transport_from_invalid");
      requireNonEmpty(event.data.toTransport, "model_transport_to_invalid");
      requireNonEmpty(event.data.code, "model_transport_fallback_code_invalid");
      if (typeof event.data.discardedOutput !== "boolean") {
        throw new RunLifecycleError("model_transport_fallback_discard_invalid");
      }
      return next;
    case "usage.recorded":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireNonNegativeInteger(
        event.data.inputTokens,
        "usage_input_tokens_invalid",
      );
      requireNonNegativeInteger(
        event.data.cachedInputTokens ?? 0,
        "usage_cached_input_tokens_invalid",
      );
      requireNonNegativeInteger(
        event.data.outputTokens,
        "usage_output_tokens_invalid",
      );
      requireNonNegativeInteger(
        event.data.totalTokens,
        "usage_total_tokens_invalid",
      );
      if ((event.data.cachedInputTokens ?? 0) > event.data.inputTokens) {
        throw new RunLifecycleError("usage_cached_input_tokens_exceeds_input");
      }
      if (
        event.data.totalTokens !==
        event.data.inputTokens + event.data.outputTokens
      ) {
        throw new RunLifecycleError("usage_total_tokens_mismatch");
      }
      return {
        ...next,
        usage: addRunUsage(state.usage, normalizedEventUsage(event.data)),
      };
    case "rate_limit.updated":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      {
        const code = runRateLimitSnapshotError(event.data.snapshot);
        if (code !== null) {
          throw new RunLifecycleError(code);
        }
      }
      return next;
    case "tool.requested":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      validateToolIdentity(event.data);
      requireBoundedString(event.data.input, 32 * 1024, "tool_input_invalid");
      return next;
    case "tool.completed":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      validateToolIdentity(event.data);
      requireBoundedString(event.data.output, 40_000, "tool_output_invalid");
      requireNullableNonEmpty(
        event.data.artifactRef,
        "tool_artifact_ref_invalid",
      );
      if (
        typeof event.data.isError !== "boolean" ||
        typeof event.data.outputTruncated !== "boolean"
      ) {
        throw new RunLifecycleError("tool_result_invalid");
      }
      return next;
    case "context.compacted":
      requireStatus(state, event.type, ["running"]);
      requireNonEmpty(event.data.stepId, "compaction_step_id_invalid");
      requireNonEmpty(
        event.data.compactionItemId,
        "compaction_item_id_invalid",
      );
      if (
        (event.data.mode !== "auto" && event.data.mode !== "manual") ||
        !Number.isSafeInteger(event.data.replacesThroughSequence) ||
        event.data.replacesThroughSequence < 1 ||
        !Number.isSafeInteger(event.data.inputTokens) ||
        event.data.inputTokens < 0 ||
        !Number.isSafeInteger(event.data.cachedInputTokens ?? 0) ||
        (event.data.cachedInputTokens ?? 0) < 0 ||
        (event.data.cachedInputTokens ?? 0) > event.data.inputTokens ||
        !Number.isSafeInteger(event.data.outputTokens) ||
        event.data.outputTokens < 0 ||
        !Number.isSafeInteger(event.data.totalTokens) ||
        event.data.totalTokens !==
          event.data.inputTokens + event.data.outputTokens
      ) {
        throw new RunLifecycleError("context_compaction_invalid");
      }
      return {
        ...next,
        usage: addRunUsage(state.usage, normalizedEventUsage(event.data)),
      };
    case "segment.checkpointed":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireDigest(event.data.checkpointDigest);
      return next;
    case "segment.completed":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      return next;
    case "segment.provider_continuation":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requirePositiveInteger(
        event.data.sampleIndex,
        "provider_sample_index_invalid",
      );
      requirePositiveInteger(
        event.data.throughHistorySequence,
        "provider_history_sequence_invalid",
      );
      return next;
    case "segment.failed":
      requireStatus(state, event.type, ["running"]);
      validateSegmentIdentity(event.data);
      requireNonEmpty(event.data.code, "segment_failure_code_invalid");
      return next;
    case "message.completed":
      requireStatus(state, event.type, ["running"]);
      requireNonEmpty(event.data.messageId, "message_id_invalid");
      requirePositiveInteger(
        event.data.messageSequence,
        "message_sequence_invalid",
      );
      if (event.data.role !== "assistant") {
        throw new RunLifecycleError("message_role_invalid");
      }
      requireDigest(event.data.contentDigest);
      return next;
    case "plan.proposed":
      requireStatus(state, event.type, ["running"]);
      if (state.collaborationMode !== "plan") {
        throw new RunLifecycleError("proposed_plan_mode_invalid");
      }
      requireNonEmpty(event.data.planId, "proposed_plan_id_invalid");
      requireNonEmpty(event.data.messageId, "proposed_plan_message_invalid");
      requirePositiveInteger(
        event.data.messageSequence,
        "proposed_plan_message_sequence_invalid",
      );
      requireDigest(event.data.contentDigest);
      return next;
  }
}

export function replayRunLifecycle(
  events: readonly RunLifecycleEvent[],
): RunState {
  let state: RunState | null = null;
  for (const event of events) {
    state = reduceRunLifecycleEvent(state, event);
  }
  if (state === null) {
    throw new RunLifecycleError("run_events_empty");
  }
  return state;
}

function createRun(event: RunLifecycleEvent): RunState {
  if (event.type !== "run.created") {
    throw new RunLifecycleError("run_not_created");
  }
  if (event.sequence !== 1) {
    throw new RunLifecycleError("sequence_gap");
  }
  validateRunCreatedDataShape(event.data);
  requireNonEmpty(event.identity.runId, "run_id_invalid");
  requireNonEmpty(event.data.threadId, "thread_id_invalid");
  requireNonEmpty(event.data.tenantId, "tenant_id_invalid");
  requireNonEmpty(event.data.spaceId, "space_id_invalid");
  requireNonEmpty(event.data.createdByActorId, "created_by_actor_id_invalid");
  requireNonEmpty(event.data.authorityId, "authority_id_invalid");
  requireNonEmpty(event.data.runtimeGeneration, "runtime_generation_invalid");
  requireNonEmpty(event.data.agentVersionId, "agent_version_id_invalid");
  requireNonEmpty(event.data.policySnapshotId, "policy_snapshot_id_invalid");
  requireNullableNonEmpty(
    event.data.workspaceBindingId,
    "workspace_binding_id_invalid",
  );
  if (
    event.data.collaborationMode !== "default" &&
    event.data.collaborationMode !== "plan"
  ) {
    throw new RunLifecycleError("collaboration_mode_invalid");
  }
  if (event.data.goalBinding !== null) {
    try {
      validateRunGoalBinding(event.data.goalBinding);
    } catch (error) {
      throw new RunLifecycleError(
        error instanceof Error ? error.message : "goal_binding_invalid",
      );
    }
  }
  if (
    event.data.collaborationMode === "plan" &&
    event.data.goalBinding !== null
  ) {
    throw new RunLifecycleError("plan_goal_binding_invalid");
  }
  if (
    event.data.purpose !== undefined &&
    event.data.purpose !== "turn" &&
    event.data.purpose !== "manualCompaction"
  ) {
    throw new RunLifecycleError("run_purpose_invalid");
  }
  const origin = parseRunOrigin(event.data.origin);
  if (origin !== null) {
    if (event.data.purpose !== "turn") {
      throw new RunLifecycleError("automation_invocation_purpose_invalid");
    }
    if (origin.binding.runId !== event.identity.runId) {
      throw new RunLifecycleError("automation_invocation_run_id_mismatch");
    }
  }
  if (
    event.data.purpose === "manualCompaction" &&
    (event.data.collaborationMode !== "default" ||
      event.data.goalBinding !== null)
  ) {
    throw new RunLifecycleError("maintenance_run_shape_invalid");
  }

  return {
    runId: event.identity.runId,
    threadId: event.data.threadId,
    tenantId: event.data.tenantId,
    spaceId: event.data.spaceId,
    createdByActorId: event.data.createdByActorId,
    authorityId: event.data.authorityId,
    runtimeGeneration: event.data.runtimeGeneration,
    agentVersionId: event.data.agentVersionId,
    policySnapshotId: event.data.policySnapshotId,
    workspaceBindingId: event.data.workspaceBindingId,
    collaborationMode: event.data.collaborationMode,
    ...(event.data.purpose === undefined
      ? {}
      : { purpose: event.data.purpose }),
    origin,
    goalBinding: event.data.goalBinding,
    goalAccounting:
      event.data.goalBinding === null
        ? null
        : createRunGoalAccountingCursor(
            event.data.goalBinding,
            event.occurredAt,
          ),
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    status: "queued",
    revision: 1,
    lastSequence: 1,
    cancelRequested: false,
    waitingApproval: null,
    suspensionReasonCode: null,
    reconciliationReceiptId: null,
    outputRef: null,
    failure: null,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    terminalAt: null,
  };
}

function validateRunCreatedDataShape(
  data: Extract<RunLifecycleEvent, { type: "run.created" }>["data"],
): void {
  const required = [
    "agentVersionId",
    "authorityId",
    "collaborationMode",
    "createdByActorId",
    "goalBinding",
    "policySnapshotId",
    "runtimeGeneration",
    "spaceId",
    "tenantId",
    "threadId",
    "workspaceBindingId",
  ] as const;
  const allowed = new Set<string>([...required, "origin", "purpose"]);
  if (
    !isPlainObject(data) ||
    required.some((key) => !Object.hasOwn(data, key)) ||
    Object.keys(data).some((key) => !allowed.has(key))
  ) {
    throw new RunLifecycleError("run_created_fields_invalid");
  }
}

function parseRunOrigin(value: unknown): AutomationInvocationOrigin | null {
  if (value === undefined || value === null) return null;
  try {
    return parseAutomationInvocationOrigin(value);
  } catch {
    throw new RunLifecycleError("automation_invocation_origin_invalid");
  }
}

function addRunUsage(current: RunUsage, delta: RunUsage): RunUsage {
  const usage = {
    inputTokens: current.inputTokens + delta.inputTokens,
    cachedInputTokens: current.cachedInputTokens + delta.cachedInputTokens,
    outputTokens: current.outputTokens + delta.outputTokens,
    totalTokens: current.totalTokens + delta.totalTokens,
  };
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.cachedInputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.cachedInputTokens > usage.inputTokens ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens
  ) {
    throw new RunLifecycleError("usage_overflow");
  }
  return usage;
}

function normalizedEventUsage(delta: {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
}): RunUsage {
  return {
    inputTokens: delta.inputTokens,
    cachedInputTokens: delta.cachedInputTokens ?? 0,
    outputTokens: delta.outputTokens,
    totalTokens: delta.totalTokens,
  };
}

function validateEventEnvelope(event: RunLifecycleEvent): void {
  if (event.schemaVersion !== "crewon.run-event.v0") {
    throw new RunLifecycleError("event_schema_version_unsupported");
  }
  requireNonEmpty(event.eventId, "event_id_invalid");
  requireNonEmpty(event.identity.runId, "run_id_invalid");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new RunLifecycleError("sequence_invalid");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
      event.occurredAt,
    ) ||
    Number.isNaN(Date.parse(event.occurredAt))
  ) {
    throw new RunLifecycleError("occurred_at_invalid");
  }
}

function validateCancelProgress(
  state: RunState,
  eventType: RunLifecycleEvent["type"],
): void {
  if (!state.cancelRequested) {
    return;
  }
  if (eventType === "run.cancel.requested") {
    throw new RunLifecycleError("cancel_already_requested");
  }
  if (
    eventType === "run.canceled" ||
    eventType === "run.goal.accounting.updated" ||
    (eventType === "run.reconciliation.required" &&
      state.status === "running") ||
    (eventType === "run.resumed" &&
      (state.status === "reconciling" || state.status === "waitingApproval"))
  ) {
    return;
  }
  throw new RunLifecycleError("cancel_pending");
}

function mapGoalAccountingError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof RunGoalAccountingError) {
      throw new RunLifecycleError(error.code);
    }
    throw error;
  }
}

function requireStatus(
  state: RunState,
  eventType: RunLifecycleEvent["type"],
  allowed: readonly RunStatus[],
): void {
  if (!allowed.includes(state.status)) {
    throw new RunLifecycleError(
      `invalid_transition:${state.status}:${eventType}`,
    );
  }
}

function requireNonEmpty(value: string, code: string): void {
  if (value.trim().length === 0) {
    throw new RunLifecycleError(code);
  }
}

function requireNullableNonEmpty(value: string | null, code: string): void {
  if (value !== null) {
    requireNonEmpty(value, code);
  }
}

function validateSegmentIdentity(data: {
  segmentId: string;
  segmentSequence: number;
}): void {
  requireNonEmpty(data.segmentId, "segment_id_invalid");
  requirePositiveInteger(data.segmentSequence, "segment_sequence_invalid");
}

function validateToolIdentity(data: {
  callId: string;
  kind: "function" | "custom";
  name: string;
}): void {
  requireNonEmpty(data.callId, "tool_call_id_invalid");
  requireNonEmpty(data.name, "tool_name_invalid");
  if (data.kind !== "function" && data.kind !== "custom") {
    throw new RunLifecycleError("tool_kind_invalid");
  }
}

function requirePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RunLifecycleError(code);
  }
}

function requireNonNegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RunLifecycleError(code);
  }
}

function requireBoundedNonEmpty(
  value: string,
  maxBytes: number,
  code: string,
): void {
  requireNonEmpty(value, code);
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw new RunLifecycleError(code);
  }
}

function requireBoundedString(
  value: string,
  maxBytes: number,
  code: string,
): void {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new RunLifecycleError(code);
  }
}

function requireDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new RunLifecycleError("message_content_digest_invalid");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
