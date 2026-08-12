import {
  canonicalActionIntent,
  parseActionIntent,
  parseCanonicalAgentEvent,
  parseProviderCheckpoint,
  type ActionIntent,
  type CanonicalAgentEvent,
} from "@crewon/contracts";
import type {
  ModelHistoryItem,
  ProposedPlan,
  GoalRunTerminalOutcome,
  RunLifecycleEvent,
  RunAttemptState,
  RunState,
  ThreadGoal,
  ThreadLifecycleEvent,
  ToolApprovalState,
  ToolExecutionEffect,
  ToolExecutionReceiptState,
  ToolExecutionRecovery,
} from "@crewon/domain";
import {
  TURN_ABORTED_HISTORY_MARKER,
  accountThreadGoalAtToolBoundary,
  advanceRunGoalAccounting,
  createToolApproval,
  prepareToolExecutionReceipt,
  projectEffectiveModelHistory,
  settleThreadGoalForRun,
  settleThreadGoalFromAccounting,
  threadGoalContinuationPrompt,
  threadGoalSteeringPrompt,
  validateProposedPlan,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type {
  ApplicationClock,
  ApplicationIdGenerator,
  ApplicationIdKind,
  ContentDigester,
} from "./application-runtime-ports.ts";
import { canonicalJson } from "./canonical-json.ts";
import type {
  OutboxMessage,
  WorkItem,
  WorkItemClaim,
} from "./durable-queue-port.ts";
import type { DomainStore } from "./domain-store-port.ts";
import type { GoalToolName } from "./goal-tool.ts";
import type { GoalToolExecutionResult } from "./goal-tool-store-port.ts";
import type {
  BeginRunAttemptResult,
  CommitAssistantSampleContinuationResult,
  CommitContextCompactionResult,
  CommitTextRunCompletionInput,
  CommitTextRunCompletionResult,
  RunAttemptIdentity,
  RunAttemptRunTerminalMutation,
  RunAttemptTransitionResult,
  RunExecutionStore,
  ThreadContinuationCheckpoint,
  ThreadContinuationLocator,
  ThreadModelState,
} from "./run-execution-store-port.ts";
import type { CommitRunResult } from "./run-store-port.ts";
import type { MessageRecord } from "./thread-store-port.ts";
import type { ModelHistoryAppend } from "./model-history-store-port.ts";
import type { TurnStartGoalMutation } from "./thread-goal-store-port.ts";
import type { ToolExecutionTransition } from "./tool-execution-store-port.ts";
import type { CommitToolExecutionCompletionResult } from "./tool-execution-store-port.ts";
import {
  executionIdempotency,
  leaseInput,
  mapAgentEvent,
  mapExecutionError,
  requireBoundedContent,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
  validateClaim,
  validateModelIdentity,
} from "./run-execution-support.ts";

export type RunExecutionPolicyDecision =
  | Readonly<{ outcome: "allow" }>
  | Readonly<{ outcome: "deny"; reasonCode: string }>;

/** Revalidates the immutable Run route and policy snapshot before execution. */
export interface RunExecutionPolicyPort {
  evaluate(input: {
    run: RunState;
    workItem: WorkItem;
  }): Promise<RunExecutionPolicyDecision>;
}

export type ToolExecutionCall = Readonly<{
  segmentId: string;
  callId: string;
  kind: "function" | "custom";
  name: string;
  input: string;
}>;

export type ToolActionPolicy = Readonly<{
  effect: ToolExecutionEffect;
  recovery: ToolExecutionRecovery;
  resourceBindingId: string | null;
  credentialBindingId: string | null;
  executionTarget: ActionIntent["executionTarget"];
  capability: string;
  approvalRequirement: ActionIntent["approvalRequirement"];
  limits: ActionIntent["limits"];
}>;

export type BeginToolExecutionResult = Readonly<{
  disposition: "prepared" | "existing";
  receipt: ToolExecutionReceiptState;
  attempt: BeginRunAttemptResult | null;
}>;

export type RequireToolApprovalResult = Readonly<{
  disposition: "required" | "existing";
  approval: ToolApprovalState;
}>;

export type ToolCompletedAgentEvent = Readonly<
  Omit<CanonicalAgentEvent, "type" | "data"> & {
    type: "tool.completed";
    data: Readonly<{
      callId: string;
      kind: "function" | "custom";
      name: string;
      output: string;
      isError: boolean;
      artifactRef: string | null;
      outputTruncated: boolean;
    }>;
  }
>;

function abortedToolOutput(
  requested: Extract<RunLifecycleEvent, { type: "tool.requested" }>,
  abortedAt: string,
): string {
  const elapsedSeconds = Math.max(
    0,
    (Date.parse(abortedAt) - Date.parse(requested.occurredAt)) / 1_000,
  );
  const elapsed = elapsedSeconds.toFixed(1);
  return requested.data.kind === "function" &&
    (requested.data.name === "shell_command" ||
      requested.data.name === "unified_exec")
    ? `Wall time: ${elapsed} seconds\naborted by user`
    : `aborted by user after ${elapsed}s`;
}

export class RunExecutionService {
  readonly #store: DomainStore;
  readonly #clock: ApplicationClock;
  readonly #ids: ApplicationIdGenerator;
  readonly #digester: ContentDigester;

  constructor(dependencies: {
    store: DomainStore;
    clock: ApplicationClock;
    ids: ApplicationIdGenerator;
    digester: ContentDigester;
  }) {
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
    this.#ids = dependencies.ids;
    this.#digester = dependencies.digester;
  }

  async loadRun(claim: WorkItemClaim): Promise<RunState> {
    validateClaim(claim);
    let state: RunState | null;
    try {
      state = await this.#store.loadRun({
        tenantId: claim.workItem.tenantId,
        runId: claim.workItem.runId,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    if (state === null) {
      throw new ApplicationError("notFound", "run_not_found");
    }
    return state;
  }

  async startRun(claim: WorkItemClaim): Promise<CommitRunResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "queued") {
      throw new ApplicationError("conflict", "run_not_queued");
    }
    return this.#commitLeasedEvent(
      claim,
      state,
      "start",
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: state.runId },
        eventId: this.#nextId("runEvent"),
        sequence: state.lastSequence + 1,
        occurredAt: this.#now(),
        type: "run.started",
        data: {},
      },
      { kind: "run.start" },
    );
  }

  async consumeGoalSteering(
    claim: WorkItemClaim,
  ): Promise<CommitRunResult | null> {
    const state = await this.loadRun(claim);
    const pending = state.goalAccounting?.pendingSteering ?? null;
    if (pending === null) return null;
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }

    let goal: ThreadGoal | null;
    try {
      goal = await this.#store.loadThreadGoal({
        tenantId: state.tenantId,
        threadId: state.threadId,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    const expectedStatus =
      pending.kind === "objectiveUpdated" ? "active" : "budgetLimited";
    if (
      goal === null ||
      goal.goalId !== pending.target.goalId ||
      goal.revision !== pending.target.revision ||
      goal.status !== expectedStatus ||
      this.#digest(goal.objective) !== pending.target.objectiveDigest
    ) {
      throw new ApplicationError("conflict", "goal_steering_stale");
    }

    const head = await this.#modelHistoryHead(state);
    const occurredAt = this.#now();
    const prompt = threadGoalSteeringPrompt(goal, pending.kind);
    const historyItem: ModelHistoryItem = {
      schemaVersion: "crewon.model-history-item.v0",
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: state.tenantId,
      threadId: state.threadId,
      sequence: head.lastSequence + 1,
      runId: state.runId,
      segmentId: null,
      createdAt: occurredAt,
      type: "message",
      role: "user",
      source: "goal_steering",
      content: prompt,
      contentDigest: this.#digest(prompt),
    };
    const event: Extract<
      RunLifecycleEvent,
      { type: "run.goal.steering.consumed" }
    > = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "run.goal.steering.consumed",
      data: { handoffId: pending.handoffId },
    };
    return this.#commitLeasedEvent(
      claim,
      state,
      `goal-steering:${pending.handoffId}`,
      event,
      {
        kind: "goal.steering.consume",
        handoffId: pending.handoffId,
        target: pending.target,
      },
      { expectedLastSequence: head.lastSequence, items: [historyItem] },
    );
  }

  async beginModelAttempt(
    claim: WorkItemClaim,
    options: Readonly<{
      allowCancelPending?: boolean;
      stepId?: string;
    }> = {},
  ): Promise<BeginRunAttemptResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested && options.allowCancelPending !== true) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    try {
      return await this.#store.beginRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        stepId: options.stepId ?? claim.workItem.workItemId,
        kind: "model",
        attemptId: this.#nextId("attempt"),
        startedAt: this.#now(),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async beginContextCompaction(
    claim: WorkItemClaim,
    throughHistorySequence: number,
  ): Promise<BeginRunAttemptResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    requirePositiveInteger(
      throughHistorySequence,
      "compaction_history_sequence_invalid",
    );
    try {
      return await this.#store.beginRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        stepId: `compaction:${claim.workItem.workItemId}:${throughHistorySequence}`,
        kind: "model",
        attemptId: this.#nextId("attempt"),
        startedAt: this.#now(),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async commitContextCompaction(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    input: Readonly<{
      mode: "auto" | "manual";
      completion: "continueRun" | "completeRun";
      expectedHistorySequence: number;
      replacesThroughSequence?: number;
      retainedUserMessageLimit: number;
      segmentId: string;
      summary: string;
      usage: Readonly<{
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }>;
    }>,
  ): Promise<CommitContextCompactionResult> {
    const state = await this.loadRun(claim);
    if (
      state.status !== "running" ||
      state.cancelRequested ||
      (input.mode !== "auto" && input.mode !== "manual") ||
      (input.mode === "auto" && input.completion !== "continueRun") ||
      (input.mode === "manual" && input.completion !== "completeRun") ||
      (input.completion === "completeRun" &&
        (state.purpose !== "manualCompaction" || state.goalBinding !== null))
    ) {
      throw new ApplicationError("conflict", "context_compaction_not_current");
    }
    requirePositiveInteger(
      input.expectedHistorySequence,
      "compaction_history_sequence_invalid",
    );
    const retainedUserMessageLimit = requirePositiveInteger(
      input.retainedUserMessageLimit,
      "compaction_retained_message_limit_invalid",
    );
    if (retainedUserMessageLimit > 128) {
      throw new ApplicationError(
        "validation",
        "compaction_retained_message_limit_invalid",
      );
    }
    requireNonEmpty(input.segmentId, "segment_id_invalid");
    requireBoundedContent(input.summary);
    const inputTokens = requireNonNegativeInteger(
      input.usage.inputTokens,
      "compaction_input_tokens_invalid",
    );
    const cachedInputTokens = requireNonNegativeInteger(
      input.usage.cachedInputTokens,
      "compaction_cached_input_tokens_invalid",
    );
    const outputTokens = requireNonNegativeInteger(
      input.usage.outputTokens,
      "compaction_output_tokens_invalid",
    );
    const totalTokens = requireNonNegativeInteger(
      input.usage.totalTokens,
      "compaction_total_tokens_invalid",
    );
    if (
      cachedInputTokens > inputTokens ||
      totalTokens !== inputTokens + outputTokens
    ) {
      throw new ApplicationError("validation", "compaction_usage_invalid");
    }
    const head = await this.#modelHistoryHead(state);
    if (head.lastSequence !== input.expectedHistorySequence) {
      throw new ApplicationError("conflict", "model_history_sequence_conflict");
    }
    const replacesThroughSequence = requirePositiveInteger(
      input.replacesThroughSequence ?? head.lastSequence,
      "compaction_replaces_sequence_invalid",
    );
    if (replacesThroughSequence > head.lastSequence) {
      throw new ApplicationError(
        "validation",
        "compaction_replaces_sequence_invalid",
      );
    }
    const history = await this.#loadModelHistory(state, head.lastSequence);
    const source = projectEffectiveModelHistory(history).items.filter(
      (item) => item.sequence <= replacesThroughSequence,
    );
    const occurredAt = this.#now();
    const compactionItemId = this.#nextId("modelHistoryItem");
    const sourceDigest = this.#digest(canonicalJson(source));
    const summaryDigest = this.#digest(input.summary);
    const historyItem: Extract<ModelHistoryItem, { type: "compaction" }> = {
      schemaVersion: "crewon.model-history-item.v0",
      itemId: compactionItemId,
      tenantId: state.tenantId,
      threadId: state.threadId,
      sequence: head.lastSequence + 1,
      runId: state.runId,
      segmentId: input.segmentId,
      createdAt: occurredAt,
      type: "compaction",
      mode: input.mode,
      replacesThroughSequence,
      sourceDigest,
      summary: input.summary,
      summaryDigest,
      retainedUserMessages: retainedCompactionUserMessages(
        source,
        retainedUserMessageLimit,
      ).map((content) => ({
        content,
        contentDigest: this.#digest(content),
      })),
    };
    const event: Extract<RunLifecycleEvent, { type: "context.compacted" }> = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "context.compacted",
      data: {
        stepId: attempt.stepId,
        compactionItemId,
        mode: input.mode,
        replacesThroughSequence,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
      },
    };
    const completionEvent: Extract<
      RunLifecycleEvent,
      { type: "run.completed" }
    > | null =
      input.completion === "completeRun"
        ? {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: state.runId },
            eventId: this.#nextId("runEvent"),
            sequence: event.sequence + 1,
            occurredAt,
            type: "run.completed",
            data: { outputRef: null },
          }
        : null;
    const events =
      completionEvent === null ? [event] : [event, completionEvent];
    try {
      return await this.#store.commitContextCompaction({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `context-compaction:${head.lastSequence}:${replacesThroughSequence}`,
            {
              kind: "context.compaction",
              mode: input.mode,
              completion: input.completion,
              replacesThroughSequence,
              sourceDigest,
              summaryDigest,
              retainedUserMessageLimit,
              usage: {
                inputTokens,
                cachedInputTokens,
                outputTokens,
                totalTokens,
              },
              attempt,
            },
          ),
          expectedRevision: state.revision,
          events,
          outbox: events.map((item) => this.#outbox(state.tenantId, item)),
          workItems: [],
        },
        history: {
          expectedLastSequence: head.lastSequence,
          items: [historyItem],
        },
        attempt: { ...attempt, finishedAt: occurredAt },
        completion: input.completion,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async beginToolExecution(
    claim: WorkItemClaim,
    call: ToolExecutionCall,
    policy: ToolActionPolicy,
  ): Promise<BeginToolExecutionResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    const { actionIntent, actionDigest, inputDigest } = this.#toolAction(
      state,
      call,
      policy,
    );
    try {
      const existing = await this.#store.loadToolExecutionReceiptByAction({
        tenantId: state.tenantId,
        runId: state.runId,
        actionDigest,
      });
      if (existing !== null) {
        this.#validateToolActionIntent(existing, actionIntent);
        return { disposition: "existing", receipt: existing, attempt: null };
      }
      const stepId = `tool:${actionDigest.slice("sha256:".length)}`;
      const attempt = await this.#store.beginRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        stepId,
        kind: "tool",
        attemptId: this.#nextId("attempt"),
        startedAt: this.#now(),
      });
      const receipt = prepareToolExecutionReceipt({
        receiptId: this.#nextId("toolReceipt"),
        tenantId: state.tenantId,
        runId: state.runId,
        stepId,
        attemptId: attempt.attempt.attemptId,
        workItemId: claim.workItem.workItemId,
        executionId: this.#nextId("toolExecution"),
        idempotencyKey: `${state.runId}/tool/${actionDigest.slice("sha256:".length)}`,
        actionDigest,
        actionIntent,
        call: {
          segmentId: call.segmentId,
          callId: call.callId,
          kind: call.kind,
          name: call.name,
          inputDigest,
        },
        effect: policy.effect,
        recovery: policy.recovery,
        preparedAt: attempt.attempt.startedAt,
      });
      return {
        disposition: "prepared",
        receipt: await this.#store.prepareToolExecution({
          lease: leaseInput(claim),
          receipt,
        }),
        attempt,
      };
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  /** Resolves an already prepared, different ActionIntent for approval replacement. */
  async loadToolApprovalReplacementReceipt(
    claim: WorkItemClaim,
    current: ToolApprovalState,
    call: ToolExecutionCall,
    policy: ToolActionPolicy,
  ): Promise<ToolExecutionReceiptState | null> {
    const state = await this.loadRun(claim);
    if (
      state.status !== "waitingApproval" ||
      state.waitingApproval?.approvalId !== current.approvalId ||
      state.waitingApproval.actionDigest !== current.actionDigest ||
      current.status !== "required" ||
      current.tenantId !== state.tenantId ||
      current.spaceId !== state.spaceId ||
      current.runId !== state.runId ||
      current.workItemId !== claim.workItem.workItemId
    ) {
      throw new ApplicationError("conflict", "tool_approval_not_current");
    }
    const { actionIntent, actionDigest } = this.#toolAction(
      state,
      call,
      policy,
    );
    if (actionDigest === current.actionDigest) {
      return null;
    }
    const receipt = await this.#store.loadToolExecutionReceiptByAction({
      tenantId: state.tenantId,
      runId: state.runId,
      actionDigest,
    });
    if (receipt === null) {
      return null;
    }
    this.#validateToolActionIntent(receipt, actionIntent);
    if (
      receipt.status !== "prepared" ||
      receipt.workItemId !== claim.workItem.workItemId ||
      receipt.actionIntent?.approvalRequirement !== "perAction"
    ) {
      throw new ApplicationError(
        "conflict",
        "tool_approval_replacement_receipt_invalid",
      );
    }
    return receipt;
  }

  async transitionToolExecution(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    transition: ToolExecutionTransition,
  ): Promise<ToolExecutionReceiptState> {
    validateClaim(claim);
    if (
      receipt.tenantId !== claim.workItem.tenantId ||
      receipt.runId !== claim.workItem.runId ||
      receipt.workItemId !== claim.workItem.workItemId
    ) {
      throw new ApplicationError("validation", "tool_receipt_claim_mismatch");
    }
    try {
      return await this.#store.transitionToolExecution({
        tenantId: receipt.tenantId,
        runId: receipt.runId,
        receiptId: receipt.receiptId,
        lease: leaseInput(claim),
        expectedRevision: receipt.revision,
        transition,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async requireToolApproval(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    input: Readonly<{ expiresAfterMs: number | null; retryAfterMs: number }>,
  ): Promise<RequireToolApprovalResult> {
    validateClaim(claim);
    const intent = receipt.actionIntent;
    if (
      intent === null ||
      intent.approvalRequirement !== "perAction" ||
      receipt.tenantId !== claim.workItem.tenantId ||
      receipt.runId !== claim.workItem.runId ||
      receipt.workItemId !== claim.workItem.workItemId
    ) {
      throw new ApplicationError("validation", "tool_approval_receipt_invalid");
    }
    let existing: ToolApprovalState | null;
    try {
      existing = await this.#store.loadToolApprovalByAction({
        tenantId: receipt.tenantId,
        runId: receipt.runId,
        actionDigest: receipt.actionDigest,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    if (existing !== null) {
      validateApprovalBinding(existing, receipt);
      return { disposition: "existing", approval: existing };
    }

    const state = await this.loadRun(claim);
    if (state.status !== "running" || state.cancelRequested) {
      throw new ApplicationError("conflict", "run_not_running");
    }
    const requiredAt = this.#now();
    const expiresAt = approvalExpiresAt(requiredAt, input.expiresAfterMs);
    let approval: ToolApprovalState;
    try {
      approval = createToolApproval({
        approvalId: this.#nextId("approval"),
        tenantId: state.tenantId,
        spaceId: state.spaceId,
        runId: state.runId,
        receiptId: receipt.receiptId,
        workItemId: receipt.workItemId,
        actionDigest: receipt.actionDigest,
        policySnapshotId: intent.policySnapshotId,
        requestedByActorId: state.createdByActorId,
        requiredAt,
        expiresAt,
      });
    } catch (error) {
      throw new ApplicationError("validation", "tool_approval_invalid", {
        cause: error,
      });
    }
    const event: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt: requiredAt,
      type: "run.approval.required",
      data: {
        approvalId: approval.approvalId,
        actionDigest: approval.actionDigest,
      },
    };
    try {
      await this.#store.requireToolApproval({
        lease: leaseInput(claim),
        approval,
        retryAfterMs: input.retryAfterMs,
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `tool-approval:${approval.actionDigest}`,
            {
              kind: "tool.approval.require",
              approvalId: approval.approvalId,
              actionDigest: approval.actionDigest,
            },
          ),
          expectedRevision: state.revision,
          events: [event],
          outbox: [this.#outbox(state.tenantId, event)],
          workItems: [],
        },
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    return { disposition: "required", approval };
  }

  async expireToolApproval(
    claim: WorkItemClaim,
    approval: ToolApprovalState,
  ): Promise<ToolApprovalState | null> {
    validateClaim(claim);
    const state = await this.loadRun(claim);
    if (
      state.status !== "waitingApproval" ||
      state.waitingApproval?.approvalId !== approval.approvalId ||
      state.waitingApproval.actionDigest !== approval.actionDigest ||
      approval.tenantId !== state.tenantId ||
      approval.runId !== state.runId ||
      approval.workItemId !== claim.workItem.workItemId ||
      approval.status !== "required"
    ) {
      throw new ApplicationError("conflict", "tool_approval_not_current");
    }
    const occurredAt = this.#now();
    if (
      approval.expiresAt === null ||
      Date.parse(occurredAt) < Date.parse(approval.expiresAt)
    ) {
      return null;
    }
    const event: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "run.resumed",
      data: { reasonCode: "tool_approval_expired" },
    };
    try {
      const result = await this.#store.expireToolApproval({
        tenantId: state.tenantId,
        approvalId: approval.approvalId,
        lease: leaseInput(claim),
        expectedRevision: approval.revision,
        occurredAt,
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `tool-approval-expire:${approval.actionDigest}`,
            {
              kind: "tool.approval.expire",
              approvalId: approval.approvalId,
              actionDigest: approval.actionDigest,
            },
          ),
          expectedRevision: state.revision,
          events: [event],
          outbox: [this.#outbox(state.tenantId, event)],
          workItems: [],
        },
      });
      return result.approval;
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async supersedeToolApprovalForCancellation(
    claim: WorkItemClaim,
    approval: ToolApprovalState,
  ): Promise<ToolApprovalState> {
    validateClaim(claim);
    const state = await this.loadRun(claim);
    if (
      state.status !== "waitingApproval" ||
      !state.cancelRequested ||
      state.waitingApproval?.approvalId !== approval.approvalId ||
      state.waitingApproval.actionDigest !== approval.actionDigest ||
      approval.tenantId !== state.tenantId ||
      approval.runId !== state.runId ||
      approval.workItemId !== claim.workItem.workItemId ||
      approval.status !== "required"
    ) {
      throw new ApplicationError("conflict", "tool_approval_not_current");
    }
    const occurredAt = this.#now();
    const event: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "run.resumed",
      data: { reasonCode: "tool_approval_superseded" },
    };
    try {
      const result = await this.#store.supersedeToolApproval({
        tenantId: state.tenantId,
        approvalId: approval.approvalId,
        lease: leaseInput(claim),
        expectedRevision: approval.revision,
        occurredAt,
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `tool-approval-supersede:${approval.actionDigest}`,
            {
              kind: "tool.approval.supersede",
              approvalId: approval.approvalId,
              actionDigest: approval.actionDigest,
              reasonCode: "run_cancel_requested",
            },
          ),
          expectedRevision: state.revision,
          events: [event],
          outbox: [this.#outbox(state.tenantId, event)],
          workItems: [],
        },
      });
      return result.approval;
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  /** Atomically replaces the current approval without exposing a public mutation API. */
  async replaceToolApproval(
    claim: WorkItemClaim,
    current: ToolApprovalState,
    replacementReceipt: ToolExecutionReceiptState,
    input: Readonly<{ expiresAfterMs: number | null; retryAfterMs: number }>,
  ): Promise<ToolApprovalState> {
    validateClaim(claim);
    const occurredAt = this.#now();
    const expiresAt = approvalExpiresAt(occurredAt, input.expiresAfterMs);
    const replay = await this.#store.loadToolApprovalByAction({
      tenantId: replacementReceipt.tenantId,
      runId: replacementReceipt.runId,
      actionDigest: replacementReceipt.actionDigest,
    });
    const state = await this.loadRun(claim);
    if (replay !== null) {
      const storedCurrent = await this.#store.loadToolApproval({
        tenantId: current.tenantId,
        approvalId: current.approvalId,
      });
      if (
        storedCurrent?.status !== "superseded" ||
        storedCurrent.terminalReasonCode !== "action_replaced" ||
        storedCurrent.actionDigest !== current.actionDigest ||
        replay.status !== "required" ||
        replay.tenantId !== state.tenantId ||
        replay.spaceId !== state.spaceId ||
        replay.runId !== state.runId ||
        replay.receiptId !== replacementReceipt.receiptId ||
        replay.workItemId !== replacementReceipt.workItemId ||
        replay.policySnapshotId !==
          replacementReceipt.actionIntent?.policySnapshotId ||
        state.status !== "waitingApproval" ||
        state.waitingApproval?.approvalId !== replay.approvalId ||
        state.waitingApproval.actionDigest !== replay.actionDigest
      ) {
        throw new ApplicationError(
          "conflict",
          "tool_approval_replacement_replay_invalid",
        );
      }
      return replay;
    }
    if (
      state.status !== "waitingApproval" ||
      state.cancelRequested ||
      state.waitingApproval?.approvalId !== current.approvalId ||
      state.waitingApproval.actionDigest !== current.actionDigest ||
      current.status !== "required" ||
      current.tenantId !== state.tenantId ||
      current.spaceId !== state.spaceId ||
      current.runId !== state.runId ||
      current.workItemId !== claim.workItem.workItemId ||
      replacementReceipt.tenantId !== state.tenantId ||
      replacementReceipt.runId !== state.runId ||
      replacementReceipt.workItemId !== claim.workItem.workItemId ||
      replacementReceipt.actionDigest === current.actionDigest ||
      replacementReceipt.status !== "prepared" ||
      replacementReceipt.actionIntent?.approvalRequirement !== "perAction"
    ) {
      throw new ApplicationError(
        "conflict",
        "tool_approval_replacement_invalid",
      );
    }
    let replacement: ToolApprovalState;
    try {
      replacement = createToolApproval({
        approvalId: this.#nextId("approval"),
        tenantId: state.tenantId,
        spaceId: state.spaceId,
        runId: state.runId,
        receiptId: replacementReceipt.receiptId,
        workItemId: replacementReceipt.workItemId,
        actionDigest: replacementReceipt.actionDigest,
        policySnapshotId: replacementReceipt.actionIntent.policySnapshotId,
        requestedByActorId: state.createdByActorId,
        requiredAt: occurredAt,
        expiresAt,
      });
    } catch (error) {
      throw new ApplicationError("validation", "tool_approval_invalid", {
        cause: error,
      });
    }
    const resumed: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "run.resumed",
      data: { reasonCode: "tool_approval_superseded" },
    };
    const required: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: resumed.sequence + 1,
      occurredAt,
      type: "run.approval.required",
      data: {
        approvalId: replacement.approvalId,
        actionDigest: replacement.actionDigest,
      },
    };
    try {
      const result = await this.#store.replaceToolApproval({
        lease: leaseInput(claim),
        current: {
          tenantId: current.tenantId,
          approvalId: current.approvalId,
          expectedRevision: current.revision,
          actionDigest: current.actionDigest,
        },
        replacement,
        occurredAt,
        retryAfterMs: input.retryAfterMs,
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `tool-approval-replace:${current.actionDigest}:${replacement.actionDigest}`,
            {
              kind: "tool.approval.replace",
              currentApprovalId: current.approvalId,
              currentActionDigest: current.actionDigest,
              replacementApprovalId: replacement.approvalId,
              replacementActionDigest: replacement.actionDigest,
            },
          ),
          expectedRevision: state.revision,
          events: [resumed, required],
          outbox: [resumed, required].map((event) =>
            this.#outbox(state.tenantId, event),
          ),
          workItems: [],
        },
      });
      return result.approval;
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async dispatchToolExecution(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
  ): Promise<ToolExecutionReceiptState> {
    return this.transitionToolExecution(claim, receipt, {
      kind: "dispatch",
      occurredAt: this.#now(),
    });
  }

  async commitToolExecutionCompletion(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    attempt: RunAttemptIdentity,
    canonicalEvent: ToolCompletedAgentEvent,
    providerReceiptId: string,
  ): Promise<CommitToolExecutionCompletionResult> {
    parseCanonicalAgentEvent(canonicalEvent);
    const state = await this.loadRun(claim);
    if (
      (state.status !== "running" && state.status !== "reconciling") ||
      state.cancelRequested ||
      receipt.tenantId !== state.tenantId ||
      receipt.runId !== state.runId ||
      receipt.stepId !== attempt.stepId ||
      receipt.call.segmentId !== canonicalEvent.segmentId ||
      receipt.call.callId !== canonicalEvent.data.callId ||
      receipt.call.kind !== canonicalEvent.data.kind ||
      receipt.call.name !== canonicalEvent.data.name
    ) {
      throw new ApplicationError("conflict", "tool_completion_not_current");
    }
    const occurredAt = this.#now();
    const resumeEvent: RunLifecycleEvent | null =
      state.status === "reconciling"
        ? {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: state.runId },
            eventId: this.#nextId("runEvent"),
            sequence: state.lastSequence + 1,
            occurredAt,
            type: "run.resumed",
            data: { reasonCode: "tool_receipt_reconciled" },
          }
        : null;
    const event = mapAgentEvent(
      canonicalEvent,
      state.lastSequence + (resumeEvent === null ? 1 : 2),
      this.#nextId("runEvent"),
      occurredAt,
      (checkpoint) => this.#digest(canonicalJson(checkpoint)),
    );
    const history = await this.#historyForAgentEvent(
      state,
      event,
      occurredAt,
      canonicalEvent,
    );
    if (history === null) {
      throw new ApplicationError("internal", "tool_history_missing");
    }
    const result = {
      output: canonicalEvent.data.output,
      outputDigest: this.#digest(canonicalEvent.data.output),
      isError: canonicalEvent.data.isError,
      artifactRef: canonicalEvent.data.artifactRef,
    };
    let currentGoal: ThreadGoal | null;
    try {
      currentGoal = await this.#store.loadThreadGoal({
        tenantId: state.tenantId,
        threadId: state.threadId,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    let boundary;
    try {
      boundary = accountThreadGoalAtToolBoundary(
        currentGoal,
        state,
        occurredAt,
      );
    } catch (error) {
      throw mapExecutionError(error);
    }
    const goal: TurnStartGoalMutation =
      boundary.goalState === currentGoal
        ? { kind: "keep", expectedRevision: currentGoal?.revision ?? null }
        : {
            kind: "set",
            expectedRevision: currentGoal?.revision ?? null,
            goal: boundary.goalState!,
          };
    const prefixEvents = resumeEvent === null ? [event] : [resumeEvent, event];
    const accountingEvent = this.#toolBoundaryGoalAccountingEvent(
      state,
      boundary.goalState,
      boundary.crossedBudget,
      event.sequence,
      occurredAt,
    );
    const events = [
      ...prefixEvents,
      ...(accountingEvent === null ? [] : [accountingEvent]),
    ];
    try {
      return await this.#store.commitToolExecutionCompletion({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `tool-complete:${receipt.receiptId}`,
            {
              kind: "tool.complete",
              receiptId: receipt.receiptId,
              actionDigest: receipt.actionDigest,
              providerReceiptId,
              event: canonicalEvent,
              attempt,
            },
          ),
          expectedRevision: state.revision,
          events,
          outbox: events.map((runEvent) =>
            this.#outbox(state.tenantId, runEvent),
          ),
          workItems: [],
        },
        goal,
        history,
        receipt: {
          tenantId: receipt.tenantId,
          runId: receipt.runId,
          receiptId: receipt.receiptId,
          expectedRevision: receipt.revision,
          providerReceiptId: requireNonEmpty(
            providerReceiptId,
            "tool_provider_receipt_id_invalid",
          ),
          result,
          resolvedAt: occurredAt,
        },
        attempt: { ...attempt, finishedAt: occurredAt },
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  #toolBoundaryGoalAccountingEvent(
    run: RunState,
    goal: ThreadGoal | null,
    crossedBudget: boolean,
    throughRunSequence: number,
    occurredAt: string,
  ): Extract<
    RunLifecycleEvent,
    { type: "run.goal.accounting.updated" }
  > | null {
    const cursor = run.goalAccounting;
    if (cursor === null || cursor.attribution === null) return null;
    if (
      goal === null ||
      (goal.status !== "active" && goal.status !== "budgetLimited")
    ) {
      throw new ApplicationError("conflict", "goal_accounting_result_invalid");
    }
    const nextBinding = {
      goalId: goal.goalId,
      revision: goal.revision,
      objectiveDigest: this.#digest(goal.objective),
    };
    const priorSteering = cursor.pendingSteering;
    const pendingSteering = crossedBudget
      ? {
          handoffId: this.#nextId("runEvent"),
          kind: "budgetLimited" as const,
          target: nextBinding,
          createdAt: occurredAt,
        }
      : priorSteering === null
        ? null
        : { ...priorSteering, target: nextBinding };
    let next;
    try {
      next = advanceRunGoalAccounting(cursor, {
        currentUsage: run.usage,
        throughRunSequence,
        occurredAt,
        nextBinding,
        pendingSteering,
        trackTime: true,
      }).next;
    } catch (error) {
      throw mapExecutionError(error);
    }
    return {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: throughRunSequence + 1,
      occurredAt,
      type: "run.goal.accounting.updated",
      data: { next },
    };
  }

  async markToolExecutionUnknown(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    providerReceiptId: string | null,
  ): Promise<ToolExecutionReceiptState> {
    return this.transitionToolExecution(claim, receipt, {
      kind: "unknownOutcome",
      occurredAt: this.#now(),
      providerReceiptId,
    });
  }

  async commitToolExecutionUnknownOutcome(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    attempt: RunAttemptIdentity,
    providerReceiptId: string | null,
    retryAfterMs: number,
  ) {
    const state = await this.loadRun(claim);
    if (
      state.status !== "running" ||
      state.runId !== receipt.runId ||
      state.tenantId !== receipt.tenantId ||
      claim.workItem.workItemId !== receipt.workItemId ||
      (receipt.status !== "dispatched" && receipt.status !== "unknownOutcome")
    ) {
      throw new ApplicationError("conflict", "tool_reconciliation_not_current");
    }
    const occurredAt = this.#now();
    const event: Extract<
      RunLifecycleEvent,
      { type: "run.reconciliation.required" }
    > = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + 1,
      occurredAt,
      type: "run.reconciliation.required",
      data: { receiptId: receipt.receiptId },
    };
    try {
      return await this.#store.commitToolExecutionUnknownOutcome({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `reconcile:${receipt.receiptId}`,
            {
              kind: "tool.reconciliation.required",
              receiptId: receipt.receiptId,
              providerReceiptId,
              attempt,
            },
          ),
          expectedRevision: state.revision,
          events: [event],
          outbox: [this.#outbox(state.tenantId, event)],
          workItems: [],
        },
        receipt: {
          tenantId: receipt.tenantId,
          runId: receipt.runId,
          receiptId: receipt.receiptId,
          expectedRevision: receipt.revision,
          providerReceiptId,
          observedAt: occurredAt,
        },
        attempt: { ...attempt, finishedAt: occurredAt },
        retryAfterMs: requireNonNegativeInteger(
          retryAfterMs,
          "retry_after_ms_invalid",
        ),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async cancelToolExecutionReceipt(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
    providerReceiptId: string | null,
  ): Promise<ToolExecutionReceiptState> {
    return this.transitionToolExecution(claim, receipt, {
      kind: "cancel",
      occurredAt: this.#now(),
      providerReceiptId,
    });
  }

  async beginToolReconciliation(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
  ): Promise<BeginRunAttemptResult> {
    const state = await this.loadRun(claim);
    if (
      state.status !== "reconciling" ||
      state.reconciliationReceiptId !== receipt.receiptId ||
      state.runId !== receipt.runId ||
      state.tenantId !== receipt.tenantId ||
      claim.workItem.workItemId !== receipt.workItemId
    ) {
      throw new ApplicationError("conflict", "tool_reconciliation_not_current");
    }
    try {
      return await this.#store.beginRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        stepId: receipt.stepId,
        kind: "tool",
        attemptId: this.#nextId("attempt"),
        startedAt: this.#now(),
        mode: "reconcile",
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async beginToolRecovery(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
  ): Promise<BeginRunAttemptResult> {
    const state = await this.loadRun(claim);
    if (
      state.status !== "running" ||
      state.runId !== receipt.runId ||
      state.tenantId !== receipt.tenantId ||
      claim.workItem.workItemId !== receipt.workItemId
    ) {
      throw new ApplicationError("conflict", "tool_recovery_not_current");
    }
    try {
      return await this.#store.beginRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        stepId: receipt.stepId,
        kind: "tool",
        attemptId: this.#nextId("attempt"),
        startedAt: this.#now(),
        mode: "execute",
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async resumeToolReconciliation(
    claim: WorkItemClaim,
    receipt: ToolExecutionReceiptState,
  ): Promise<CommitRunResult> {
    const state = await this.loadRun(claim);
    if (
      state.status !== "reconciling" ||
      state.reconciliationReceiptId !== receipt.receiptId
    ) {
      throw new ApplicationError("conflict", "tool_reconciliation_not_current");
    }
    const occurredAt = this.#now();
    return this.#commitLeasedEvent(
      claim,
      state,
      `reconciled:${receipt.receiptId}`,
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: state.runId },
        eventId: this.#nextId("runEvent"),
        sequence: state.lastSequence + 1,
        occurredAt,
        type: "run.resumed",
        data: { reasonCode: "tool_receipt_reconciled" },
      },
      { kind: "tool.reconciliation.resolved", receiptId: receipt.receiptId },
    );
  }

  validateToolExecutionInput(
    receipt: ToolExecutionReceiptState,
    input: string,
  ): void {
    if (this.#digest(input) !== receipt.call.inputDigest) {
      throw new ApplicationError("validation", "tool_input_digest_mismatch");
    }
    if (
      receipt.actionIntent === null ||
      this.#digest(canonicalActionIntent(receipt.actionIntent)) !==
        receipt.actionDigest
    ) {
      throw new ApplicationError("validation", "tool_action_intent_mismatch");
    }
  }

  #toolAction(
    state: RunState,
    call: ToolExecutionCall,
    policy: ToolActionPolicy,
  ): Readonly<{
    actionIntent: ActionIntent;
    actionDigest: string;
    inputDigest: string;
  }> {
    validateToolExecutionCall(call);
    const inputDigest = this.#digest(call.input);
    let actionIntent: ActionIntent;
    try {
      actionIntent = parseActionIntent({
        schemaVersion: "crewon.action-intent.v0",
        runId: state.runId,
        segmentId: call.segmentId,
        callId: call.callId,
        tool: { kind: call.kind, name: call.name, inputDigest },
        effect: policy.effect,
        recovery: policy.recovery,
        policySnapshotId: state.policySnapshotId,
        workspaceBindingId: state.workspaceBindingId,
        resourceBindingId: policy.resourceBindingId,
        credentialBindingId: policy.credentialBindingId,
        executionTarget: policy.executionTarget,
        capability: policy.capability,
        approvalRequirement: policy.approvalRequirement,
        limits: policy.limits,
      });
    } catch (error) {
      throw new ApplicationError("validation", "tool_action_intent_invalid", {
        cause: error,
      });
    }
    return {
      actionIntent,
      actionDigest: this.#digest(canonicalActionIntent(actionIntent)),
      inputDigest,
    };
  }

  #validateToolActionIntent(
    receipt: ToolExecutionReceiptState,
    expected: ActionIntent,
  ): void {
    if (
      receipt.actionIntent === null ||
      canonicalActionIntent(receipt.actionIntent) !==
        canonicalActionIntent(expected) ||
      this.#digest(canonicalActionIntent(receipt.actionIntent)) !==
        receipt.actionDigest
    ) {
      throw new ApplicationError("conflict", "tool_action_intent_mismatch");
    }
  }

  async retryToolReconciliation(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    retryAfterMs: number,
  ): Promise<RunAttemptTransitionResult> {
    const state = await this.loadRun(claim);
    if (state.status !== "reconciling") {
      throw new ApplicationError("conflict", "run_not_reconciling");
    }
    try {
      return await this.#store.retryRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        attempt: {
          ...attempt,
          finishedAt: this.#now(),
          checkpointDigest: null,
          failure: { code: "tool_outcome_unknown", retryable: true },
        },
        retryAfterMs: requireNonNegativeInteger(
          retryAfterMs,
          "retry_after_ms_invalid",
        ),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async completeAttempt(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    checkpointDigest: string | null = null,
    control: Readonly<{ providerTurnState: string | null }> | null = null,
  ): Promise<RunAttemptTransitionResult> {
    const state = await this.loadRun(claim);
    try {
      return await this.#store.completeRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        attempt: {
          ...attempt,
          finishedAt: this.#now(),
          checkpointDigest,
          ...(control === null
            ? {}
            : { providerTurnState: control.providerTurnState }),
        },
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async checkpointModelAttempt(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    checkpoint: import("@crewon/contracts").ProviderCheckpoint,
  ): Promise<RunAttemptState> {
    const state = await this.loadRun(claim);
    const parsed = parseProviderCheckpoint(checkpoint);
    try {
      return await this.#store.checkpointRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        attempt,
        checkpoint: parsed,
        checkpointDigest: this.#digest(canonicalJson(parsed)),
        checkpointedAt: this.#now(),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async loadPredecessorProviderCheckpoint(
    claim: WorkItemClaim,
    started: BeginRunAttemptResult,
    identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">,
  ): Promise<import("@crewon/contracts").ProviderCheckpoint | null> {
    const predecessorId = started.attempt.retryOfAttemptId;
    if (predecessorId === null) return null;
    const state = await this.loadRun(claim);
    const predecessor = await this.#store.loadRunAttempt({
      tenantId: state.tenantId,
      runId: state.runId,
      stepId: started.attempt.stepId,
      attemptId: predecessorId,
    });
    const recoverable =
      predecessor?.status === "abandoned" ||
      (predecessor?.status === "failed" &&
        predecessor.failure?.retryable === true);
    if (!recoverable || predecessor?.providerCheckpoint === null) return null;
    const checkpoint = parseProviderCheckpoint(predecessor.providerCheckpoint);
    if (
      predecessor.attemptId !== predecessorId ||
      predecessor.checkpointDigest !==
        this.#digest(canonicalJson(checkpoint)) ||
      checkpoint.adapterName !== identity.adapterName ||
      checkpoint.adapterVersion !== identity.adapterVersion ||
      checkpoint.modelId !== identity.modelId
    ) {
      throw new ApplicationError(
        "conflict",
        "provider_response_recovery_authority_mismatch",
      );
    }
    return checkpoint;
  }

  async loadRunProviderTurnState(claim: WorkItemClaim): Promise<string | null> {
    const state = await this.loadRun(claim);
    return await this.#store.loadRunProviderTurnState({
      tenantId: state.tenantId,
      runId: state.runId,
    });
  }

  async loadThreadContinuation(
    claim: WorkItemClaim,
    identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">,
  ): Promise<ThreadContinuationCheckpoint | null> {
    const state = await this.loadRun(claim);
    validateModelIdentity(identity);
    try {
      return await this.#store.loadThreadContinuation({
        tenantId: state.tenantId,
        threadId: state.threadId,
        ...identity,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async loadThreadModelState(
    claim: WorkItemClaim,
  ): Promise<ThreadModelState | null> {
    const state = await this.loadRun(claim);
    try {
      return await this.#store.loadThreadModelState({
        tenantId: state.tenantId,
        threadId: state.threadId,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async recordAgentEvent(
    claim: WorkItemClaim,
    canonicalEvent: CanonicalAgentEvent,
  ): Promise<CommitRunResult> {
    parseCanonicalAgentEvent(canonicalEvent);
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    if (canonicalEvent.runId !== state.runId) {
      throw new ApplicationError("validation", "agent_event_run_id_mismatch");
    }
    const occurredAt = this.#now();
    const event = mapAgentEvent(
      canonicalEvent,
      state.lastSequence + 1,
      this.#nextId("runEvent"),
      occurredAt,
      (checkpoint) => this.#digest(canonicalJson(checkpoint)),
    );
    const history = await this.#historyForAgentEvent(
      state,
      event,
      occurredAt,
      canonicalEvent,
    );
    return this.#commitLeasedEvent(
      claim,
      state,
      `agent:${canonicalEvent.segmentId}:${canonicalEvent.sequence}`,
      event,
      { kind: "agent.event", event: canonicalEvent },
      history,
    );
  }

  async commitAssistantSampleContinuation(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    input: Readonly<{
      sampleIndex: number;
      segmentId: string;
      output: string;
      completedAssistantItems: readonly string[];
      events: readonly CanonicalAgentEvent[];
      identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">;
      contextRevision: string;
      modelPolicy: Readonly<{
        contextWindowTokens: number;
        autoCompactAtTokens: number | null;
      }>;
      latestUsage: ThreadModelState["latestUsage"];
      checkpoint: import("@crewon/contracts").ProviderCheckpoint | null;
      providerTurnState: string | null;
    }>,
  ): Promise<CommitAssistantSampleContinuationResult> {
    requirePositiveInteger(input.sampleIndex, "assistant_sample_index_invalid");
    requireBoundedContent(input.output);
    validateModelIdentity(input.identity);
    const checkpoint =
      input.checkpoint === null
        ? null
        : parseProviderCheckpoint(input.checkpoint);
    if (
      checkpoint !== null &&
      (checkpoint.adapterName !== input.identity.adapterName ||
        checkpoint.adapterVersion !== input.identity.adapterVersion ||
        checkpoint.modelId !== input.identity.modelId)
    ) {
      throw new ApplicationError(
        "validation",
        "provider_checkpoint_identity_mismatch",
      );
    }
    const state = await this.loadRun(claim);
    if (state.status !== "running" || state.cancelRequested) {
      throw new ApplicationError("conflict", "run_not_running");
    }
    const occurredAt = this.#now();
    const head = await this.#modelHistoryHead(state);
    if (
      input.completedAssistantItems.length === 0 ||
      input.completedAssistantItems.join("") !== input.output
    ) {
      throw new ApplicationError(
        "validation",
        "assistant_sample_items_invalid",
      );
    }
    const historyItems: ModelHistoryItem[] = input.completedAssistantItems.map(
      (content, index) => ({
        schemaVersion: "crewon.model-history-item.v0",
        itemId: this.#nextId("modelHistoryItem"),
        tenantId: state.tenantId,
        threadId: state.threadId,
        sequence: head.lastSequence + index + 1,
        runId: state.runId,
        segmentId: input.segmentId,
        createdAt: occurredAt,
        type: "message",
        role: "assistant",
        source: "assistant_completion",
        content,
        contentDigest: this.#digest(content),
      }),
    );
    const toolRequests = input.events.filter(
      (event) => event.type === "tool.requested",
    );
    for (const event of toolRequests) {
      const { kind, callId, name, input: toolInput } = event.data;
      if (
        (kind !== "function" && kind !== "custom") ||
        typeof callId !== "string" ||
        typeof name !== "string" ||
        typeof toolInput !== "string"
      ) {
        throw new ApplicationError("validation", "model_tool_call_invalid");
      }
      historyItems.push({
        schemaVersion: "crewon.model-history-item.v0",
        itemId: this.#nextId("modelHistoryItem"),
        tenantId: state.tenantId,
        threadId: state.threadId,
        sequence: head.lastSequence + historyItems.length + 1,
        runId: state.runId,
        segmentId: input.segmentId,
        createdAt: occurredAt,
        type: "tool_call",
        kind,
        callId,
        name,
        input: toolInput,
      });
    }
    const events: RunLifecycleEvent[] = input.events.map((event, index) =>
      mapAgentEvent(
        event,
        state.lastSequence + index + 1,
        this.#nextId("runEvent"),
        occurredAt,
        (checkpoint) => this.#digest(canonicalJson(checkpoint)),
      ),
    );
    events.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: state.runId },
      eventId: this.#nextId("runEvent"),
      sequence: state.lastSequence + events.length + 1,
      occurredAt,
      type: "segment.provider_continuation",
      data: {
        segmentId: input.segmentId,
        segmentSequence: (input.events.at(-1)?.sequence ?? 0) + 1,
        sampleIndex: input.sampleIndex,
        throughHistorySequence: historyItems.at(-1)!.sequence,
      },
    });
    const modelState: ThreadModelState = {
      schemaVersion: "crewon.thread-model-state.v0",
      tenantId: state.tenantId,
      threadId: state.threadId,
      ...input.identity,
      contextWindowTokens: input.modelPolicy.contextWindowTokens,
      autoCompactAtTokens: input.modelPolicy.autoCompactAtTokens,
      throughHistorySequence: historyItems.at(-1)!.sequence,
      contextRevision: input.contextRevision,
      latestUsage: input.latestUsage,
      updatedAt: occurredAt,
    };
    const continuation: ThreadContinuationCheckpoint | null =
      checkpoint === null
        ? null
        : {
            tenantId: state.tenantId,
            threadId: state.threadId,
            ...input.identity,
            throughHistorySequence: historyItems.at(-1)!.sequence,
            contextRevision: input.contextRevision,
            checkpoint,
            updatedAt: occurredAt,
          };
    try {
      return await this.#store.commitAssistantSampleContinuation({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          expectedRevision: state.revision,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            `assistant-sample-continuation:${input.sampleIndex}`,
            {
              sampleIndex: input.sampleIndex,
              output: input.output,
              completedAssistantItems: input.completedAssistantItems,
              events: input.events,
              identity: input.identity,
              contextRevision: input.contextRevision,
              modelPolicy: input.modelPolicy,
              latestUsage: input.latestUsage,
              attempt,
            },
          ),
          events,
          outbox: events.map((event) => this.#outbox(state.tenantId, event)),
          workItems: [],
        },
        history: {
          expectedLastSequence: head.lastSequence,
          items: historyItems,
        },
        modelState,
        continuation,
        attempt: {
          ...attempt,
          finishedAt: occurredAt,
          providerTurnState: input.providerTurnState ?? null,
          checkpointDigest:
            checkpoint === null
              ? null
              : this.#digest(canonicalJson(checkpoint)),
        },
        sampleIndex: input.sampleIndex,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async executeGoalTool(
    claim: WorkItemClaim,
    requested: CanonicalAgentEvent &
      Readonly<{
        type: "tool.requested";
        data: Readonly<{
          callId: string;
          kind: "function" | "custom";
          name: string;
          input: string;
        }>;
      }>,
  ): Promise<GoalToolExecutionResult> {
    parseCanonicalAgentEvent(requested);
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    if (
      requested.runId !== state.runId ||
      requested.data.kind !== "function" ||
      (requested.data.name !== "get_goal" &&
        requested.data.name !== "create_goal" &&
        requested.data.name !== "update_goal")
    ) {
      throw new ApplicationError("validation", "goal_tool_request_invalid");
    }
    const request = {
      segmentId: requested.segmentId,
      callId: requested.data.callId,
      kind: "function" as const,
      name: requested.data.name as GoalToolName,
      input: requested.data.input,
    };
    try {
      return await this.#store.executeGoalTool({
        tenantId: state.tenantId,
        threadId: state.threadId,
        runId: state.runId,
        lease: leaseInput(claim),
        idempotency: {
          scope: canonicalJson({
            schemaVersion: "crewon.idempotency-scope.v0",
            namespace: "goal-tool",
            tenantId: state.tenantId,
            runId: state.runId,
          }),
          key: this.#digest(
            canonicalJson({
              segmentId: request.segmentId,
              callId: request.callId,
            }),
          ),
          requestFingerprint: canonicalJson({
            schemaVersion: "crewon.goal-tool-fingerprint.v0",
            runId: state.runId,
            request,
          }),
        },
        request,
        proposedGoalId:
          request.name === "create_goal" ? this.#nextId("goal") : null,
        accountingEventId: this.#nextId("runEvent"),
        accountingOutboxMessageId: this.#nextId("outboxMessage"),
        occurredAt: this.#now(),
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async completeTextRun(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    output: string,
    continuation: Readonly<{
      identity: Omit<ThreadContinuationLocator, "tenantId" | "threadId">;
      contextRevision: string;
      checkpoint: import("@crewon/contracts").ProviderCheckpoint | null;
      providerTurnState: string | null;
      segment: Readonly<{
        segmentId: string;
        checkpointSequence: number | null;
        completedSequence: number;
      }>;
      modelPolicy: Readonly<{
        contextWindowTokens: number;
        autoCompactAtTokens: number | null;
      }>;
      latestUsage: Readonly<{
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }> | null;
      proposedPlan: string | null;
    }>,
  ): Promise<CommitTextRunCompletionResult> {
    requireBoundedContent(output);
    validateModelIdentity(continuation.identity);
    requireNonEmpty(continuation.contextRevision, "context_revision_invalid");
    let checkpointDigest: string | null = null;
    if (continuation.checkpoint !== null) {
      const checkpoint = parseProviderCheckpoint(continuation.checkpoint);
      if (
        checkpoint.adapterName !== continuation.identity.adapterName ||
        checkpoint.adapterVersion !== continuation.identity.adapterVersion ||
        checkpoint.modelId !== continuation.identity.modelId
      ) {
        throw new ApplicationError(
          "validation",
          "provider_checkpoint_identity_mismatch",
        );
      }
      checkpointDigest = this.#digest(canonicalJson(checkpoint));
    }
    requireNonEmpty(continuation.segment.segmentId, "segment_id_invalid");
    const contextWindowTokens = requirePositiveInteger(
      continuation.modelPolicy.contextWindowTokens,
      "model_context_window_invalid",
    );
    const autoCompactAtTokens =
      continuation.modelPolicy.autoCompactAtTokens === null
        ? null
        : requirePositiveInteger(
            continuation.modelPolicy.autoCompactAtTokens,
            "model_auto_compact_limit_invalid",
          );
    if (
      autoCompactAtTokens !== null &&
      autoCompactAtTokens >= contextWindowTokens
    ) {
      throw new ApplicationError(
        "validation",
        "model_auto_compact_limit_invalid",
      );
    }
    if (continuation.latestUsage !== null) {
      const { inputTokens, outputTokens, totalTokens } =
        continuation.latestUsage;
      requireNonNegativeInteger(inputTokens, "model_usage_invalid");
      requireNonNegativeInteger(outputTokens, "model_usage_invalid");
      requireNonNegativeInteger(totalTokens, "model_usage_invalid");
      if (totalTokens !== inputTokens + outputTokens) {
        throw new ApplicationError("validation", "model_usage_invalid");
      }
    }
    requirePositiveInteger(
      continuation.segment.completedSequence,
      "segment_sequence_invalid",
    );
    if (
      (continuation.checkpoint === null) !==
      (continuation.segment.checkpointSequence === null)
    ) {
      throw new ApplicationError(
        "validation",
        "provider_checkpoint_sequence_mismatch",
      );
    }
    if (continuation.segment.checkpointSequence !== null) {
      requirePositiveInteger(
        continuation.segment.checkpointSequence,
        "checkpoint_sequence_invalid",
      );
      if (
        continuation.segment.checkpointSequence >=
        continuation.segment.completedSequence
      ) {
        throw new ApplicationError("validation", "checkpoint_sequence_invalid");
      }
    }
    const run = await this.loadRun(claim);
    if (run.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (run.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    const thread = await this.#store.loadThread({
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    if (thread === null || thread.spaceId !== run.spaceId) {
      throw new ApplicationError("notFound", "thread_not_found");
    }
    if (thread.status !== "active") {
      throw new ApplicationError("conflict", "thread_not_active");
    }

    const occurredAt = this.#now();
    const historyHead = await this.#modelHistoryHead(run);
    const messageId = this.#nextId("message");
    const contentDigest = this.#digest(output);
    if (
      (run.collaborationMode === "plan") !==
        (continuation.proposedPlan !== null) ||
      (continuation.proposedPlan !== null &&
        continuation.proposedPlan !== output)
    ) {
      throw new ApplicationError("validation", "proposed_plan_mode_invalid");
    }
    const proposedPlan: ProposedPlan | null =
      continuation.proposedPlan === null
        ? null
        : {
            schemaVersion: "crewon.proposed-plan.v0",
            planId: this.#nextId("proposedPlan"),
            tenantId: run.tenantId,
            threadId: run.threadId,
            runId: run.runId,
            messageId,
            content: continuation.proposedPlan,
            contentDigest,
            createdAt: occurredAt,
          };
    if (proposedPlan !== null) {
      try {
        validateProposedPlan(proposedPlan);
      } catch (error) {
        throw new ApplicationError("validation", "proposed_plan_invalid", {
          cause: error,
        });
      }
    }
    const message: MessageRecord = {
      messageId,
      tenantId: run.tenantId,
      threadId: run.threadId,
      sequence: thread.lastMessageSequence + 1,
      role: "assistant",
      content: output,
      contentDigest,
      createdAt: occurredAt,
      origin: null,
      proposedPlan,
    };
    const historyItem: ModelHistoryItem = {
      schemaVersion: "crewon.model-history-item.v0",
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: run.tenantId,
      threadId: run.threadId,
      sequence: historyHead.lastSequence + 1,
      runId: run.runId,
      segmentId: continuation.segment.segmentId,
      createdAt: occurredAt,
      type: "message",
      role: "assistant",
      source: "assistant_completion",
      content: output,
      contentDigest,
    };
    const threadEvent: ThreadLifecycleEvent = {
      schemaVersion: "crewon.thread-event.v0",
      identity: { threadId: run.threadId },
      eventId: this.#nextId("threadEvent"),
      sequence: thread.lastEventSequence + 1,
      occurredAt,
      type: "thread.message.appended",
      data: {
        messageId,
        messageSequence: message.sequence,
        role: "assistant",
        contentDigest,
      },
    };
    const segmentEvents: RunLifecycleEvent[] = [];
    if (
      continuation.checkpoint !== null &&
      continuation.segment.checkpointSequence !== null
    ) {
      segmentEvents.push({
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: run.runId },
        eventId: this.#nextId("runEvent"),
        sequence: run.lastSequence + 1,
        occurredAt,
        type: "segment.checkpointed",
        data: {
          segmentId: continuation.segment.segmentId,
          segmentSequence: continuation.segment.checkpointSequence,
          checkpointDigest: this.#digest(
            canonicalJson(continuation.checkpoint),
          ),
        },
      });
    }
    segmentEvents.push({
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: run.lastSequence + segmentEvents.length + 1,
      occurredAt,
      type: "segment.completed",
      data: {
        segmentId: continuation.segment.segmentId,
        segmentSequence: continuation.segment.completedSequence,
      },
    });
    const messageEvent: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: run.lastSequence + segmentEvents.length + 1,
      occurredAt,
      type: "message.completed",
      data: {
        messageId,
        messageSequence: message.sequence,
        role: "assistant",
        contentDigest,
      },
    };
    const proposedPlanEvent: RunLifecycleEvent | null =
      proposedPlan === null
        ? null
        : {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: run.runId },
            eventId: this.#nextId("runEvent"),
            sequence: messageEvent.sequence + 1,
            occurredAt,
            type: "plan.proposed",
            data: {
              planId: proposedPlan.planId,
              messageId,
              messageSequence: message.sequence,
              contentDigest,
            },
          };
    const completionAuthoritySequence =
      proposedPlanEvent?.sequence ?? messageEvent.sequence;
    const accountingEvent = this.#terminalGoalAccountingEvent(
      run,
      occurredAt,
      completionAuthoritySequence,
      completionAuthoritySequence + 1,
    );
    const completedEvent: RunLifecycleEvent = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence:
        completionAuthoritySequence + (accountingEvent === null ? 1 : 2),
      occurredAt,
      type: "run.completed",
      data: { outputRef: `message:${messageId}` },
    };
    const runEvents = [
      ...segmentEvents,
      messageEvent,
      ...(proposedPlanEvent === null ? [] : [proposedPlanEvent]),
      ...(accountingEvent === null ? [] : [accountingEvent]),
      completedEvent,
    ];
    const outbox = runEvents.map((event) => this.#outbox(run.tenantId, event));
    const goalSettlement = await this.#goalMutationForTerminal(
      run,
      { kind: "completed" },
      occurredAt,
    );
    const goalContinuation = this.#goalContinuationFor(
      run,
      goalSettlement.state,
      occurredAt,
      historyItem.sequence + 1,
    );

    try {
      return await this.#store.commitTextRunCompletion({
        tenantId: run.tenantId,
        lease: leaseInput(claim),
        idempotency: executionIdempotency(run, claim.workItem, "complete", {
          output,
          proposedPlan: continuation.proposedPlan,
          modelIdentity: continuation.identity,
          contextRevision: continuation.contextRevision,
          checkpointDigest: checkpointDigest,
          segment: continuation.segment,
          attempt,
        }),
        run: {
          expectedRevision: run.revision,
          events: runEvents,
          outbox,
        },
        goal: goalSettlement.mutation,
        goalContinuation,
        thread: {
          expectedRevision: thread.revision,
          events: [threadEvent],
          messages: [message],
        },
        history: {
          expectedLastSequence: historyHead.lastSequence,
          items: [historyItem],
        },
        continuation: {
          ...continuation.identity,
          contextRevision: continuation.contextRevision,
          checkpoint: continuation.checkpoint,
        },
        modelState: {
          schemaVersion: "crewon.thread-model-state.v0",
          tenantId: run.tenantId,
          threadId: run.threadId,
          ...continuation.identity,
          contextWindowTokens,
          autoCompactAtTokens,
          throughHistorySequence: historyItem.sequence,
          contextRevision: continuation.contextRevision,
          latestUsage: continuation.latestUsage,
          updatedAt: occurredAt,
        },
        attempt: {
          ...attempt,
          finishedAt: occurredAt,
          checkpointDigest,
          providerTurnState: continuation.providerTurnState,
        },
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async confirmCanceled(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity | null,
    reasonCode = "user_requested",
  ): Promise<CommitRunResult> {
    const state = await this.loadRun(claim);
    if (!state.cancelRequested) {
      throw new ApplicationError("conflict", "cancel_not_requested");
    }
    if (state.status === "canceled") {
      throw new ApplicationError("conflict", "run_already_canceled");
    }
    const occurredAt = this.#now();
    const history = await this.#cancellationHistory(state, attempt, occurredAt);
    return this.#commitLeasedTerminalEvent(
      claim,
      state,
      "cancel",
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: state.runId },
        eventId: this.#nextId("runEvent"),
        sequence: state.lastSequence + 1,
        occurredAt,
        type: "run.canceled",
        data: {
          reasonCode: requireNonEmpty(reasonCode, "reason_code_invalid"),
        },
      },
      { kind: "run.cancel", reasonCode },
      attempt === null
        ? null
        : {
            ...attempt,
            status: "canceled",
            finishedAt: occurredAt,
            checkpointDigest: null,
          },
      history,
    );
  }

  async failRun(
    claim: WorkItemClaim,
    failure: { code: string; retryable: boolean },
    attempt: RunAttemptIdentity | null,
  ): Promise<CommitRunResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    const code = requireNonEmpty(failure.code, "failure_code_invalid");
    const occurredAt = this.#now();
    return this.#commitLeasedTerminalEvent(
      claim,
      state,
      `fail:${code}`,
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: state.runId },
        eventId: this.#nextId("runEvent"),
        sequence: state.lastSequence + 1,
        occurredAt,
        type: "run.failed",
        data: { code, retryable: failure.retryable },
      },
      { kind: "run.fail", code, retryable: failure.retryable },
      attempt === null
        ? null
        : {
            ...attempt,
            status: "failed",
            finishedAt: occurredAt,
            checkpointDigest: null,
            failure: { code, retryable: failure.retryable },
          },
      null,
    );
  }

  async retryAttempt(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    failure: Readonly<{
      code: string;
      retryAfterMs: number;
      checkpoint: import("@crewon/contracts").ProviderCheckpoint | null;
    }>,
  ): Promise<RunAttemptTransitionResult> {
    const state = await this.loadRun(claim);
    if (state.cancelRequested) {
      throw new ApplicationError("conflict", "execution_cancel_pending");
    }
    if (state.status !== "running") {
      throw new ApplicationError("conflict", "run_not_running");
    }
    const code = requireNonEmpty(failure.code, "failure_code_invalid");
    const retryAfterMs = requireNonNegativeInteger(
      failure.retryAfterMs,
      "retry_after_ms_invalid",
    );
    const checkpointDigest =
      failure.checkpoint === null
        ? null
        : this.#digest(
            canonicalJson(parseProviderCheckpoint(failure.checkpoint)),
          );
    try {
      return await this.#store.retryRunAttempt({
        tenantId: state.tenantId,
        lease: leaseInput(claim),
        runId: state.runId,
        attempt: {
          ...attempt,
          finishedAt: this.#now(),
          checkpointDigest,
          failure: { code, retryable: true },
        },
        retryAfterMs,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async #historyForAgentEvent(
    state: RunState,
    event: RunLifecycleEvent,
    occurredAt: string,
    canonicalEvent?: CanonicalAgentEvent,
  ): Promise<ModelHistoryAppend | null> {
    if (event.type !== "tool.requested" && event.type !== "tool.completed") {
      return null;
    }
    const head = await this.#modelHistoryHead(state);
    const base = {
      schemaVersion: "crewon.model-history-item.v0" as const,
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: state.tenantId,
      threadId: state.threadId,
      sequence: head.lastSequence + 1,
      runId: state.runId,
      segmentId: event.data.segmentId,
      createdAt: occurredAt,
    };
    const item: ModelHistoryItem =
      event.type === "tool.requested"
        ? {
            ...base,
            type: "tool_call",
            kind: event.data.kind,
            callId: event.data.callId,
            name: event.data.name,
            input: event.data.input,
          }
        : {
            ...base,
            type: "tool_result",
            kind: event.data.kind,
            callId: event.data.callId,
            output: event.data.output,
            isError: event.data.isError,
            status: "completed",
          };
    const completedAssistantItems =
      canonicalEvent?.type === "tool.requested" &&
      Array.isArray(canonicalEvent.data.completedAssistantItems)
        ? canonicalEvent.data.completedAssistantItems
        : [];
    const items: ModelHistoryItem[] = completedAssistantItems.map(
      (content, index) => {
        if (typeof content !== "string") {
          throw new ApplicationError(
            "validation",
            "model_completed_assistant_item_invalid",
          );
        }
        requireBoundedContent(content);
        return {
          ...base,
          itemId: this.#nextId("modelHistoryItem"),
          sequence: head.lastSequence + index + 1,
          type: "message",
          role: "assistant",
          source: "assistant_completion",
          content,
          contentDigest: this.#digest(content),
        };
      },
    );
    items.push({ ...item, sequence: head.lastSequence + items.length + 1 });
    return { expectedLastSequence: head.lastSequence, items };
  }

  async #cancellationHistory(
    state: RunState,
    attempt: RunAttemptIdentity | null,
    occurredAt: string,
  ): Promise<ModelHistoryAppend> {
    const head = await this.#modelHistoryHead(state);
    const pending = new Map<
      string,
      Extract<RunLifecycleEvent, { type: "tool.requested" }>
    >();
    let cursor = 0;
    while (cursor < state.lastSequence) {
      let page: readonly RunLifecycleEvent[];
      try {
        page = await this.#store.listRunEvents(
          { tenantId: state.tenantId, runId: state.runId },
          cursor,
          Math.min(100, state.lastSequence - cursor),
        );
      } catch (error) {
        throw mapExecutionError(error);
      }
      if (page.length === 0) {
        throw new ApplicationError("internal", "run_event_history_incomplete");
      }
      for (const event of page) {
        cursor = event.sequence;
        if (event.type === "tool.requested") {
          if (pending.has(event.data.callId)) {
            throw new ApplicationError(
              "internal",
              "model_history_tool_call_duplicate",
            );
          }
          pending.set(event.data.callId, event);
        } else if (event.type === "tool.completed") {
          pending.delete(event.data.callId);
        }
      }
    }

    const items: ModelHistoryItem[] = [];
    let sequence = head.lastSequence;
    for (const requested of pending.values()) {
      sequence += 1;
      items.push({
        schemaVersion: "crewon.model-history-item.v0",
        itemId: this.#nextId("modelHistoryItem"),
        tenantId: state.tenantId,
        threadId: state.threadId,
        sequence,
        runId: state.runId,
        segmentId: requested.data.segmentId,
        createdAt: occurredAt,
        type: "tool_result",
        kind: requested.data.kind,
        callId: requested.data.callId,
        output: abortedToolOutput(requested, occurredAt),
        isError: true,
        status: "aborted",
      });
    }

    const markerSegmentId =
      attempt === null
        ? (pending.values().next().value?.data.segmentId ?? null)
        : `segment:${attempt.attemptId}`;
    sequence += 1;
    items.push({
      schemaVersion: "crewon.model-history-item.v0",
      itemId: this.#nextId("modelHistoryItem"),
      tenantId: state.tenantId,
      threadId: state.threadId,
      sequence,
      runId: state.runId,
      segmentId: markerSegmentId,
      createdAt: occurredAt,
      type: "message",
      role: "user",
      source: "turn_aborted",
      content: TURN_ABORTED_HISTORY_MARKER,
      contentDigest: this.#digest(TURN_ABORTED_HISTORY_MARKER),
    });
    return { expectedLastSequence: head.lastSequence, items };
  }

  async #modelHistoryHead(
    state: RunState,
  ): Promise<import("@crewon/domain").ModelHistoryHead> {
    try {
      const head = await this.#store.loadModelHistoryHead({
        tenantId: state.tenantId,
        threadId: state.threadId,
      });
      if (head === null) {
        throw new ApplicationError("notFound", "model_history_not_found");
      }
      return head;
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw mapExecutionError(error);
    }
  }

  async #loadModelHistory(
    state: RunState,
    throughSequence: number,
  ): Promise<readonly ModelHistoryItem[]> {
    const items: ModelHistoryItem[] = [];
    let cursor = 0;
    try {
      while (cursor < throughSequence) {
        const page = await this.#store.listModelHistoryItems(
          { tenantId: state.tenantId, threadId: state.threadId },
          cursor,
          Math.min(100, throughSequence - cursor),
        );
        if (page.length === 0) {
          throw new ApplicationError("internal", "model_history_incomplete");
        }
        items.push(...page);
        cursor = page.at(-1)!.sequence;
      }
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw mapExecutionError(error);
    }
    if (cursor !== throughSequence) {
      throw new ApplicationError("internal", "model_history_incomplete");
    }
    return items;
  }

  async #commitLeasedEvent(
    claim: WorkItemClaim,
    state: RunState,
    phase: string,
    event: RunLifecycleEvent,
    semanticCommand: Readonly<Record<string, unknown>>,
    history: ModelHistoryAppend | null = null,
  ): Promise<CommitRunResult> {
    try {
      return await this.#store.commitLeasedRun({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            phase,
            semanticCommand,
          ),
          expectedRevision: state.revision,
          events: [event],
          outbox: [this.#outbox(state.tenantId, event)],
          workItems: [],
        },
        history,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async #commitLeasedTerminalEvent(
    claim: WorkItemClaim,
    state: RunState,
    phase: string,
    event: RunLifecycleEvent,
    semanticCommand: Readonly<Record<string, unknown>>,
    attempt: RunAttemptRunTerminalMutation | null,
    history: ModelHistoryAppend | null,
  ): Promise<CommitRunResult> {
    try {
      const accountingEvent = this.#terminalGoalAccountingEvent(
        state,
        event.occurredAt,
        state.lastSequence,
        state.lastSequence + 1,
      );
      const terminalEvent = {
        ...event,
        sequence: state.lastSequence + (accountingEvent === null ? 1 : 2),
      } as typeof event;
      const events = [
        ...(accountingEvent === null ? [] : [accountingEvent]),
        terminalEvent,
      ];
      const goal = await this.#goalMutationForTerminal(
        state,
        terminalEvent.type === "run.failed"
          ? { kind: "failed", code: terminalEvent.data.code }
          : { kind: "canceled" },
        terminalEvent.occurredAt,
      );
      const result = await this.#store.commitLeasedRunTerminal({
        lease: leaseInput(claim),
        commit: {
          tenantId: state.tenantId,
          idempotency: executionIdempotency(
            state,
            claim.workItem,
            phase,
            semanticCommand,
          ),
          expectedRevision: state.revision,
          events,
          outbox: events.map((item) => this.#outbox(state.tenantId, item)),
          workItems: [],
        },
        goal: goal.mutation,
        attempt,
        history,
      });
      return result.run;
    } catch (error) {
      throw mapExecutionError(error);
    }
  }

  async #goalMutationForTerminal(
    run: RunState,
    outcome: GoalRunTerminalOutcome,
    occurredAt: string,
  ): Promise<
    Readonly<{
      mutation: TurnStartGoalMutation;
      state: ThreadGoal | null;
    }>
  > {
    let current;
    try {
      current = await this.#store.loadThreadGoal({
        tenantId: run.tenantId,
        threadId: run.threadId,
      });
    } catch (error) {
      throw mapExecutionError(error);
    }
    const next =
      run.goalAccounting === null
        ? settleThreadGoalForRun(current, run, outcome, occurredAt)
        : settleThreadGoalFromAccounting(current, run, outcome, occurredAt);
    return {
      mutation:
        next === current
          ? { kind: "keep", expectedRevision: current?.revision ?? null }
          : {
              kind: "set",
              expectedRevision: current?.revision ?? null,
              goal: next!,
            },
      state: next,
    };
  }

  #terminalGoalAccountingEvent(
    run: RunState,
    occurredAt: string,
    throughRunSequence: number,
    eventSequence: number,
  ): Extract<
    RunLifecycleEvent,
    { type: "run.goal.accounting.updated" }
  > | null {
    if (run.goalAccounting?.attribution === null) return null;
    if (run.goalAccounting === null) return null;
    let next;
    try {
      next = advanceRunGoalAccounting(run.goalAccounting, {
        currentUsage: run.usage,
        throughRunSequence,
        occurredAt,
        nextBinding: null,
        pendingSteering: null,
        trackTime: false,
      }).next;
    } catch (error) {
      throw mapExecutionError(error);
    }
    return {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId: run.runId },
      eventId: this.#nextId("runEvent"),
      sequence: eventSequence,
      occurredAt,
      type: "run.goal.accounting.updated",
      data: { next },
    };
  }

  #goalContinuationFor(
    previousRun: RunState,
    goal: ThreadGoal | null,
    occurredAt: string,
    historySequence: number,
  ): CommitTextRunCompletionInput["goalContinuation"] {
    if (goal?.status !== "active") return null;
    const runId = this.#nextId("run");
    const event: Extract<RunLifecycleEvent, { type: "run.created" }> = {
      schemaVersion: "crewon.run-event.v0",
      identity: { runId },
      eventId: this.#nextId("runEvent"),
      sequence: 1,
      occurredAt,
      type: "run.created",
      data: {
        threadId: previousRun.threadId,
        tenantId: previousRun.tenantId,
        spaceId: previousRun.spaceId,
        createdByActorId: previousRun.createdByActorId,
        authorityId: previousRun.authorityId,
        runtimeGeneration: previousRun.runtimeGeneration,
        agentVersionId: previousRun.agentVersionId,
        policySnapshotId: previousRun.policySnapshotId,
        workspaceBindingId: previousRun.workspaceBindingId,
        collaborationMode: "default",
        goalBinding: {
          goalId: goal.goalId,
          revision: goal.revision,
          objectiveDigest: this.#digest(goal.objective),
        },
      },
    };
    const prompt = threadGoalContinuationPrompt(goal);
    return {
      historyItem: {
        schemaVersion: "crewon.model-history-item.v0",
        itemId: this.#nextId("modelHistoryItem"),
        tenantId: previousRun.tenantId,
        threadId: previousRun.threadId,
        sequence: historySequence,
        runId,
        segmentId: null,
        createdAt: occurredAt,
        type: "message",
        role: "user",
        source: "goal_continuation",
        content: prompt,
        contentDigest: this.#digest(prompt),
      },
      events: [event],
      outbox: [this.#outbox(previousRun.tenantId, event)],
      workItems: [
        {
          workItemId: this.#nextId("workItem"),
          tenantId: previousRun.tenantId,
          runId,
          kind: "run.execute",
          payload: {
            throughSequence: 1,
            trigger: "goalContinuation",
            previousRunId: previousRun.runId,
            goalId: goal.goalId,
            goalRevision: goal.revision,
          },
          createdAt: occurredAt,
        },
      ],
    };
  }

  #outbox(tenantId: string, event: RunLifecycleEvent): OutboxMessage {
    return {
      messageId: this.#nextId("outboxMessage"),
      tenantId,
      runId: event.identity.runId,
      topic: "run.updated",
      payload: {
        eventId: event.eventId,
        eventType: event.type,
        throughSequence: event.sequence,
      },
      createdAt: event.occurredAt,
    };
  }

  #nextId(kind: ApplicationIdKind): string {
    return requireNonEmpty(this.#ids.nextId(kind), `${kind}_id_invalid`);
  }

  #now(): string {
    const timestamp = this.#clock.now();
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp) ||
      Number.isNaN(Date.parse(timestamp))
    ) {
      throw new ApplicationError("internal", "clock_timestamp_invalid");
    }
    return timestamp;
  }

  #digest(content: string): string {
    const digest = this.#digester.sha256(content);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new ApplicationError("internal", "content_digest_invalid");
    }
    return digest;
  }
}

function retainedCompactionUserMessages(
  history: readonly ModelHistoryItem[],
  limit: number,
): readonly string[] {
  let candidates: string[] = [];
  for (const item of history) {
    if (item.type === "compaction") {
      candidates = item.retainedUserMessages.map(({ content }) => content);
    } else if (
      item.type === "message" &&
      item.role === "user" &&
      item.source === "thread_message"
    ) {
      candidates.push(item.content);
    }
  }
  const selected: string[] = [];
  let remainingBytes = 32 * 1024;
  for (const content of [...candidates].reverse()) {
    if (selected.length >= limit) {
      break;
    }
    const bytes = new TextEncoder().encode(content).byteLength;
    if (bytes > remainingBytes) {
      break;
    }
    selected.push(content);
    remainingBytes -= bytes;
  }
  return selected.reverse();
}

function validateToolExecutionCall(call: ToolExecutionCall): void {
  requireNonEmpty(call.segmentId, "tool_segment_id_invalid");
  requireNonEmpty(call.callId, "tool_call_id_invalid");
  requireNonEmpty(call.name, "tool_name_invalid");
  if (call.kind !== "function" && call.kind !== "custom") {
    throw new ApplicationError("validation", "tool_kind_invalid");
  }
  if (
    typeof call.input !== "string" ||
    new TextEncoder().encode(call.input).byteLength > 64 * 1024
  ) {
    throw new ApplicationError("validation", "tool_input_invalid");
  }
}

function approvalExpiresAt(
  requiredAt: string,
  value: number | null,
): string | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
    throw new ApplicationError("validation", "approval_expiry_invalid");
  }
  if (value === null) {
    return null;
  }
  const expiresAt = new Date(Date.parse(requiredAt) + value);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ApplicationError("validation", "approval_expiry_invalid");
  }
  return expiresAt.toISOString();
}

function validateApprovalBinding(
  approval: ToolApprovalState,
  receipt: ToolExecutionReceiptState,
): void {
  if (
    approval.tenantId !== receipt.tenantId ||
    approval.runId !== receipt.runId ||
    approval.receiptId !== receipt.receiptId ||
    approval.workItemId !== receipt.workItemId ||
    approval.actionDigest !== receipt.actionDigest ||
    receipt.actionIntent === null ||
    approval.policySnapshotId !== receipt.actionIntent.policySnapshotId
  ) {
    throw new ApplicationError("conflict", "tool_approval_binding_mismatch");
  }
}
