import {
  reduceRunLifecycleEvent,
  reduceThreadLifecycleEvent,
  type ModelHistoryItem,
  type RunLifecycleEvent,
  type RunState,
  type ThreadLifecycleEvent,
  type ThreadGoal,
  type ThreadGoalEvent,
  type ThreadState,
  ToolApprovalError,
  ThreadGoalError,
  decideToolApproval,
  terminateToolApproval,
  validateToolApprovalState,
  type ToolApprovalState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";

import {
  RunStoreError,
  type ActivateAgentVersionReleaseResult,
  type ActiveAgentVersionRelease,
  type AgentVersionAsset,
  type AgentVersionDeployment,
  type AgentVersionReleaseBundle,
  type AutomationCreateReceiptQuery,
  type AutomationCreateResult,
  type AutomationDefinitionRecord,
  type AutomationInvocationContext,
  type AutomationInvocationReceiptQuery,
  type AutomationInvocationResult,
  type AutomationListQuery,
  type AutomationLocator,
  type CommitAutomationCreateInput,
  type CommitAutomationInvocationInput,
  type RegisterAgentVersionResult,
  type BeginRunAttemptInput,
  type BeginRunAttemptResult,
  type CommitLeasedRunTerminalInput,
  type CommitContextCompactionInput,
  type CommitAssistantSampleContinuationInput,
  type CommitAssistantSampleContinuationResult,
  type CommitContextCompactionResult,
  type CommitToolExecutionCompletionInput,
  type CommitToolExecutionCompletionResult,
  type CommitToolExecutionUnknownOutcomeInput,
  type CommitToolExecutionUnknownOutcomeResult,
  type CompleteRunAttemptInput,
  type CommitLeasedRunTerminalResult,
  type CommitRunInput,
  type CommitRunResult,
  type CommitLeasedRunInput,
  type CommitTextRunCompletionInput,
  type CommitTextRunCompletionResult,
  type CommitThreadInput,
  type CommitThreadResult,
  type CommitThreadRollbackInput,
  type CommitThreadRollbackResult,
  type CommitThreadGoalMutationInput,
  type CommitThreadGoalMutationResult,
  type CommitTurnStartInput,
  type CommitTurnStartResult,
  type AbortModelProviderSettingsInput,
  type AbortModelProviderSettingsResult,
  type FinalizeModelProviderSettingsInput,
  type FinalizeModelProviderSettingsResult,
  type ExpireModelProviderSettingsInput,
  type ExpireModelProviderSettingsResult,
  type PrepareModelProviderSettingsInput,
  type PrepareModelProviderSettingsResult,
  type DomainStore,
  type MessageRecord,
  type MessageInvalidation,
  type MessageView,
  type InvalidatedMessage,
  type ModelProviderSettingsCatalog,
  type ModelProviderSettingsState,
  OfficeDelegationStoreError,
  type CommitOfficeDelegationStartInput,
  type OfficeDelegationListCursor,
  type PendingModelProviderSettings,
  type ModelHistoryAppend,
  type OutboxClaim,
  type OutboxLeaseInput,
  type OutboxMessage,
  type OutboxRetryInput,
  type QueueClaimInput,
  type QueueLease,
  type RunLocator,
  type RunReceiptQuery,
  type ThreadRunListQuery,
  type RunAttemptLocator,
  type RunStepLocator,
  type RetryRunAttemptInput,
  type RunAttemptTransitionResult,
  type RunStore,
  type ThreadLocator,
  type ThreadSpaceLocator,
  type ThreadRollbackReceiptQuery,
  type ThreadGoalSnapshot,
  type ThreadListQuery,
  type ThreadContinuationCheckpoint,
  type ThreadContinuationLocator,
  type ThreadModelState,
  type WorkItem,
  type WorkItemClaim,
  type WorkItemLeaseInput,
  type WorkItemRenewInput,
  type WorkItemRetryInput,
  type PrepareToolExecutionInput,
  type DecideToolApprovalInput,
  type ExpireToolApprovalInput,
  type RequireToolApprovalInput,
  type ReplaceToolApprovalInput,
  type SupersedeToolApprovalInput,
  type ToolApprovalActionLocator,
  type ToolApprovalCommitResult,
  type ToolApprovalLocator,
  type ToolApprovalRunLocator,
  type ToolExecutionActionLocator,
  type ToolExecutionReceiptLocator,
  validateToolApprovalReplacement,
  validateToolApprovalReplacementCommit,
  validateToolApprovalReplacementReplay,
  type TransitionToolExecutionInput,
  type TurnStartReceiptQuery,
  type TurnStartGoalMutation,
  evaluateGoalToolCall,
  type GoalToolExecutionInput,
  type GoalToolExecutionResult,
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type CommitWorkspaceOperationResolutionInput,
  type PrepareWorkspaceOperationInput,
  type PrepareWorkspaceOperationActionInput,
  type WorkspaceDeliveryAttempt,
  type WorkspaceDeliveryAttemptQuery,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationMutationResult,
  type WorkspaceOperationEvent,
  type WorkspaceOperationEventQuery,
  type WorkspaceOperationLocator,
  type WorkspaceOperationListPage,
  type WorkspaceOperationListQuery,
  type WorkspaceOperationPreparationResult,
  type WorkspaceOperationReceiptQuery,
  type WorkspaceOperationRecord,
  type WorkspaceOperationSnapshot,
} from "@crewon/application";
import { InMemoryOfficeStore } from "./in-memory-office-store.ts";
import { InMemoryAutomationAuthority } from "./in-memory-automation-authority.ts";
import type {
  StoredAutomationCreateReceipt,
  StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import {
  sameAgentVersionAsset,
  sameAgentVersionDeploymentCandidate,
  sameAgentVersionReleaseActivation,
  sameAgentVersionReleaseBundle,
  validateAgentVersionAsset,
  validateAgentVersionReleaseActivation,
  validateAgentVersionReleaseActivationLocator,
  validateAgentVersionReleaseBundle,
  validateAgentVersionReleaseLocator,
  validateAgentVersionReleaseTenant,
  validateAgentVersionList,
  validateAgentVersionLocator,
} from "./agent-version-store-invariants.ts";
import { InMemoryWorkspaceOperationStore } from "./in-memory-workspace-operation-store.ts";
import {
  parseAbortModelProviderSettingsReceipt,
  parseFinalizeModelProviderSettingsReceipt,
  parseExpireModelProviderSettingsReceipt,
  parsePrepareModelProviderSettingsReceipt,
  modelProviderSettingsOperation,
  providerSettingsReceiptEnvelope,
  validateAbortedModelProviderSettingsOperation,
  validateAbortModelProviderSettingsInput,
  validateFinalizedModelProviderSettingsOperation,
  validateFinalizeModelProviderSettingsInput,
  validateExpireModelProviderSettingsInput,
  validatePrepareModelProviderSettingsInput,
  validateStoredTerminalModelProviderSettingsOperation,
  type StoredModelProviderSettingsOperation,
} from "./model-provider-settings-store-support.ts";
import {
  leaseExpiry,
  readLeaseClock,
  SystemLeaseClock,
  type LeaseClock,
} from "./lease-clock.ts";
import { InMemoryExecutionAuthority } from "./in-memory-execution-authority.ts";
import {
  claimNext,
  forceSettle,
  isWorkItem,
  pendingItems,
  queueRecord,
  requiredQueueRecord,
  retry,
  settle,
  validateRecordLease,
  type QueueRecord,
} from "./in-memory-queue.ts";
import {
  requireNonEmpty,
  stableJson,
  validateCommitInput,
  validateContextCompactionInput,
  validateAssistantSampleContinuationInput,
  validateContextCompactionReplay,
  validateContextCompactionRunAuthority,
  validateToolExecutionCompletionInput,
  validateToolExecutionCompletionReplay,
  applyToolCompletionGoalMutation,
  validateToolExecutionUnknownOutcomeInput,
  validateCompleteRunAttemptInput,
  validateBeginRunAttemptInput,
  validateEventPage,
  validateEvents,
  validateLimit,
  validateMessagePage,
  validateMessageView,
  validateModelHistoryAppend,
  validateModelHistoryPage,
  validateMessages,
  validateOutbox,
  validateQueueClaim,
  validateQueueLease,
  validateQueueRetry,
  validateRunLocator,
  validateRunReceiptQuery,
  validateManualCompactionAdmissionState,
  validateRunAttemptLocator,
  validateRunAttemptPage,
  validateRunStepLocator,
  validateLeasedRunTerminalInput,
  validateRetryRunAttemptInput,
  validateThreadCommitInput,
  validateThreadEvents,
  validateThreadReceiptResult,
  prepareThreadRollbackCommit,
  validateThreadRollbackReceiptQuery,
  validateThreadRollbackReceiptResult,
  validateThreadRollbackReceiptAuthority,
  validateTextRunPlanCorrelation,
  validateThreadLocator,
  validateThreadSpaceLocator,
  validateThreadListQuery,
  validateThreadRunListQuery,
  validateThreadContinuationLocator,
  validateThreadModelState,
  validateTextRunCompletionInput,
  validateTurnStartInput,
  validateTurnStartReceiptQuery,
  applyTurnStartGoalMutation,
  applyRunTerminalGoalMutation,
  reduceGoalContinuationRun,
  textCompletionHistoryAppend,
  validateTurnStartGoalBinding,
  applyToolExecutionTransition,
  applyToolExecutionUnknownOutcome,
  validatePrepareToolExecutionInput,
  validateToolExecutionActionLocator,
  validateToolExecutionReceiptLocator,
  validateTransitionToolExecutionInput,
  validateWorkItems,
  validateGoalToolExecutionInput,
  validateGoalToolRequestedEvent,
  prepareGoalToolAccounting,
  reduceThreadGoalContinuation,
  reduceThreadGoalQueuedRunCancellation,
  reduceThreadGoalRetainedRunUpdate,
  shouldCancelQueuedRunForGoal,
  validateThreadGoalActiveRunFence,
  validateThreadGoalMutationInput,
  validateRunHistoryCorrelation,
  validateRecordRunAttemptProviderTurnStateInput,
} from "./store-invariants.ts";
import {
  createThreadGoalEvent,
  validateStoredThreadGoalEventPage,
} from "./thread-goal-event-support.ts";
import { validateStoredThreadEventPage } from "./thread-event-support.ts";

type IdempotencyReceipt = Readonly<{
  tenantId: string;
  fingerprint: string;
  result: CommitRunResult;
}>;

type ThreadIdempotencyReceipt = Readonly<{
  tenantId: string;
  threadId: string;
  fingerprint: string;
  result: CommitThreadResult;
}>;

type ThreadRollbackIdempotencyReceipt = Readonly<{
  tenantId: string;
  threadId: string;
  fingerprint: string;
  result: CommitThreadRollbackResult;
}>;

type ExecutionIdempotencyReceipt = Readonly<{
  tenantId: string;
  fingerprint: string;
  result: CommitTextRunCompletionResult;
}>;

type TurnStartIdempotencyReceipt = Readonly<{
  tenantId: string;
  fingerprint: string;
  result: CommitTurnStartResult;
}>;

type GoalToolIdempotencyReceipt = Readonly<{
  tenantId: string;
  fingerprint: string;
  result: GoalToolExecutionResult;
}>;

type ThreadGoalMutationIdempotencyReceipt = Readonly<{
  tenantId: string;
  threadId: string;
  fingerprint: string;
  result: CommitThreadGoalMutationResult;
}>;

type ModelProviderSettingsReceipt = Readonly<{
  fingerprint: string;
  envelope: unknown;
}>;

type ModelProviderSettingsOperationRecord = Readonly<{
  authority: StoredModelProviderSettingsOperation;
  status: "pending" | "finalized" | "aborted" | "expired";
  resultEnvelope: unknown | null;
  terminalBinding: string | null;
  completedAt: string | null;
}>;

export class InMemoryRunStore implements DomainStore {
  readonly #agentVersions = new Map<string, AgentVersionAsset>();
  readonly #agentVersionDeployments = new Map<string, AgentVersionDeployment>();
  readonly #agentVersionReleaseBundles = new Map<
    string,
    AgentVersionReleaseBundle
  >();
  readonly #agentVersionReleaseActivations = new Map<
    string,
    ActiveAgentVersionRelease
  >();
  readonly #activeAgentVersionReleases = new Map<
    string,
    ActiveAgentVersionRelease
  >();
  readonly #runs = new Map<string, RunState>();
  readonly #automations = new Map<string, AutomationDefinitionRecord>();
  readonly #automationCreateReceipts = new Map<
    string,
    StoredAutomationCreateReceipt
  >();
  readonly #automationInvocationReceipts = new Map<
    string,
    StoredAutomationInvocationReceipt
  >();
  readonly #events = new Map<string, RunLifecycleEvent[]>();
  readonly #eventIds = new Set<string>();
  readonly #outbox = new Map<string, QueueRecord<OutboxMessage>>();
  readonly #workItems = new Map<string, QueueRecord<WorkItem>>();
  readonly #idempotency = new Map<string, IdempotencyReceipt>();
  readonly #threads = new Map<string, ThreadState>();
  readonly #workspaceOperations = new InMemoryWorkspaceOperationStore(
    (tenantId, threadId) => {
      const thread = this.#threads.get(threadId) ?? null;
      return thread?.tenantId === tenantId ? clone(thread) : null;
    },
    () => readLeaseClock(this.#clock),
  );
  readonly #threadGoals = new Map<string, ThreadGoal>();
  readonly #threadEvents = new Map<string, ThreadLifecycleEvent[]>();
  readonly #threadEventIds = new Set<string>();
  readonly #messages = new Map<string, MessageRecord[]>();
  readonly #messageInvalidations = new Map<
    string,
    Map<number, MessageInvalidation>
  >();
  readonly #messageIds = new Set<string>();
  readonly #modelHistory = new Map<string, ModelHistoryItem[]>();
  readonly #modelHistoryItemIds = new Set<string>();
  readonly #threadIdempotency = new Map<string, ThreadIdempotencyReceipt>();
  readonly #threadRollbackIdempotency = new Map<
    string,
    ThreadRollbackIdempotencyReceipt
  >();
  readonly #threadRollbackEffects = new Map<
    string,
    Readonly<{
      invalidatedContinuationCount: number;
      invalidatedModelState: boolean;
    }>
  >();
  readonly #turnStartIdempotency = new Map<
    string,
    TurnStartIdempotencyReceipt
  >();
  readonly #threadContinuations = new Map<
    string,
    ThreadContinuationCheckpoint
  >();
  readonly #threadModelStates = new Map<string, ThreadModelState>();
  readonly #executionIdempotency = new Map<
    string,
    ExecutionIdempotencyReceipt
  >();
  readonly #goalToolIdempotency = new Map<string, GoalToolIdempotencyReceipt>();
  readonly #threadGoalMutationIdempotency = new Map<
    string,
    ThreadGoalMutationIdempotencyReceipt
  >();
  readonly #threadGoalEvents = new Map<string, ThreadGoalEvent[]>();
  readonly #modelProviderSettings = new Map<
    string,
    ModelProviderSettingsCatalog
  >();
  readonly #pendingModelProviderSettings = new Map<
    string,
    PendingModelProviderSettings
  >();
  readonly #modelProviderSettingsReceipts = new Map<
    string,
    ModelProviderSettingsReceipt
  >();
  readonly #modelProviderSettingsOperations = new Map<
    string,
    ModelProviderSettingsOperationRecord
  >();
  readonly #latestFinalizedProviderSettingsOperation = new Map<
    string,
    string
  >();
  readonly #executionAuthority = new InMemoryExecutionAuthority();
  readonly #toolExecutionReceipts = new Map<
    string,
    ToolExecutionReceiptState
  >();
  readonly #toolExecutionActions = new Map<string, string>();
  readonly #toolExecutionIdempotency = new Map<string, string>();
  readonly #toolApprovals = new Map<string, ToolApprovalState>();
  readonly #toolApprovalActions = new Map<string, string>();
  readonly #clock: LeaseClock;
  readonly #automationAuthority: InMemoryAutomationAuthority;
  readonly #officeAuthority = new InMemoryOfficeStore();

  constructor(options: { clock?: LeaseClock } = {}) {
    this.#clock = options.clock ?? new SystemLeaseClock();
    this.#automationAuthority = new InMemoryAutomationAuthority({
      automations: this.#automations,
      createReceipts: this.#automationCreateReceipts,
      invocationReceipts: this.#automationInvocationReceipts,
      pendingProviderSettings: this.#pendingModelProviderSettings,
      runs: this.#runs,
      runEvents: this.#events,
      runEventIds: this.#eventIds,
      threads: this.#threads,
      threadEvents: this.#threadEvents,
      threadEventIds: this.#threadEventIds,
      messages: this.#messages,
      messageIds: this.#messageIds,
      modelHistory: this.#modelHistory,
      modelHistoryItemIds: this.#modelHistoryItemIds,
      outbox: this.#outbox,
      workItems: this.#workItems,
      appendModelHistory: (threadId, items) =>
        this.#appendModelHistory(threadId, items),
    });
  }

  commitOfficeDefinition(
    input: Parameters<InMemoryOfficeStore["commitOfficeDefinition"]>[0],
  ) {
    return this.#officeAuthority.commitOfficeDefinition(input);
  }
  loadOfficeDefinition(
    input: Parameters<InMemoryOfficeStore["loadOfficeDefinition"]>[0],
  ) {
    return this.#officeAuthority.loadOfficeDefinition(input);
  }
  listOfficeDefinitions(
    input: Parameters<InMemoryOfficeStore["listOfficeDefinitions"]>[0],
  ) {
    return this.#officeAuthority.listOfficeDefinitions(input);
  }
  async commitOfficeDelegationStart(
    _input: CommitOfficeDelegationStartInput,
  ): Promise<never> {
    throw new OfficeDelegationStoreError(
      "office_delegation_store_not_configured",
    );
  }
  async listOfficeDelegations(_input: {
    tenantId: string;
    spaceId: string;
    officeVersionId: string;
    before: OfficeDelegationListCursor | null;
    limit: number;
  }): Promise<never> {
    throw new OfficeDelegationStoreError(
      "office_delegation_store_not_configured",
    );
  }

  async close(): Promise<void> {}

  async loadAutomationCreateReceipt(
    query: AutomationCreateReceiptQuery,
  ): Promise<AutomationCreateResult | null> {
    return this.#automationAuthority.loadCreateReceipt(query);
  }
  async commitAutomationCreate(
    input: CommitAutomationCreateInput,
  ): Promise<AutomationCreateResult> {
    return this.#automationAuthority.commitCreate(input);
  }
  async loadAutomation(
    locator: AutomationLocator,
  ): Promise<AutomationDefinitionRecord | null> {
    return this.#automationAuthority.load(locator);
  }
  async listAutomations(
    query: AutomationListQuery,
  ): Promise<readonly AutomationDefinitionRecord[]> {
    return this.#automationAuthority.list(query);
  }
  async loadAutomationInvocationReceipt(
    query: AutomationInvocationReceiptQuery,
  ): Promise<AutomationInvocationResult | null> {
    return this.#automationAuthority.loadInvocationReceipt(query);
  }
  async loadAutomationInvocationContext(
    locator: AutomationLocator,
  ): Promise<AutomationInvocationContext | null> {
    return this.#automationAuthority.loadInvocationContext(locator);
  }
  async commitAutomationInvocation(
    input: CommitAutomationInvocationInput,
  ): Promise<AutomationInvocationResult> {
    return this.#automationAuthority.commitInvocation(input);
  }

  async loadModelProviderSettingsState(input: {
    tenantId: string;
  }): Promise<ModelProviderSettingsState> {
    requireNonEmpty(input.tenantId, "model_provider_settings_tenant_invalid");
    const catalog = this.#loadProviderHeadAuthority(input.tenantId);
    const pending = clone(
      this.#pendingModelProviderSettings.get(input.tenantId) ?? null,
    );
    if (pending !== null) {
      const operation = this.#requireProviderOperationAny(pending);
      if (stableJson(operation.authority.baseCatalog) !== stableJson(catalog)) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
    }
    return { catalog, pending };
  }

  async prepareModelProviderSettings(
    input: PrepareModelProviderSettingsInput,
  ): Promise<PrepareModelProviderSettingsResult> {
    const normalized = validatePrepareModelProviderSettingsInput(input);
    const receiptKey = providerReceiptKey(normalized, "prepare");
    const receipt = this.#modelProviderSettingsReceipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.fingerprint !== normalized.fingerprint) {
        throw new RunStoreError("model_provider_settings_idempotency_conflict");
      }
      const pending = parsePrepareModelProviderSettingsReceipt(
        clone(receipt.envelope),
        normalized,
      );
      const operation = this.#requireProviderOperationAny(normalized);
      if (stableJson(operation.authority.pending) !== stableJson(pending)) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      return {
        disposition: "replayed",
        pending,
      };
    }
    if (this.#pendingModelProviderSettings.has(normalized.tenantId)) {
      throw new RunStoreError("model_provider_settings_pending");
    }
    if (this.#hasActiveRun(normalized.tenantId)) {
      throw new RunStoreError("model_provider_settings_active_run");
    }
    const current = this.#loadProviderHeadAuthority(normalized.tenantId);
    if ((current?.revision ?? 0) !== normalized.expectedRevision) {
      throw new RunStoreError("model_provider_settings_revision_conflict");
    }
    if (
      normalized.activeProviderId !== null &&
      current?.runtimeBindingId === normalized.coordinatorBinding
    ) {
      throw new RunStoreError("model_provider_settings_operation_mismatch");
    }
    const preparedAtMs = readLeaseClock(this.#clock);
    const { expiresAt } = leaseExpiry(preparedAtMs, normalized.ttlMs);
    const preparedAt = new Date(preparedAtMs).toISOString();
    const pending: PendingModelProviderSettings = {
      tenantId: normalized.tenantId,
      operationId: normalized.operationId,
      coordinatorBinding: normalized.coordinatorBinding,
      baseRevision: normalized.expectedRevision,
      activeProviderId: normalized.activeProviderId,
      runtimeBindingId:
        normalized.activeProviderId === null
          ? null
          : normalized.coordinatorBinding,
      bindings: clone(normalized.bindings),
      preparedAt,
      expiresAt,
    };
    const envelope = providerSettingsReceiptEnvelope(
      "prepare",
      normalized.operationId,
      normalized.coordinatorBinding,
      pending,
      null,
      normalized.actor,
    );
    const authority = modelProviderSettingsOperation(
      pending,
      clone(current ?? null),
      normalized.actor,
    );
    this.#pendingModelProviderSettings.set(normalized.tenantId, clone(pending));
    this.#modelProviderSettingsOperations.set(
      providerOperationKey(normalized),
      {
        authority: clone(authority),
        status: "pending",
        resultEnvelope: null,
        terminalBinding: null,
        completedAt: null,
      },
    );
    this.#modelProviderSettingsReceipts.set(receiptKey, {
      fingerprint: normalized.fingerprint,
      envelope: clone(envelope),
    });
    return { disposition: "prepared", pending: clone(pending) };
  }

  async finalizeModelProviderSettings(
    input: FinalizeModelProviderSettingsInput,
  ): Promise<FinalizeModelProviderSettingsResult> {
    const normalized = validateFinalizeModelProviderSettingsInput(input);
    const receiptKey = providerReceiptKey(normalized, "finalize");
    const receipt = this.#modelProviderSettingsReceipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.fingerprint !== normalized.fingerprint) {
        throw new RunStoreError("model_provider_settings_idempotency_conflict");
      }
      const catalog = parseFinalizeModelProviderSettingsReceipt(
        clone(receipt.envelope),
        normalized,
      );
      const operation = this.#requireProviderOperation(normalized, "finalized");
      if (
        stableJson(operation.resultEnvelope) !== stableJson(receipt.envelope)
      ) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      validateFinalizedModelProviderSettingsOperation(
        operation.authority,
        catalog,
      );
      return {
        disposition: "replayed",
        catalog,
      };
    }
    const pending = this.#requirePendingProviderOperation(normalized);
    const finalizedAt = new Date(readLeaseClock(this.#clock)).toISOString();
    if (Date.parse(finalizedAt) < Date.parse(pending.preparedAt)) {
      throw new RunStoreError("model_provider_settings_operation_time_invalid");
    }
    if (Date.parse(finalizedAt) > Date.parse(pending.expiresAt)) {
      throw new RunStoreError("model_provider_settings_operation_expired");
    }
    const operation = this.#requireProviderOperation(normalized, "pending");
    const current = this.#loadProviderHeadAuthority(normalized.tenantId);
    if (
      (current?.revision ?? 0) !== pending.baseRevision ||
      stableJson(current) !== stableJson(operation.authority.baseCatalog)
    ) {
      throw new RunStoreError("model_provider_settings_revision_conflict");
    }
    const catalog: ModelProviderSettingsCatalog = {
      tenantId: normalized.tenantId,
      revision: pending.baseRevision + 1,
      activeProviderId: pending.activeProviderId,
      runtimeBindingId: pending.runtimeBindingId,
      bindings: clone(pending.bindings),
      updatedAt: finalizedAt,
    };
    const envelope = providerSettingsReceiptEnvelope(
      "finalize",
      normalized.operationId,
      normalized.coordinatorBinding,
      catalog,
      finalizedAt,
      normalized.actor,
    );
    validateFinalizedModelProviderSettingsOperation(
      operation.authority,
      catalog,
    );
    this.#modelProviderSettings.set(normalized.tenantId, clone(catalog));
    this.#pendingModelProviderSettings.delete(normalized.tenantId);
    this.#modelProviderSettingsOperations.set(
      providerOperationKey(normalized),
      {
        authority: operation.authority,
        status: "finalized",
        resultEnvelope: clone(envelope),
        terminalBinding: normalized.coordinatorBinding,
        completedAt: finalizedAt,
      },
    );
    this.#latestFinalizedProviderSettingsOperation.set(
      normalized.tenantId,
      providerOperationKey(normalized),
    );
    this.#modelProviderSettingsReceipts.set(receiptKey, {
      fingerprint: normalized.fingerprint,
      envelope: clone(envelope),
    });
    return { disposition: "finalized", catalog: clone(catalog) };
  }

  async abortModelProviderSettings(
    input: AbortModelProviderSettingsInput,
  ): Promise<AbortModelProviderSettingsResult> {
    const normalized = validateAbortModelProviderSettingsInput(input);
    const receiptKey = providerReceiptKey(normalized, "abort");
    const receipt = this.#modelProviderSettingsReceipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.fingerprint !== normalized.fingerprint) {
        throw new RunStoreError("model_provider_settings_idempotency_conflict");
      }
      const catalog = parseAbortModelProviderSettingsReceipt(
        clone(receipt.envelope),
        normalized,
      );
      const operation = this.#requireProviderOperation(normalized, "aborted");
      if (
        stableJson(operation.resultEnvelope) !== stableJson(receipt.envelope)
      ) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      validateAbortedModelProviderSettingsOperation(
        operation.authority,
        catalog,
      );
      return {
        disposition: "replayed",
        catalog,
      };
    }
    this.#requirePendingProviderOperation(normalized);
    const operation = this.#requireProviderOperation(normalized, "pending");
    const abortedAt = new Date(readLeaseClock(this.#clock)).toISOString();
    if (
      Date.parse(abortedAt) < Date.parse(operation.authority.pending.preparedAt)
    ) {
      throw new RunStoreError("model_provider_settings_operation_time_invalid");
    }
    const catalog = this.#loadProviderHeadAuthority(normalized.tenantId);
    const envelope = providerSettingsReceiptEnvelope(
      "abort",
      normalized.operationId,
      normalized.coordinatorBinding,
      catalog,
      abortedAt,
      normalized.actor,
    );
    validateAbortedModelProviderSettingsOperation(operation.authority, catalog);
    this.#pendingModelProviderSettings.delete(normalized.tenantId);
    this.#modelProviderSettingsOperations.set(
      providerOperationKey(normalized),
      {
        authority: operation.authority,
        status: "aborted",
        resultEnvelope: clone(envelope),
        terminalBinding: normalized.coordinatorBinding,
        completedAt: abortedAt,
      },
    );
    this.#modelProviderSettingsReceipts.set(receiptKey, {
      fingerprint: normalized.fingerprint,
      envelope: clone(envelope),
    });
    return { disposition: "aborted", catalog };
  }

  async expireModelProviderSettings(
    input: ExpireModelProviderSettingsInput,
  ): Promise<ExpireModelProviderSettingsResult> {
    const normalized = validateExpireModelProviderSettingsInput(input);
    const receiptKey = providerReceiptKey(normalized, "expire");
    const receipt = this.#modelProviderSettingsReceipts.get(receiptKey);
    if (receipt !== undefined) {
      if (receipt.fingerprint !== normalized.fingerprint) {
        throw new RunStoreError("model_provider_settings_idempotency_conflict");
      }
      const catalog = parseExpireModelProviderSettingsReceipt(
        clone(receipt.envelope),
        normalized,
      );
      const operation = this.#requireProviderOperationByRecovery(
        normalized,
        "expired",
      );
      validateAbortedModelProviderSettingsOperation(
        operation.authority,
        catalog,
      );
      if (
        stableJson(operation.resultEnvelope) !== stableJson(receipt.envelope)
      ) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      return { disposition: "replayed", catalog };
    }
    const operation = this.#requireProviderOperationByRecovery(
      normalized,
      "pending",
    );
    const expiredAt = new Date(readLeaseClock(this.#clock)).toISOString();
    if (
      Date.parse(expiredAt) <= Date.parse(operation.authority.pending.expiresAt)
    ) {
      throw new RunStoreError("model_provider_settings_operation_not_expired");
    }
    const catalog = this.#loadProviderHeadAuthority(normalized.tenantId);
    validateAbortedModelProviderSettingsOperation(operation.authority, catalog);
    const envelope = providerSettingsReceiptEnvelope(
      "expire",
      normalized.operationId,
      normalized.recoveryBinding,
      catalog,
      expiredAt,
      normalized.actor,
    );
    this.#pendingModelProviderSettings.delete(normalized.tenantId);
    this.#modelProviderSettingsOperations.set(
      providerOperationKey(normalized),
      {
        authority: operation.authority,
        status: "expired",
        resultEnvelope: clone(envelope),
        terminalBinding: normalized.recoveryBinding,
        completedAt: expiredAt,
      },
    );
    this.#modelProviderSettingsReceipts.set(receiptKey, {
      fingerprint: normalized.fingerprint,
      envelope: clone(envelope),
    });
    return { disposition: "expired", catalog };
  }

  async registerAgentVersion(
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult> {
    validateAgentVersionAsset(asset);
    const key = stableJson([asset.tenantId, asset.agentVersionId]);
    const existing = this.#agentVersions.get(key);
    if (existing !== undefined) {
      if (!sameAgentVersionAsset(existing, asset)) {
        throw new RunStoreError("agent_version_id_conflict");
      }
      return { disposition: "existing", asset: clone(existing) };
    }
    this.#agentVersions.set(key, clone(asset));
    return { disposition: "registered", asset: clone(asset) };
  }

  async loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionAsset | null> {
    validateAgentVersionLocator(input);
    const asset = this.#agentVersions.get(
      stableJson([input.tenantId, input.agentVersionId]),
    );
    return asset === undefined ? null : clone(asset);
  }

  async listAgentVersions(input: {
    tenantId: string;
    afterAgentVersionId: string | null;
    limit: number;
  }): Promise<readonly AgentVersionAsset[]> {
    validateAgentVersionList(input);
    return [...this.#agentVersions.values()]
      .filter(
        (asset) =>
          asset.tenantId === input.tenantId &&
          (input.afterAgentVersionId === null ||
            asset.agentVersionId > input.afterAgentVersionId),
      )
      .sort((left, right) =>
        left.agentVersionId < right.agentVersionId
          ? -1
          : left.agentVersionId > right.agentVersionId
            ? 1
            : 0,
      )
      .slice(0, input.limit)
      .map(clone);
  }

  async loadAgentVersionDeployment(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionDeployment | null> {
    validateAgentVersionLocator(input);
    const deployment = this.#agentVersionDeployments.get(
      stableJson([input.tenantId, input.agentVersionId]),
    );
    return deployment === undefined ? null : clone(deployment);
  }

  async activateAgentVersionRelease(input: {
    bundle: AgentVersionReleaseBundle;
    activation: ActiveAgentVersionRelease["activation"];
    expectedActiveReleaseId: string | null;
  }): Promise<ActivateAgentVersionReleaseResult> {
    validateAgentVersionReleaseBundle(input.bundle);
    validateAgentVersionReleaseActivation(input.activation);
    validateReleaseActivationInput(input);
    const activationKey = stableJson([
      input.activation.tenantId,
      input.activation.activationId,
    ]);
    const replay = this.#agentVersionReleaseActivations.get(activationKey);
    if (replay !== undefined) {
      if (
        !sameAgentVersionReleaseBundle(replay.bundle, input.bundle) ||
        !sameAgentVersionReleaseActivation(replay.activation, input.activation)
      ) {
        throw new RunStoreError("agent_version_release_activation_conflict");
      }
      return { disposition: "replayed", release: clone(replay) };
    }
    const active = this.#activeAgentVersionReleases.get(input.bundle.tenantId);
    if (
      (active?.bundle.releaseId ?? null) !== input.expectedActiveReleaseId ||
      input.activation.previousReleaseId !== input.expectedActiveReleaseId
    ) {
      throw new RunStoreError("agent_version_release_active_conflict");
    }
    const bundleKey = stableJson([
      input.bundle.tenantId,
      input.bundle.releaseId,
    ]);
    const existingBundle = this.#agentVersionReleaseBundles.get(bundleKey);
    if (
      existingBundle !== undefined &&
      !sameAgentVersionReleaseBundle(existingBundle, input.bundle)
    ) {
      throw new RunStoreError("agent_version_release_bundle_conflict");
    }
    const deployments = input.bundle.deployments.map((candidate) => {
      const key = stableJson([candidate.tenantId, candidate.agentVersionId]);
      const asset = this.#agentVersions.get(key);
      if (asset === undefined) {
        throw new RunStoreError("agent_version_release_asset_missing");
      }
      if (asset.contentDigest !== candidate.contentDigest) {
        throw new RunStoreError("agent_version_release_asset_mismatch");
      }
      const existing = this.#agentVersionDeployments.get(key);
      if (
        existing !== undefined &&
        !sameAgentVersionDeploymentCandidate(existing, candidate)
      ) {
        throw new RunStoreError("agent_version_deployment_conflict");
      }
      return {
        key,
        deployment: {
          ...candidate,
          deployedAt: input.activation.activatedAt,
        } satisfies AgentVersionDeployment,
      };
    });
    const release = clone({
      bundle: input.bundle,
      activation: input.activation,
    });
    this.#agentVersionReleaseBundles.set(bundleKey, clone(input.bundle));
    for (const { key, deployment } of deployments) {
      if (!this.#agentVersionDeployments.has(key)) {
        this.#agentVersionDeployments.set(key, clone(deployment));
      }
    }
    this.#agentVersionReleaseActivations.set(activationKey, release);
    this.#activeAgentVersionReleases.set(input.bundle.tenantId, release);
    return { disposition: "activated", release: clone(release) };
  }

  async loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null> {
    validateAgentVersionReleaseLocator(input);
    const bundle = this.#agentVersionReleaseBundles.get(
      stableJson([input.tenantId, input.releaseId]),
    );
    return bundle === undefined ? null : clone(bundle);
  }

  async loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): Promise<ActiveAgentVersionRelease["activation"] | null> {
    validateAgentVersionReleaseActivationLocator(input);
    const release = this.#agentVersionReleaseActivations.get(
      stableJson([input.tenantId, input.activationId]),
    );
    return release === undefined ? null : clone(release.activation);
  }

  async loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null> {
    validateAgentVersionReleaseTenant(input);
    const release = this.#activeAgentVersionReleases.get(input.tenantId);
    return release === undefined ? null : clone(release);
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    validateThreadLocator(locator);
    const state = this.#threads.get(locator.threadId) ?? null;
    return state?.tenantId === locator.tenantId ? clone(state) : null;
  }

  async loadThreadInSpace(
    locator: ThreadSpaceLocator,
  ): Promise<ThreadState | null> {
    validateThreadSpaceLocator(locator);
    const state = this.#threads.get(locator.threadId) ?? null;
    return state?.tenantId === locator.tenantId &&
      state.spaceId === locator.spaceId
      ? clone(state)
      : null;
  }

  loadWorkspaceOperationReceipt(
    query: WorkspaceOperationReceiptQuery,
  ): Promise<WorkspaceOperationPreparationResult | null> {
    return this.#workspaceOperations.loadWorkspaceOperationReceipt(query);
  }

  prepareWorkspaceOperation(
    input: PrepareWorkspaceOperationInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    return this.#workspaceOperations.prepareWorkspaceOperation(input);
  }

  loadWorkspaceOperation(input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  }): Promise<WorkspaceOperationRecord | null> {
    return this.#workspaceOperations.loadWorkspaceOperation(input);
  }

  loadWorkspaceOperationSnapshot(
    locator: WorkspaceOperationLocator,
  ): Promise<WorkspaceOperationSnapshot | null> {
    return this.#workspaceOperations.loadWorkspaceOperationSnapshot(locator);
  }

  listWorkspaceOperationEvents(
    query: WorkspaceOperationEventQuery,
  ): Promise<readonly WorkspaceOperationEvent[]> {
    return this.#workspaceOperations.listWorkspaceOperationEvents(query);
  }

  listWorkspaceOperations(
    query: WorkspaceOperationListQuery,
  ): Promise<WorkspaceOperationListPage> {
    return this.#workspaceOperations.listWorkspaceOperations(query);
  }

  prepareWorkspaceOperationAction(
    input: PrepareWorkspaceOperationActionInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    return this.#workspaceOperations.prepareWorkspaceOperationAction(input);
  }

  claimWorkspaceOperationDelivery(
    input: ClaimWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    return this.#workspaceOperations.claimWorkspaceOperationDelivery(input);
  }

  listWorkspaceOperationDeliveryAttempts(
    query: WorkspaceDeliveryAttemptQuery,
  ): Promise<readonly WorkspaceDeliveryAttempt[]> {
    return this.#workspaceOperations.listWorkspaceOperationDeliveryAttempts(
      query,
    );
  }

  abandonWorkspaceOperationDelivery(
    input: AbandonWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    return this.#workspaceOperations.abandonWorkspaceOperationDelivery(input);
  }

  settleWorkspaceOperationDelivery(
    input: CommitWorkspaceOperationResolutionInput,
  ): Promise<WorkspaceDeliverySettlementResult> {
    return this.#workspaceOperations.settleWorkspaceOperationDelivery(input);
  }

  async loadThreadGoal(locator: ThreadLocator): Promise<ThreadGoal | null> {
    validateThreadLocator(locator);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) return null;
    const goal = this.#threadGoals.get(locator.threadId) ?? null;
    return goal === null ? null : clone(goal);
  }

  async loadThreadGoalSnapshot(
    locator: ThreadLocator,
  ): Promise<ThreadGoalSnapshot> {
    validateThreadLocator(locator);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) {
      return { goal: null, eventSequence: 0 };
    }
    const goal = this.#threadGoals.get(locator.threadId) ?? null;
    const events = this.#threadGoalEvents.get(locator.threadId) ?? [];
    return {
      goal: goal === null ? null : clone(goal),
      eventSequence: events.at(-1)?.sequence ?? 0,
    };
  }

  async listThreadGoalEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadGoalEvent[]> {
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    validateLimit(limit);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) return [];
    const events = clone(
      (this.#threadGoalEvents.get(locator.threadId) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .slice(0, limit),
    );
    validateStoredThreadGoalEventPage(events, locator, afterSequence);
    return events;
  }

  async loadThreadGoalMutationReceipt(input: {
    tenantId: string;
    threadId: string;
    idempotency: import("@crewon/application").IdempotencyDescriptor;
  }): Promise<CommitThreadGoalMutationResult | null> {
    validateThreadLocator(input);
    const prior = this.#threadGoalMutationIdempotency.get(
      stableJson([input.idempotency.scope, input.idempotency.key]),
    );
    if (prior === undefined) return null;
    if (prior.tenantId !== input.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (prior.fingerprint !== input.idempotency.requestFingerprint) {
      throw new RunStoreError("idempotency_conflict");
    }
    if (prior.threadId !== input.threadId) {
      throw new RunStoreError("goal_mutation_receipt_invalid");
    }
    return clone({ ...prior.result, disposition: "replayed" });
  }

  async loadThreadActiveRun(
    locator: ThreadLocator,
  ): Promise<import("@crewon/application").ThreadGoalActiveRun | null> {
    validateThreadLocator(locator);
    const activeRuns = [...this.#runs.values()].filter(
      (run) =>
        run.tenantId === locator.tenantId &&
        run.threadId === locator.threadId &&
        !isTerminalRunStatus(run.status),
    );
    if (activeRuns.length > 1) {
      throw new RunStoreError("thread_active_run_invariant");
    }
    const activeRun = activeRuns[0];
    if (activeRun === undefined) return null;
    const workItems = [...this.#workItems.values()].filter(
      (record) =>
        isWorkItem(record.item) &&
        record.item.tenantId === locator.tenantId &&
        record.item.runId === activeRun.runId &&
        record.status !== "settled",
    );
    if (workItems.length > 1) {
      throw new RunStoreError("goal_active_run_work_item_invariant");
    }
    const trigger = workItems[0]?.item.payload.trigger;
    return clone({
      state: activeRun,
      trigger:
        trigger === "goalContinuation" || trigger === "goalActivation"
          ? trigger
          : "default",
    });
  }

  async commitThreadGoalMutation(
    input: CommitThreadGoalMutationInput,
  ): Promise<CommitThreadGoalMutationResult> {
    validateThreadGoalMutationInput(input);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#threadGoalMutationIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.threadId !== input.threadId) {
        throw new RunStoreError("goal_mutation_receipt_invalid");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return clone({ ...prior.result, disposition: "replayed" });
    }

    if (
      input.continuation !== null &&
      this.#pendingModelProviderSettings.has(input.tenantId)
    ) {
      throw new RunStoreError("model_provider_settings_switch_pending");
    }

    const thread = this.#threads.get(input.threadId) ?? null;
    if (
      thread === null ||
      thread.tenantId !== input.tenantId ||
      thread.status !== "active"
    ) {
      throw new RunStoreError("thread_not_found");
    }
    const activeRuns = [...this.#runs.values()].filter(
      (run) =>
        run.tenantId === input.tenantId &&
        run.threadId === input.threadId &&
        !isTerminalRunStatus(run.status),
    );
    if (activeRuns.length > 1) {
      throw new RunStoreError("thread_active_run_invariant");
    }
    const activeRun = activeRuns[0] ?? null;
    validateThreadGoalActiveRunFence(input.expectedActiveRun, activeRun);

    const currentGoal = this.#threadGoals.get(input.threadId) ?? null;
    const nextGoal = applyTurnStartGoalMutation(currentGoal, input.goal, {
      tenantId: input.tenantId,
      threadId: input.threadId,
    });
    const activeWorkItems =
      activeRun === null
        ? []
        : [...this.#workItems.values()].filter(
            (record) =>
              isWorkItem(record.item) &&
              record.item.tenantId === input.tenantId &&
              record.item.runId === activeRun.runId &&
              record.status !== "settled",
          );
    if (activeWorkItems.length > 1) {
      throw new RunStoreError("goal_active_run_work_item_invariant");
    }
    const activeTrigger = activeWorkItems[0]?.item.payload.trigger;
    const shouldCancel = shouldCancelQueuedRunForGoal(
      activeRun,
      nextGoal,
      activeTrigger === "goalContinuation" || activeTrigger === "goalActivation"
        ? activeTrigger
        : "default",
    );
    let canceledRunState: RunState | null = null;
    let canceledWorkItemId: string | null = null;
    const pendingEventIds = new Set<string>();
    const pendingOutboxIds = new Set<string>();
    if (shouldCancel) {
      if (activeRun === null || input.queuedRunCancellation === null) {
        throw new RunStoreError("goal_queued_run_cancellation_missing");
      }
      canceledRunState = reduceThreadGoalQueuedRunCancellation(
        input.queuedRunCancellation,
        activeRun,
        (eventId) => this.#eventIds.has(eventId),
        (messageId) => this.#outbox.has(messageId),
      );
      for (const event of input.queuedRunCancellation.events) {
        pendingEventIds.add(event.eventId);
      }
      for (const message of input.queuedRunCancellation.outbox) {
        pendingOutboxIds.add(message.messageId);
      }
      if (activeWorkItems.length !== 1) {
        throw new RunStoreError("goal_queued_run_work_item_invalid");
      }
      canceledWorkItemId = activeWorkItems[0]!.item.workItemId;
    } else if (input.queuedRunCancellation !== null) {
      throw new RunStoreError("goal_queued_run_cancellation_unexpected");
    }

    const shouldUpdateRetainedRun =
      activeRun !== null &&
      !shouldCancel &&
      activeRun.collaborationMode === "default" &&
      input.goal.kind !== "keep";
    let retainedRunState: RunState | null = null;
    if (shouldUpdateRetainedRun) {
      if (activeRun === null || input.retainedRunUpdate === null) {
        throw new RunStoreError("goal_retained_run_update_missing");
      }
      retainedRunState = reduceThreadGoalRetainedRunUpdate(
        input.retainedRunUpdate,
        activeRun,
        currentGoal,
        nextGoal,
        (eventId) =>
          pendingEventIds.has(eventId) || this.#eventIds.has(eventId),
        (messageId) =>
          pendingOutboxIds.has(messageId) || this.#outbox.has(messageId),
      );
      for (const event of input.retainedRunUpdate.events) {
        pendingEventIds.add(event.eventId);
      }
      for (const message of input.retainedRunUpdate.outbox) {
        pendingOutboxIds.add(message.messageId);
      }
    } else if (input.retainedRunUpdate !== null) {
      throw new RunStoreError("goal_retained_run_update_unexpected");
    }

    const shouldContinue =
      nextGoal?.status === "active" && (activeRun === null || shouldCancel);
    let continuationResult: CommitThreadGoalMutationResult["continuation"] =
      null;
    if (shouldContinue) {
      if (nextGoal === null || input.continuation === null) {
        throw new RunStoreError("goal_activation_missing");
      }
      validateModelHistoryAppend(
        input.continuation.history,
        { tenantId: input.tenantId, threadId: input.threadId },
        this.#modelHistory.get(input.threadId) ?? [],
        (itemId) => this.#modelHistoryItemIds.has(itemId),
      );
      const continuation = reduceThreadGoalContinuation(
        input.continuation,
        nextGoal,
        thread,
        (eventId) =>
          pendingEventIds.has(eventId) || this.#eventIds.has(eventId),
        (messageId) =>
          pendingOutboxIds.has(messageId) || this.#outbox.has(messageId),
        (workItemId) => this.#workItems.has(workItemId),
      );
      if (continuation.runState.runId === activeRun?.runId) {
        throw new RunStoreError("goal_activation_run_conflict");
      }
      continuationResult = {
        historyItem: clone(continuation.historyItem),
        runState: clone(continuation.runState),
        runEvents: clone(input.continuation.events),
        outbox: clone(input.continuation.outbox),
        workItems: clone(input.continuation.workItems),
      };
    } else if (input.continuation !== null) {
      throw new RunStoreError("goal_activation_unexpected");
    }

    const preparedCancellationOutbox =
      input.queuedRunCancellation?.outbox.map((message) => ({
        messageId: message.messageId,
        record: queueRecord(message, message.createdAt),
      })) ?? [];
    const preparedContinuationOutbox =
      input.continuation?.outbox.map((message) => ({
        messageId: message.messageId,
        record: queueRecord(message, message.createdAt),
      })) ?? [];
    const preparedRetainedRunOutbox =
      input.retainedRunUpdate?.outbox.map((message) => ({
        messageId: message.messageId,
        record: queueRecord(message, message.createdAt),
      })) ?? [];
    const preparedContinuationWorkItems =
      input.continuation?.workItems.map((workItem) => ({
        workItemId: workItem.workItemId,
        record: queueRecord(workItem, workItem.createdAt),
      })) ?? [];
    const preparedGoal = this.#prepareThreadGoalWrite(
      currentGoal,
      nextGoal,
      input.goal,
    );

    const result: CommitThreadGoalMutationResult = {
      disposition: "committed",
      goalChanged: stableJson(currentGoal) !== stableJson(nextGoal),
      goalState: nextGoal === null ? null : clone(nextGoal),
      canceledRunState:
        canceledRunState === null ? null : clone(canceledRunState),
      retainedRun:
        retainedRunState === null || input.retainedRunUpdate === null
          ? null
          : {
              runState: clone(retainedRunState),
              runEvents: clone(input.retainedRunUpdate.events),
              outbox: clone(input.retainedRunUpdate.outbox),
            },
      continuation: continuationResult,
    };
    this.#applyThreadGoalWrite(nextGoal, preparedGoal);
    if (canceledRunState !== null && input.queuedRunCancellation !== null) {
      this.#runs.set(canceledRunState.runId, clone(canceledRunState));
      this.#events.set(canceledRunState.runId, [
        ...(this.#events.get(canceledRunState.runId) ?? []),
        ...clone(input.queuedRunCancellation.events),
      ]);
      for (const event of input.queuedRunCancellation.events) {
        this.#eventIds.add(event.eventId);
      }
      for (const prepared of preparedCancellationOutbox) {
        this.#outbox.set(prepared.messageId, prepared.record);
      }
      forceSettle(this.#workItems, canceledWorkItemId!);
    }
    if (retainedRunState !== null && input.retainedRunUpdate !== null) {
      this.#runs.set(retainedRunState.runId, clone(retainedRunState));
      this.#events.set(retainedRunState.runId, [
        ...(this.#events.get(retainedRunState.runId) ?? []),
        ...clone(input.retainedRunUpdate.events),
      ]);
      for (const event of input.retainedRunUpdate.events) {
        this.#eventIds.add(event.eventId);
      }
      for (const prepared of preparedRetainedRunOutbox) {
        this.#outbox.set(prepared.messageId, prepared.record);
      }
    }
    if (continuationResult !== null && input.continuation !== null) {
      this.#appendModelHistory(
        input.threadId,
        input.continuation.history.items,
      );
      this.#runs.set(
        continuationResult.runState.runId,
        clone(continuationResult.runState),
      );
      this.#events.set(continuationResult.runState.runId, [
        ...clone(input.continuation.events),
      ]);
      for (const event of input.continuation.events) {
        this.#eventIds.add(event.eventId);
      }
      for (const prepared of preparedContinuationOutbox) {
        this.#outbox.set(prepared.messageId, prepared.record);
      }
      for (const prepared of preparedContinuationWorkItems) {
        this.#workItems.set(prepared.workItemId, prepared.record);
      }
    }
    this.#threadGoalMutationIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      threadId: input.threadId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async executeGoalTool(
    input: GoalToolExecutionInput,
  ): Promise<GoalToolExecutionResult> {
    validateGoalToolExecutionInput(input);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#goalToolIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return clone({ ...prior.result, disposition: "replayed" });
    }
    const run = this.#runs.get(input.runId) ?? null;
    if (
      run === null ||
      run.tenantId !== input.tenantId ||
      run.threadId !== input.threadId
    ) {
      throw new RunStoreError("run_not_found");
    }
    validateGoalToolRequestedEvent(
      input,
      (this.#events.get(input.runId) ?? []).find(
        (event) =>
          event.type === "tool.requested" &&
          event.data.callId === input.request.callId,
      ) ?? null,
    );
    const current = this.#threadGoals.get(input.threadId) ?? null;
    let evaluation;
    try {
      evaluation = evaluateGoalToolCall(
        current,
        run,
        input.request.name,
        input.request.input,
        input.occurredAt,
        input.proposedGoalId,
      );
    } catch (error) {
      throw error instanceof ThreadGoalError
        ? new RunStoreError(error.code, { cause: error })
        : error;
    }
    const next = applyTurnStartGoalMutation(current, evaluation.mutation, {
      tenantId: input.tenantId,
      threadId: input.threadId,
    });
    const accounting = prepareGoalToolAccounting(input, run, evaluation);
    validateEvents(accounting.runEvents, run.runId, (eventId) =>
      this.#eventIds.has(eventId),
    );
    validateOutbox(accounting.outbox, run.runId, run.tenantId, (messageId) =>
      this.#outbox.has(messageId),
    );
    const preparedOutbox = accounting.outbox.map((message) => ({
      messageId: message.messageId,
      record: queueRecord(message, message.createdAt),
    }));
    const preparedGoal = this.#prepareThreadGoalWrite(
      current,
      next,
      evaluation.mutation,
    );
    this.#applyThreadGoalWrite(next, preparedGoal);
    if (accounting.runEvents.length > 0) {
      this.#runs.set(run.runId, clone(accounting.runState));
      this.#events.set(run.runId, [
        ...(this.#events.get(run.runId) ?? []),
        ...clone(accounting.runEvents),
      ]);
      for (const event of accounting.runEvents) {
        this.#eventIds.add(event.eventId);
      }
      for (const prepared of preparedOutbox) {
        this.#outbox.set(prepared.messageId, prepared.record);
      }
    }
    const result: GoalToolExecutionResult = {
      disposition: "committed",
      goalState: next,
      runState: clone(accounting.runState),
      runEvents: clone(accounting.runEvents),
      outbox: clone(accounting.outbox),
      output: evaluation.output,
      isError: evaluation.isError,
    };
    this.#goalToolIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async listThreads(query: ThreadListQuery): Promise<readonly ThreadState[]> {
    validateThreadListQuery(query);
    return clone(
      [...this.#threads.values()]
        .filter(
          (thread) =>
            thread.tenantId === query.tenantId &&
            thread.spaceId === query.spaceId &&
            thread.status !== "deleted" &&
            isBeforeThreadCursor(thread, query.before),
        )
        .sort(compareThreadsNewestFirst)
        .slice(0, query.limit),
    );
  }

  async commitThread(input: CommitThreadInput): Promise<CommitThreadResult> {
    const threadId = validateThreadCommitInput(input);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#threadIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      validateThreadReceiptResult(prior.result, {
        tenantId: input.tenantId,
        threadId: prior.threadId,
      });
      return clone({ ...prior.result, disposition: "replayed" });
    }
    if (this.#threadRollbackIdempotency.has(receiptKey)) {
      throw new RunStoreError("idempotency_conflict");
    }

    if (input.sourceFence !== undefined) {
      const source = this.#threads.get(input.sourceFence.threadId);
      if (
        source?.tenantId !== input.tenantId ||
        source.spaceId !== input.sourceFence.spaceId ||
        source.revision !== input.sourceFence.expectedRevision
      ) {
        throw new RunStoreError("thread_fork_source_revision_conflict");
      }
    }

    const current = this.#threads.get(threadId) ?? null;
    if (current !== null && current.tenantId !== input.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (input.expectedRevision !== (current?.revision ?? 0)) {
      throw new RunStoreError("revision_conflict");
    }
    let tombstoneGoalWrite: Readonly<{
      threadId: string;
      event: ThreadGoalEvent;
    }> | null = null;
    if (input.tombstone !== undefined) {
      const activeRuns = [...this.#runs.values()].filter(
        (run) =>
          run.tenantId === input.tenantId &&
          run.threadId === threadId &&
          !isTerminalRunStatus(run.status),
      );
      if (activeRuns.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      if (activeRuns.length !== 0) {
        throw new RunStoreError("thread_active_run_conflict");
      }
      const unsettledWork = [...this.#workItems.values()].filter((record) => {
        if (record.status === "settled" || !isWorkItem(record.item)) {
          return false;
        }
        const run = this.#runs.get(record.item.runId);
        return run?.tenantId === input.tenantId && run.threadId === threadId;
      });
      if (unsettledWork.length !== 0) {
        throw new RunStoreError("thread_active_work_conflict");
      }
      const currentGoal = this.#threadGoals.get(threadId) ?? null;
      if (
        (currentGoal?.revision ?? null) !== input.tombstone.expectedGoalRevision
      ) {
        throw new RunStoreError("goal_revision_conflict");
      }
      tombstoneGoalWrite = this.#prepareThreadGoalWrite(currentGoal, null, {
        kind: "clear",
        expectedRevision: input.tombstone.expectedGoalRevision,
        occurredAt: input.tombstone.occurredAt,
      });
    }
    validateThreadEvents(input.events, threadId, (eventId) =>
      this.#threadEventIds.has(eventId),
    );
    let next = current;
    for (const event of input.events) {
      next = reduceThreadLifecycleEvent(next, event);
    }
    if (next === null) {
      throw new RunStoreError("thread_events_empty");
    }
    validateMessages(
      input.messages,
      input.events,
      threadId,
      input.tenantId,
      (messageId) => this.#messageIds.has(messageId),
    );
    validateModelHistoryAppend(
      input.history,
      { tenantId: input.tenantId, threadId },
      this.#modelHistory.get(threadId) ?? [],
      (itemId) => this.#modelHistoryItemIds.has(itemId),
    );

    const result: CommitThreadResult = {
      disposition: "committed",
      state: clone(next),
      events: clone(input.events),
      messages: clone(input.messages),
      historyItems: clone(input.history.items),
    };
    this.#threads.set(threadId, clone(next));
    this.#threadEvents.set(threadId, [
      ...(this.#threadEvents.get(threadId) ?? []),
      ...clone(input.events),
    ]);
    for (const event of input.events) {
      this.#threadEventIds.add(event.eventId);
    }
    this.#messages.set(threadId, [
      ...(this.#messages.get(threadId) ?? []),
      ...clone(input.messages),
    ]);
    for (const message of input.messages) {
      this.#messageIds.add(message.messageId);
    }
    this.#appendModelHistory(threadId, input.history.items);
    if (input.tombstone !== undefined) {
      this.#applyThreadGoalWrite(null, tombstoneGoalWrite);
    }
    this.#threadIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      threadId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async loadThreadRollbackReceipt(
    query: ThreadRollbackReceiptQuery,
  ): Promise<CommitThreadRollbackResult | null> {
    validateThreadRollbackReceiptQuery(query);
    const receiptKey = stableJson([
      query.idempotency.scope,
      query.idempotency.key,
    ]);
    const prior = this.#threadRollbackIdempotency.get(receiptKey);
    if (prior === undefined) {
      if (this.#threadIdempotency.has(receiptKey)) {
        throw new RunStoreError("idempotency_conflict");
      }
      return null;
    }
    if (prior.tenantId !== query.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (prior.fingerprint !== query.idempotency.requestFingerprint) {
      throw new RunStoreError("idempotency_conflict");
    }
    if (prior.threadId !== query.threadId) {
      throw new RunStoreError("thread_rollback_receipt_invalid");
    }
    validateThreadRollbackReceiptResult(prior.result, query);
    this.#validateRollbackReceiptAuthority(prior.result);
    return clone({ ...prior.result, disposition: "replayed" });
  }

  async commitThreadRollback(
    input: CommitThreadRollbackInput,
  ): Promise<CommitThreadRollbackResult> {
    const threadId = input.event.identity.threadId;
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#threadRollbackIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      validateThreadRollbackReceiptResult(prior.result, {
        tenantId: input.tenantId,
        threadId: prior.threadId,
      });
      this.#validateRollbackReceiptAuthority(prior.result);
      return clone({ ...prior.result, disposition: "replayed" });
    }
    if (this.#threadIdempotency.has(receiptKey)) {
      throw new RunStoreError("idempotency_conflict");
    }

    const activeRuns = [...this.#runs.values()].filter(
      (run) =>
        run.tenantId === input.tenantId &&
        run.threadId === threadId &&
        !isTerminalRunStatus(run.status),
    );
    if (activeRuns.length > 1) {
      throw new RunStoreError("thread_active_run_invariant");
    }
    if (activeRuns.length !== 0) {
      throw new RunStoreError("thread_active_run_conflict");
    }
    const unsettledWork = [...this.#workItems.values()].filter((record) => {
      if (record.status === "settled" || !isWorkItem(record.item)) return false;
      const run = this.#runs.get(record.item.runId);
      return run?.tenantId === input.tenantId && run.threadId === threadId;
    });
    if (unsettledWork.length !== 0) {
      throw new RunStoreError("thread_active_work_conflict");
    }

    const history = this.#modelHistory.get(threadId) ?? [];
    const messages = this.#messages.get(threadId) ?? [];
    const prepared = prepareThreadRollbackCommit(
      input,
      this.#threads.get(threadId) ?? null,
      history,
      messages,
    );
    validateThreadEvents([input.event], threadId, (eventId) =>
      this.#threadEventIds.has(eventId),
    );
    validateModelHistoryAppend(
      {
        expectedLastSequence: input.expectedHistorySequence,
        items: [input.marker],
      },
      { tenantId: input.tenantId, threadId },
      history,
      (itemId) => this.#modelHistoryItemIds.has(itemId),
    );
    const existingInvalidations = this.#messageInvalidations.get(threadId);
    if (
      prepared.invalidatedMessages.some(({ messageSequence }) =>
        existingInvalidations?.has(messageSequence),
      )
    ) {
      throw new RunStoreError("message_already_invalidated");
    }

    const continuationKeys = [...this.#threadContinuations.entries()]
      .filter(
        ([, checkpoint]) =>
          checkpoint.tenantId === input.tenantId &&
          checkpoint.threadId === threadId,
      )
      .map(([key]) => key);
    const modelStateKey = stableJson([input.tenantId, threadId]);
    const invalidatedModelState = this.#threadModelStates.has(modelStateKey);
    const result: CommitThreadRollbackResult = {
      disposition: "committed",
      state: clone(prepared.state),
      event: clone(input.event),
      marker: clone(input.marker),
      invalidatedMessages: clone(prepared.invalidatedMessages),
      invalidatedContinuationCount: continuationKeys.length,
      invalidatedModelState,
    };

    this.#threads.set(threadId, clone(prepared.state));
    this.#threadEvents.set(threadId, [
      ...(this.#threadEvents.get(threadId) ?? []),
      clone(input.event),
    ]);
    this.#threadEventIds.add(input.event.eventId);
    this.#appendModelHistory(threadId, [input.marker]);
    const invalidations = existingInvalidations ?? new Map();
    for (const invalidated of prepared.invalidatedMessages) {
      invalidations.set(
        invalidated.messageSequence,
        clone(invalidated.invalidation),
      );
    }
    this.#messageInvalidations.set(threadId, invalidations);
    for (const key of continuationKeys) this.#threadContinuations.delete(key);
    this.#threadModelStates.delete(modelStateKey);
    this.#threadRollbackEffects.set(
      stableJson([input.tenantId, threadId, input.marker.rollbackId]),
      {
        invalidatedContinuationCount: continuationKeys.length,
        invalidatedModelState,
      },
    );
    this.#threadRollbackIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      threadId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  #validateRollbackReceiptAuthority(result: CommitThreadRollbackResult): void {
    const threadId = result.state.threadId;
    const messages = this.#messages.get(threadId) ?? [];
    const invalidations = this.#messageInvalidations.get(threadId);
    const invalidatedMessages: InvalidatedMessage[] = [];
    for (const message of messages) {
      const invalidation = invalidations?.get(message.sequence);
      if (invalidation?.rollbackId === result.marker.rollbackId) {
        invalidatedMessages.push({
          messageId: message.messageId,
          messageSequence: message.sequence,
          invalidation,
        });
      }
    }
    const effects = this.#threadRollbackEffects.get(
      stableJson([result.state.tenantId, threadId, result.marker.rollbackId]),
    );
    if (effects === undefined) {
      throw new RunStoreError("thread_rollback_receipt_authority_invalid");
    }
    validateThreadRollbackReceiptAuthority(
      result,
      this.#modelHistory.get(threadId) ?? [],
      messages,
      invalidatedMessages,
      effects,
    );
  }

  #hasActiveRun(tenantId: string): boolean {
    return [...this.#runs.values()].some(
      (run) => run.tenantId === tenantId && !isTerminalRunStatus(run.status),
    );
  }

  #loadProviderHeadAuthority(
    tenantId: string,
  ): ModelProviderSettingsCatalog | null {
    const catalog = clone(this.#modelProviderSettings.get(tenantId) ?? null);
    const latestFinalizedKey =
      this.#latestFinalizedProviderSettingsOperation.get(tenantId);
    if ((catalog === null) !== (latestFinalizedKey === undefined)) {
      throw new RunStoreError("model_provider_settings_stored_state_invalid");
    }
    if (latestFinalizedKey !== undefined) {
      const latest =
        this.#modelProviderSettingsOperations.get(latestFinalizedKey);
      if (
        latest === undefined ||
        latest.status !== "finalized" ||
        stableJson(this.#validateProviderOperationRecord(latest)) !==
          stableJson(catalog)
      ) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
    }
    return catalog;
  }

  #requirePendingProviderOperation(input: {
    tenantId: string;
    operationId: string;
    coordinatorBinding: string;
  }): PendingModelProviderSettings {
    const pending = this.#pendingModelProviderSettings.get(input.tenantId);
    if (
      pending === undefined ||
      pending.operationId !== input.operationId ||
      pending.coordinatorBinding !== input.coordinatorBinding
    ) {
      throw new RunStoreError("model_provider_settings_operation_mismatch");
    }
    return clone(pending);
  }

  #requireProviderOperation(
    input: {
      tenantId: string;
      operationId: string;
      coordinatorBinding: string;
    },
    status: ModelProviderSettingsOperationRecord["status"],
  ): ModelProviderSettingsOperationRecord {
    const operation = this.#modelProviderSettingsOperations.get(
      providerOperationKey(input),
    );
    if (
      operation === undefined ||
      operation.status !== status ||
      operation.authority.pending.coordinatorBinding !==
        input.coordinatorBinding
    ) {
      throw new RunStoreError("model_provider_settings_operation_mismatch");
    }
    this.#validateProviderOperationRecord(operation);
    return clone(operation);
  }

  #requireProviderOperationAny(input: {
    tenantId: string;
    operationId: string;
    coordinatorBinding: string;
  }): ModelProviderSettingsOperationRecord {
    const operation = this.#modelProviderSettingsOperations.get(
      providerOperationKey(input),
    );
    if (
      operation === undefined ||
      operation.authority.pending.coordinatorBinding !==
        input.coordinatorBinding
    ) {
      throw new RunStoreError("model_provider_settings_stored_state_invalid");
    }
    this.#validateProviderOperationRecord(operation);
    return clone(operation);
  }

  #requireProviderOperationByRecovery(
    input: {
      tenantId: string;
      operationId: string;
      recoveryBinding: string;
    },
    status: "pending" | "expired",
  ): ModelProviderSettingsOperationRecord {
    const operation = this.#modelProviderSettingsOperations.get(
      providerOperationKey(input),
    );
    if (
      operation === undefined ||
      operation.status !== status ||
      (status === "expired" &&
        operation.terminalBinding !== input.recoveryBinding)
    ) {
      throw new RunStoreError("model_provider_settings_operation_mismatch");
    }
    this.#validateProviderOperationRecord(operation);
    return clone(operation);
  }

  #validateProviderOperationRecord(
    operation: ModelProviderSettingsOperationRecord,
  ): ModelProviderSettingsCatalog | null {
    if (operation.status === "pending") {
      if (
        operation.resultEnvelope !== null ||
        operation.terminalBinding !== null ||
        operation.completedAt !== null
      ) {
        throw new RunStoreError("model_provider_settings_stored_state_invalid");
      }
      return null;
    }
    return validateStoredTerminalModelProviderSettingsOperation({
      operation: operation.authority,
      status: operation.status,
      terminalBinding: operation.terminalBinding,
      completedAt: operation.completedAt,
      resultEnvelope: operation.resultEnvelope,
    });
  }

  async loadTurnStartReceipt(
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null> {
    validateTurnStartReceiptQuery(query);
    const receiptKey = stableJson([
      query.idempotency.scope,
      query.idempotency.key,
    ]);
    const prior = this.#turnStartIdempotency.get(receiptKey);
    if (prior === undefined) return null;
    if (prior.tenantId !== query.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (prior.fingerprint !== query.idempotency.requestFingerprint) {
      throw new RunStoreError("idempotency_conflict");
    }
    if (prior.result.threadState.threadId !== query.threadId) {
      throw new RunStoreError("turn_start_idempotency_receipt_invalid");
    }
    return clone({ ...prior.result, disposition: "replayed" });
  }

  async commitTurnStart(
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult> {
    const { runId, threadId } = validateTurnStartInput(input);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#turnStartIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return clone({ ...prior.result, disposition: "replayed" });
    }

    if (this.#pendingModelProviderSettings.has(input.tenantId)) {
      throw new RunStoreError("model_provider_settings_switch_pending");
    }

    const currentThread = this.#threads.get(threadId) ?? null;
    if (currentThread?.tenantId !== input.tenantId) {
      throw new RunStoreError("thread_not_found");
    }
    if (currentThread.revision !== input.thread.expectedRevision) {
      throw new RunStoreError("revision_conflict");
    }
    if (currentThread.status !== "active") {
      throw new RunStoreError("thread_not_active");
    }
    if (
      [...this.#runs.values()].some(
        (run) =>
          run.tenantId === input.tenantId &&
          run.threadId === threadId &&
          !isTerminalRunStatus(run.status),
      )
    ) {
      throw new RunStoreError("thread_active_run_conflict");
    }
    if (this.#runs.has(runId)) {
      throw new RunStoreError("revision_conflict");
    }
    const currentGoal = this.#threadGoals.get(threadId) ?? null;
    const nextGoal = applyTurnStartGoalMutation(currentGoal, input.goal, {
      tenantId: input.tenantId,
      threadId,
    });
    validateTurnStartGoalBinding(nextGoal, input);

    validateThreadEvents(input.thread.events, threadId, (eventId) =>
      this.#threadEventIds.has(eventId),
    );
    validateMessages(
      input.thread.messages,
      input.thread.events,
      threadId,
      input.tenantId,
      (messageId) => this.#messageIds.has(messageId),
    );
    validateModelHistoryAppend(
      input.thread.history,
      { tenantId: input.tenantId, threadId },
      this.#modelHistory.get(threadId) ?? [],
      (itemId) => this.#modelHistoryItemIds.has(itemId),
    );
    let nextThread: ThreadState | null = currentThread;
    for (const event of input.thread.events) {
      nextThread = reduceThreadLifecycleEvent(nextThread, event);
    }
    if (nextThread === null) {
      throw new RunStoreError("thread_events_empty");
    }

    validateEvents(input.run.events, runId, (eventId) =>
      this.#eventIds.has(eventId),
    );
    let nextRun: RunState | null = null;
    for (const event of input.run.events) {
      nextRun = reduceRunLifecycleEvent(nextRun, event);
    }
    if (
      nextRun === null ||
      nextRun.tenantId !== input.tenantId ||
      nextRun.threadId !== threadId ||
      nextRun.spaceId !== nextThread.spaceId
    ) {
      throw new RunStoreError("turn_start_authority_mismatch");
    }
    validateOutbox(input.run.outbox, runId, input.tenantId, (messageId) =>
      this.#outbox.has(messageId),
    );
    validateWorkItems(
      input.run.workItems,
      runId,
      input.tenantId,
      input.run.events.at(-1)?.sequence ?? 0,
      (workItemId) => this.#workItems.has(workItemId),
    );
    const preparedGoal = this.#prepareThreadGoalWrite(
      currentGoal,
      nextGoal,
      input.goal,
    );

    const result: CommitTurnStartResult = {
      disposition: "committed",
      threadState: clone(nextThread),
      runState: clone(nextRun),
      goalState: nextGoal === null ? null : clone(nextGoal),
      threadEvents: clone(input.thread.events),
      messages: clone(input.thread.messages),
      historyItems: clone(input.thread.history.items),
      runEvents: clone(input.run.events),
      outbox: clone(input.run.outbox),
      workItems: clone(input.run.workItems),
    };
    this.#threads.set(threadId, clone(nextThread));
    this.#threadEvents.set(threadId, [
      ...(this.#threadEvents.get(threadId) ?? []),
      ...clone(input.thread.events),
    ]);
    for (const event of input.thread.events) {
      this.#threadEventIds.add(event.eventId);
    }
    this.#messages.set(threadId, [
      ...(this.#messages.get(threadId) ?? []),
      ...clone(input.thread.messages),
    ]);
    for (const message of input.thread.messages) {
      this.#messageIds.add(message.messageId);
    }
    this.#appendModelHistory(threadId, input.thread.history.items);
    this.#applyThreadGoalWrite(nextGoal, preparedGoal);
    this.#runs.set(runId, clone(nextRun));
    this.#events.set(runId, [...clone(input.run.events)]);
    for (const event of input.run.events) {
      this.#eventIds.add(event.eventId);
    }
    for (const message of input.run.outbox) {
      this.#outbox.set(
        message.messageId,
        queueRecord(message, message.createdAt),
      );
    }
    for (const workItem of input.run.workItems) {
      this.#workItems.set(
        workItem.workItemId,
        queueRecord(workItem, workItem.createdAt),
      );
    }
    this.#turnStartIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
    view: MessageView = "standard",
  ): Promise<readonly MessageRecord[]> {
    validateMessagePage(locator, afterSequence, limit);
    validateMessageView(view);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) {
      return [];
    }
    const invalidations = this.#messageInvalidations.get(locator.threadId);
    return (this.#messages.get(locator.threadId) ?? [])
      .filter(
        (message) =>
          message.sequence > afterSequence &&
          (view === "audit" || !invalidations?.has(message.sequence)),
      )
      .slice(0, limit)
      .map((message) => {
        const invalidation = invalidations?.get(message.sequence) ?? null;
        return clone(view === "audit" ? { ...message, invalidation } : message);
      });
  }

  async listThreadEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadLifecycleEvent[]> {
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    validateLimit(limit);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) {
      return [];
    }
    const events = clone(
      (this.#threadEvents.get(locator.threadId) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .slice(0, limit),
    );
    validateStoredThreadEventPage(events, locator, afterSequence);
    return events;
  }

  async loadModelHistoryHead(
    locator: ThreadLocator,
  ): Promise<import("@crewon/domain").ModelHistoryHead | null> {
    validateThreadLocator(locator);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) {
      return null;
    }
    return {
      tenantId: locator.tenantId,
      threadId: locator.threadId,
      lastSequence:
        this.#modelHistory.get(locator.threadId)?.at(-1)?.sequence ?? 0,
    };
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ModelHistoryItem[]> {
    validateModelHistoryPage(locator, afterSequence, limit);
    const thread = this.#threads.get(locator.threadId);
    if (thread?.tenantId !== locator.tenantId) {
      return [];
    }
    return clone(
      (this.#modelHistory.get(locator.threadId) ?? [])
        .filter((item) => item.sequence > afterSequence)
        .slice(0, limit),
    );
  }

  async loadRun(locator: RunLocator): Promise<RunState | null> {
    validateRunLocator(locator);
    const state = this.#runs.get(locator.runId) ?? null;
    return state?.tenantId === locator.tenantId ? clone(state) : null;
  }

  async loadRunReceipt(
    query: RunReceiptQuery,
  ): Promise<CommitRunResult | null> {
    validateRunReceiptQuery(query);
    const prior = this.#idempotency.get(
      stableJson([query.idempotency.scope, query.idempotency.key]),
    );
    if (prior === undefined) return null;
    if (prior.tenantId !== query.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    if (prior.fingerprint !== query.idempotency.requestFingerprint) {
      throw new RunStoreError("idempotency_conflict");
    }
    if (prior.result.state.threadId !== query.threadId) {
      throw new RunStoreError("idempotency_receipt_invalid");
    }
    return clone({ ...prior.result, disposition: "replayed" });
  }

  async listThreadRuns(
    query: ThreadRunListQuery,
  ): Promise<readonly RunState[]> {
    validateThreadRunListQuery(query);
    return clone(
      [...this.#runs.values()]
        .filter(
          (run) =>
            run.tenantId === query.tenantId &&
            run.spaceId === query.spaceId &&
            run.threadId === query.threadId &&
            isBeforeRunCursor(run, query.before),
        )
        .sort(compareRunsNewestFirst)
        .slice(0, query.limit),
    );
  }

  async loadRunStep(locator: RunStepLocator) {
    validateRunStepLocator(locator);
    return this.#executionAuthority.loadStep(locator);
  }

  async loadRunAttempt(locator: RunAttemptLocator) {
    validateRunAttemptLocator(locator);
    return this.#executionAuthority.loadAttempt(locator);
  }

  async listRunAttempts(
    locator: RunStepLocator,
    afterAttemptNumber: number,
    limit: number,
  ) {
    validateRunAttemptPage(locator, afterAttemptNumber, limit);
    return this.#executionAuthority.listAttempts(
      locator,
      afterAttemptNumber,
      limit,
    );
  }

  async loadRunProviderTurnState(
    locator: Readonly<{
      tenantId: string;
      runId: string;
    }>,
  ) {
    return this.#executionAuthority.loadRunProviderTurnState(locator);
  }

  async beginRunAttempt(
    input: BeginRunAttemptInput,
  ): Promise<BeginRunAttemptResult> {
    validateBeginRunAttemptInput(input);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    const run = this.#runs.get(input.runId);
    if (run?.tenantId !== input.tenantId) {
      throw new RunStoreError("execution_authority_mismatch");
    }
    if (
      run.status !== "running" &&
      !(run.status === "reconciling" && input.mode === "reconcile")
    ) {
      throw new RunStoreError("run_not_running_conflict");
    }
    return this.#executionAuthority.begin(input);
  }

  async checkpointRunAttempt(
    input: import("@crewon/application").CheckpointRunAttemptInput,
  ) {
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    return this.#executionAuthority.checkpoint(
      { tenantId: input.tenantId, runId: input.runId, ...input.attempt },
      input.lease.workItemId,
      input.lease.leaseEpoch,
      input.checkpoint,
      input.checkpointDigest,
      input.checkpointedAt,
    );
  }

  async recordRunAttemptProviderTurnState(
    input: import("@crewon/application").RecordRunAttemptProviderTurnStateInput,
  ) {
    validateRecordRunAttemptProviderTurnStateInput(input);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    return this.#executionAuthority.recordProviderTurnState(
      { tenantId: input.tenantId, runId: input.runId, ...input.attempt },
      input.lease.workItemId,
      input.lease.leaseEpoch,
      input.providerTurnState,
      input.observedAt,
    );
  }

  async loadToolExecutionReceipt(
    locator: ToolExecutionReceiptLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    validateToolExecutionReceiptLocator(locator);
    const receipt = this.#toolExecutionReceipts.get(locator.receiptId) ?? null;
    return receipt?.tenantId === locator.tenantId &&
      receipt.runId === locator.runId
      ? clone(receipt)
      : null;
  }

  async loadToolApproval(
    locator: ToolApprovalLocator,
  ): Promise<ToolApprovalState | null> {
    const approval = this.#toolApprovals.get(locator.approvalId) ?? null;
    return approval?.tenantId === locator.tenantId ? clone(approval) : null;
  }

  async loadToolApprovalByAction(
    locator: ToolApprovalActionLocator,
  ): Promise<ToolApprovalState | null> {
    const approvalId = this.#toolApprovalActions.get(
      toolApprovalActionKey(locator),
    );
    return approvalId === undefined
      ? null
      : this.loadToolApproval({ tenantId: locator.tenantId, approvalId });
  }

  async loadLatestToolApprovalForRun(
    locator: ToolApprovalRunLocator,
  ): Promise<ToolApprovalState | null> {
    const approval = [...this.#toolApprovals.values()]
      .filter(
        (candidate) =>
          candidate.tenantId === locator.tenantId &&
          candidate.runId === locator.runId,
      )
      .sort(
        (left, right) =>
          right.requiredAt.localeCompare(left.requiredAt) ||
          right.approvalId.localeCompare(left.approvalId),
      )[0];
    return approval === undefined ? null : clone(approval);
  }

  async requireToolApproval(
    input: RequireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    validateRequiredApproval(input.approval);
    validateQueueRetry({
      ...input.lease,
      retryAfterMs: input.retryAfterMs,
      reasonCode: "tool_approval_required",
    });
    const approval = input.approval;
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(
      approval.tenantId,
      approval.runId,
      input.lease,
      now,
    );
    const receipt = this.#toolExecutionReceipts.get(approval.receiptId);
    validateApprovalReceiptBinding(approval, receipt);
    if (
      this.#toolApprovals.has(approval.approvalId) ||
      this.#toolApprovalActions.has(toolApprovalActionKey(approval))
    ) {
      throw new RunStoreError("tool_approval_conflict");
    }
    validateApprovalRunCommit(approval, input.commit, "require");
    const record = requiredQueueRecord(this.#workItems, approval.workItemId);
    validateRecordLease(record, input.lease, now);

    const run = this.#commitRun(input.commit);
    this.#toolApprovals.set(approval.approvalId, clone(approval));
    this.#toolApprovalActions.set(
      toolApprovalActionKey(approval),
      approval.approvalId,
    );
    retry(
      this.#workItems,
      approval.workItemId,
      { ...input.lease, retryAfterMs: input.retryAfterMs },
      now,
    );
    return clone({ approval, run });
  }

  async decideToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    const now = readLeaseClock(this.#clock);
    const current = this.#toolApprovals.get(input.approvalId);
    if (current?.tenantId !== input.tenantId) {
      throw new RunStoreError("tool_approval_not_found");
    }
    let approval: ToolApprovalState;
    try {
      approval = decideToolApproval(current, {
        ...input.decision,
        expectedRevision: input.expectedRevision,
      });
    } catch (error) {
      throw normalizeToolApprovalError(error);
    }
    validateApprovalRunCommit(approval, input.commit, "decide");
    const record = requiredQueueRecord(this.#workItems, approval.workItemId);
    if (
      !isWorkItem(record.item) ||
      record.item.tenantId !== approval.tenantId ||
      record.item.runId !== approval.runId ||
      record.status !== "pending" ||
      record.leaseOwnerId !== null ||
      record.leaseId !== null ||
      record.leaseExpiresAtMs !== null
    ) {
      throw new RunStoreError("approval_work_item_not_held");
    }

    const run = this.#commitRun(input.commit);
    this.#toolApprovals.set(approval.approvalId, clone(approval));
    record.availableAtMs = now;
    return clone({ approval, run });
  }

  async expireToolApproval(
    input: ExpireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    const now = readLeaseClock(this.#clock);
    const current = this.#toolApprovals.get(input.approvalId);
    if (current?.tenantId !== input.tenantId) {
      throw new RunStoreError("tool_approval_not_found");
    }
    this.#validateExecutionLease(
      current.tenantId,
      current.runId,
      input.lease,
      now,
    );
    let approval: ToolApprovalState;
    try {
      approval = terminateToolApproval(current, {
        status: "expired",
        expectedRevision: input.expectedRevision,
        reasonCode: "decision_deadline_reached",
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      throw normalizeToolApprovalError(error);
    }
    validateApprovalRunCommit(approval, input.commit, "decide");
    const run = this.#commitRun(input.commit);
    this.#toolApprovals.set(approval.approvalId, clone(approval));
    return clone({ approval, run });
  }

  async supersedeToolApproval(
    input: SupersedeToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    const now = readLeaseClock(this.#clock);
    const current = this.#toolApprovals.get(input.approvalId);
    if (current?.tenantId !== input.tenantId) {
      throw new RunStoreError("tool_approval_not_found");
    }
    this.#validateExecutionLease(
      current.tenantId,
      current.runId,
      input.lease,
      now,
    );
    let approval: ToolApprovalState;
    try {
      approval = terminateToolApproval(current, {
        status: "superseded",
        expectedRevision: input.expectedRevision,
        reasonCode: "run_cancel_requested",
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      throw normalizeToolApprovalError(error);
    }
    validateApprovalRunCommit(approval, input.commit, "decide");
    const run = this.#commitRun(input.commit);
    this.#toolApprovals.set(approval.approvalId, clone(approval));
    return clone({ approval, run });
  }

  async replaceToolApproval(
    input: ReplaceToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    validateRequiredApproval(input.replacement);
    validateQueueRetry({
      ...input.lease,
      retryAfterMs: input.retryAfterMs,
      reasonCode: "tool_approval_required",
    });
    const now = readLeaseClock(this.#clock);
    const current = this.#toolApprovals.get(input.current.approvalId);
    if (current?.tenantId !== input.current.tenantId) {
      throw new RunStoreError("tool_approval_not_found");
    }
    const existingId = this.#toolApprovalActions.get(
      toolApprovalActionKey(input.replacement),
    );
    if (existingId !== undefined) {
      const existing = this.#toolApprovals.get(existingId)!;
      validateToolApprovalReplacementReplay(current, existing, input);
      const run = this.#commitRun(input.commit);
      return clone({ approval: existing, run });
    }
    this.#validateExecutionLease(
      current.tenantId,
      current.runId,
      input.lease,
      now,
    );
    validateToolApprovalReplacement(current, input);
    const receipt = this.#toolExecutionReceipts.get(
      input.replacement.receiptId,
    );
    validateApprovalReceiptBinding(input.replacement, receipt);
    if (
      this.#toolApprovals.has(input.replacement.approvalId) ||
      this.#toolApprovalActions.has(toolApprovalActionKey(input.replacement))
    ) {
      throw new RunStoreError("tool_approval_conflict");
    }
    let superseded: ToolApprovalState;
    try {
      superseded = terminateToolApproval(current, {
        status: "superseded",
        expectedRevision: input.current.expectedRevision,
        reasonCode: "action_replaced",
        occurredAt: input.occurredAt,
      });
    } catch (error) {
      throw normalizeToolApprovalError(error);
    }
    validateToolApprovalReplacementCommit(
      superseded,
      input.replacement,
      input.commit,
    );
    const record = requiredQueueRecord(
      this.#workItems,
      input.replacement.workItemId,
    );
    validateRecordLease(record, input.lease, now);
    const run = this.#commitRun(input.commit);
    this.#toolApprovals.set(current.approvalId, clone(superseded));
    this.#toolApprovals.set(
      input.replacement.approvalId,
      clone(input.replacement),
    );
    this.#toolApprovalActions.set(
      toolApprovalActionKey(input.replacement),
      input.replacement.approvalId,
    );
    retry(
      this.#workItems,
      input.replacement.workItemId,
      { ...input.lease, retryAfterMs: input.retryAfterMs },
      now,
    );
    return clone({ approval: input.replacement, run });
  }

  async loadToolExecutionReceiptByAction(
    locator: ToolExecutionActionLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    validateToolExecutionActionLocator(locator);
    const receiptId = this.#toolExecutionActions.get(
      toolExecutionActionKey(locator),
    );
    return receiptId === undefined
      ? null
      : this.loadToolExecutionReceipt({ ...locator, receiptId });
  }

  async prepareToolExecution(
    input: PrepareToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    validatePrepareToolExecutionInput(input);
    const { receipt } = input;
    this.#validateExecutionLease(receipt.tenantId, receipt.runId, input.lease);
    const step = this.#executionAuthority.loadStep(receipt);
    const attempt = this.#executionAuthority.loadAttempt(receipt);
    if (
      step?.currentAttemptId !== receipt.attemptId ||
      attempt?.status !== "running" ||
      attempt.workItemId !== receipt.workItemId
    ) {
      throw new RunStoreError("tool_receipt_attempt_not_current");
    }
    const actionKey = toolExecutionActionKey(receipt);
    const idempotencyKey = toolExecutionIdempotencyKey(receipt);
    if (this.#toolExecutionReceipts.has(receipt.receiptId)) {
      throw new RunStoreError("tool_receipt_id_conflict");
    }
    if (this.#toolExecutionActions.has(actionKey)) {
      throw new RunStoreError("tool_action_digest_conflict");
    }
    if (this.#toolExecutionIdempotency.has(idempotencyKey)) {
      throw new RunStoreError("tool_idempotency_conflict");
    }
    this.#toolExecutionReceipts.set(receipt.receiptId, clone(receipt));
    this.#toolExecutionActions.set(actionKey, receipt.receiptId);
    this.#toolExecutionIdempotency.set(idempotencyKey, receipt.receiptId);
    return clone(receipt);
  }

  async transitionToolExecution(
    input: TransitionToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    validateTransitionToolExecutionInput(input);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    const current = this.#toolExecutionReceipts.get(input.receiptId);
    if (current === undefined) {
      throw new RunStoreError("tool_receipt_not_found");
    }
    const next = applyToolExecutionTransition(current, input);
    this.#toolExecutionReceipts.set(next.receiptId, clone(next));
    return clone(next);
  }

  async commitToolExecutionCompletion(
    input: CommitToolExecutionCompletionInput,
  ): Promise<CommitToolExecutionCompletionResult> {
    const runId = validateToolExecutionCompletionInput(input);
    this.#validateExecutionLease(input.commit.tenantId, runId, input.lease);
    const current = this.#toolExecutionReceipts.get(input.receipt.receiptId);
    if (current === undefined) {
      throw new RunStoreError("tool_receipt_not_found");
    }
    const completed = input.commit.events.find(
      (event) => event.type === "tool.completed",
    );
    if (
      current.stepId !== input.attempt.stepId ||
      completed?.type !== "tool.completed" ||
      current.call.segmentId !== completed.data.segmentId ||
      current.call.callId !== completed.data.callId ||
      current.call.kind !== completed.data.kind ||
      current.call.name !== completed.data.name
    ) {
      throw new RunStoreError("tool_completion_attempt_mismatch");
    }
    const receiptKey = stableJson([
      input.commit.idempotency.scope,
      input.commit.idempotency.key,
    ]);
    const prior = this.#idempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.commit.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const replay = validateToolExecutionCompletionReplay(
        input,
        current,
        this.#executionAuthority.loadStep(current),
        this.#executionAuthority.loadAttempt(current),
      );
      return clone({
        run: { ...prior.result, disposition: "replayed" },
        receipt: current,
        ...replay,
      });
    }
    const currentRun = this.#runs.get(runId) ?? null;
    if (currentRun === null) throw new RunStoreError("run_not_found");
    const currentGoal = this.#threadGoals.get(currentRun.threadId) ?? null;
    const nextGoal = applyToolCompletionGoalMutation(
      currentGoal,
      input,
      currentRun,
    );
    const preparedGoal = this.#prepareThreadGoalWrite(
      currentGoal,
      nextGoal,
      input.goal,
    );
    const receipt = applyToolExecutionTransition(current, {
      tenantId: input.receipt.tenantId,
      runId: input.receipt.runId,
      receiptId: input.receipt.receiptId,
      lease: input.lease,
      expectedRevision: input.receipt.expectedRevision,
      transition: {
        kind: "complete",
        occurredAt: input.receipt.resolvedAt,
        providerReceiptId: input.receipt.providerReceiptId,
        result: input.receipt.result,
      },
    });
    const execution = this.#executionAuthority.finish(
      input.commit.tenantId,
      runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      { ...input.attempt, status: "completed", checkpointDigest: null },
    );
    const run = this.#commitRun(input.commit, input.history);
    if (run.disposition === "committed" && nextGoal !== currentGoal) {
      this.#applyThreadGoalWrite(nextGoal, preparedGoal);
    }
    this.#toolExecutionReceipts.set(receipt.receiptId, clone(receipt));
    this.#executionAuthority.apply(execution);
    return clone({
      run,
      receipt,
      step: execution.step,
      attempt: execution.attempt,
    });
  }

  async commitToolExecutionUnknownOutcome(
    input: CommitToolExecutionUnknownOutcomeInput,
  ): Promise<CommitToolExecutionUnknownOutcomeResult> {
    const runId = validateToolExecutionUnknownOutcomeInput(input);
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(
      input.commit.tenantId,
      runId,
      input.lease,
      now,
    );
    const current = this.#toolExecutionReceipts.get(input.receipt.receiptId);
    if (current === undefined) {
      throw new RunStoreError("tool_receipt_not_found");
    }
    const receipt = applyToolExecutionUnknownOutcome(current, input);
    const execution = this.#executionAuthority.finish(
      input.commit.tenantId,
      runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      {
        ...input.attempt,
        status: "failed",
        checkpointDigest: null,
        failure: { code: "tool_outcome_unknown", retryable: true },
      },
    );
    const run = this.#commitRun(input.commit);
    retry(
      this.#workItems,
      input.lease.workItemId,
      { ...input.lease, retryAfterMs: input.retryAfterMs },
      now,
    );
    this.#toolExecutionReceipts.set(receipt.receiptId, clone(receipt));
    this.#executionAuthority.apply(execution);
    return clone({
      run,
      receipt,
      step: execution.step,
      attempt: execution.attempt,
    });
  }

  async retryRunAttempt(
    input: RetryRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    validateRetryRunAttemptInput(input);
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease, now);
    const result = this.#executionAuthority.finish(
      input.tenantId,
      input.runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      { ...input.attempt, status: "failed" },
    );
    retry(
      this.#workItems,
      input.lease.workItemId,
      { ...input.lease, retryAfterMs: input.retryAfterMs },
      now,
    );
    this.#executionAuthority.apply(result);
    return clone(result);
  }

  async completeRunAttempt(
    input: CompleteRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    validateCompleteRunAttemptInput(input);
    this.#validateExecutionLease(input.tenantId, input.runId, input.lease);
    const result = this.#executionAuthority.finish(
      input.tenantId,
      input.runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      { ...input.attempt, status: "completed" },
    );
    this.#executionAuthority.apply(result);
    return clone(result);
  }

  async loadThreadContinuation(
    locator: ThreadContinuationLocator,
  ): Promise<ThreadContinuationCheckpoint | null> {
    validateThreadContinuationLocator(locator);
    const checkpoint = this.#threadContinuations.get(continuationKey(locator));
    return checkpoint === undefined ? null : clone(checkpoint);
  }

  async loadThreadModelState(
    locator: Readonly<{ tenantId: string; threadId: string }>,
  ): Promise<ThreadModelState | null> {
    requireNonEmpty(locator.tenantId, "tenant_id_invalid");
    requireNonEmpty(locator.threadId, "thread_id_invalid");
    const state = this.#threadModelStates.get(
      stableJson([locator.tenantId, locator.threadId]),
    );
    return state === undefined ? null : clone(state);
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    return this.#commitRun(input);
  }

  #commitRun(
    input: CommitRunInput,
    history: ModelHistoryAppend | null = null,
  ): CommitRunResult {
    const runId = validateCommitInput(input);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const fingerprint = input.idempotency.requestFingerprint;
    const prior = this.#idempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== fingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return clone({ ...prior.result, disposition: "replayed" });
    }

    const current = this.#runs.get(runId) ?? null;
    if (
      current === null &&
      this.#pendingModelProviderSettings.has(input.tenantId)
    ) {
      throw new RunStoreError("model_provider_settings_switch_pending");
    }
    if (current !== null && current.tenantId !== input.tenantId) {
      throw new RunStoreError("tenant_id_mismatch");
    }
    const actualRevision = current?.revision ?? 0;
    if (input.expectedRevision !== actualRevision) {
      throw new RunStoreError("revision_conflict");
    }

    validateEvents(input.events, runId, (eventId) =>
      this.#eventIds.has(eventId),
    );
    let next = current;
    for (const event of input.events) {
      if (event.identity.runId !== runId) {
        throw new RunStoreError("run_id_mismatch");
      }
      next = reduceRunLifecycleEvent(next, event);
    }
    if (next === null) {
      throw new RunStoreError("events_empty");
    }
    const thread = this.#threads.get(next.threadId);
    if (thread?.tenantId !== next.tenantId || thread.spaceId !== next.spaceId) {
      throw new RunStoreError("thread_not_found");
    }
    if (current === null && thread.status !== "active") {
      throw new RunStoreError("thread_not_active");
    }
    if (input.threadAdmission !== undefined) {
      validateManualCompactionAdmissionState(input, {
        currentRun: current,
        nextRun: next,
        thread,
        historySequence:
          this.#modelHistory.get(next.threadId)?.at(-1)?.sequence ?? 0,
        goal: this.#threadGoals.get(next.threadId) ?? null,
        hasActiveRun: [...this.#runs.values()].some(
          (run) =>
            run.tenantId === next.tenantId &&
            run.threadId === next.threadId &&
            run.status !== "completed" &&
            run.status !== "failed" &&
            run.status !== "canceled",
        ),
      });
    }
    if (history !== null) {
      if (history.items.some((item) => item.runId !== runId)) {
        throw new RunStoreError("model_history_run_id_mismatch");
      }
      validateModelHistoryAppend(
        history,
        { tenantId: next.tenantId, threadId: next.threadId },
        this.#modelHistory.get(next.threadId) ?? [],
        (itemId) => this.#modelHistoryItemIds.has(itemId),
      );
    }
    validateRunHistoryCorrelation(input.events, history);
    validateOutbox(input.outbox, runId, input.tenantId, (messageId) =>
      this.#outbox.has(messageId),
    );
    validateWorkItems(
      input.workItems,
      runId,
      input.tenantId,
      input.events.at(-1)?.sequence ?? 0,
      (workItemId) => this.#workItems.has(workItemId),
      input.events.length === 1 &&
        input.events[0]?.type === "run.cancel.requested" &&
        next.purpose === "workflow"
        ? "workflowCancel"
        : input.threadAdmission === undefined
          ? "default"
          : "manualCompaction",
    );

    const committedEvents = clone(input.events);
    const committedOutbox = clone(input.outbox);
    const committedWorkItems = clone(input.workItems);
    const committedState = clone(next);
    const outboxRecords = committedOutbox.map(
      (message) =>
        [message.messageId, queueRecord(message, message.createdAt)] as const,
    );
    const workItemRecords = committedWorkItems.map(
      (workItem) =>
        [
          workItem.workItemId,
          queueRecord(workItem, workItem.createdAt),
        ] as const,
    );
    const result: CommitRunResult = {
      disposition: "committed",
      state: committedState,
      events: committedEvents,
      outbox: committedOutbox,
      workItems: committedWorkItems,
    };

    this.#runs.set(runId, committedState);
    this.#events.set(runId, [
      ...(this.#events.get(runId) ?? []),
      ...committedEvents,
    ]);
    for (const event of committedEvents) {
      this.#eventIds.add(event.eventId);
    }
    for (const [messageId, record] of outboxRecords) {
      this.#outbox.set(messageId, record);
    }
    for (const [workItemId, record] of workItemRecords) {
      this.#workItems.set(workItemId, record);
    }
    if (history !== null) {
      this.#appendModelHistory(next.threadId, history.items);
    }
    this.#idempotency.set(receiptKey, {
      tenantId: input.tenantId,
      fingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async commitLeasedRun(input: CommitLeasedRunInput): Promise<CommitRunResult> {
    this.#validateExecutionLease(
      input.commit.tenantId,
      input.commit.events[0]?.identity.runId ?? "",
      input.lease,
    );
    return this.#commitRun(input.commit, input.history);
  }

  async commitLeasedRunTerminal(
    input: CommitLeasedRunTerminalInput,
  ): Promise<CommitLeasedRunTerminalResult> {
    const runId = validateLeasedRunTerminalInput(input);
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(
      input.commit.tenantId,
      runId,
      input.lease,
      now,
    );
    const currentRun = this.#runs.get(runId) ?? null;
    if (currentRun === null) throw new RunStoreError("run_not_found");
    const currentGoal = this.#threadGoals.get(currentRun.threadId) ?? null;
    const nextGoal = isTerminalRunStatus(currentRun.status)
      ? currentGoal
      : applyRunTerminalGoalMutation(
          currentGoal,
          input.goal,
          currentRun,
          input.commit.events.at(-1) as Extract<
            RunLifecycleEvent,
            { type: "run.failed" | "run.canceled" }
          >,
          input.commit.events,
        );
    if (input.history !== null) {
      validateModelHistoryAppend(
        input.history,
        { tenantId: currentRun.tenantId, threadId: currentRun.threadId },
        this.#modelHistory.get(currentRun.threadId) ?? [],
        (itemId) => this.#modelHistoryItemIds.has(itemId),
      );
    }
    const preparedGoal = this.#prepareThreadGoalWrite(
      currentGoal,
      nextGoal,
      input.goal,
    );
    const execution =
      input.attempt === null
        ? null
        : this.#executionAuthority.finish(
            input.commit.tenantId,
            runId,
            input.lease.workItemId,
            input.lease.leaseEpoch,
            input.attempt,
          );
    const run = this.#commitRun(input.commit, input.history);
    settle(this.#workItems, input.lease.workItemId, input.lease, now);
    if (run.disposition === "committed" && nextGoal !== currentGoal) {
      this.#applyThreadGoalWrite(nextGoal, preparedGoal);
    }
    if (execution !== null) {
      this.#executionAuthority.apply(execution);
    }
    return clone({
      run,
      goalState: run.disposition === "committed" ? nextGoal : currentGoal,
      step: execution?.step ?? null,
      attempt: execution?.attempt ?? null,
    });
  }

  async commitContextCompaction(
    input: CommitContextCompactionInput,
  ): Promise<CommitContextCompactionResult> {
    const runId = validateContextCompactionInput(input);
    const receiptKey = stableJson([
      input.commit.idempotency.scope,
      input.commit.idempotency.key,
    ]);
    const prior = this.#idempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.commit.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const replay = validateContextCompactionReplay(
        input,
        this.#executionAuthority.loadStep({
          tenantId: input.commit.tenantId,
          runId,
          stepId: input.attempt.stepId,
        }),
        this.#executionAuthority.loadAttempt({
          tenantId: input.commit.tenantId,
          runId,
          ...input.attempt,
        }),
      );
      return clone({
        run: { ...prior.result, disposition: "replayed" },
        ...replay,
      });
    }
    validateContextCompactionRunAuthority(input, this.#runs.get(runId) ?? null);
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(
      input.commit.tenantId,
      runId,
      input.lease,
      now,
    );
    const execution = this.#executionAuthority.finish(
      input.commit.tenantId,
      runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      { ...input.attempt, status: "completed", checkpointDigest: null },
    );
    const run = this.#commitRun(input.commit, input.history);
    if (input.completion === "completeRun") {
      settle(this.#workItems, input.lease.workItemId, input.lease, now);
    }
    this.#executionAuthority.apply(execution);
    return clone({ run, step: execution.step, attempt: execution.attempt });
  }

  async commitAssistantSampleContinuation(
    input: CommitAssistantSampleContinuationInput,
  ): Promise<CommitAssistantSampleContinuationResult> {
    const runId = validateAssistantSampleContinuationInput(input);
    const receiptKey = stableJson([
      input.commit.idempotency.scope,
      input.commit.idempotency.key,
    ]);
    const prior = this.#idempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.commit.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const step = this.#executionAuthority.loadStep({
        tenantId: input.commit.tenantId,
        runId,
        stepId: input.attempt.stepId,
      });
      const attempt = this.#executionAuthority.loadAttempt({
        tenantId: input.commit.tenantId,
        runId,
        ...input.attempt,
      });
      if (step === null || attempt?.status !== "completed") {
        throw new RunStoreError("assistant_sample_replay_conflict");
      }
      return clone({
        run: { ...prior.result, disposition: "replayed" },
        step,
        attempt,
      });
    }
    const now = readLeaseClock(this.#clock);
    this.#validateExecutionLease(
      input.commit.tenantId,
      runId,
      input.lease,
      now,
    );
    const execution =
      input.continuation === null
        ? this.#executionAuthority.finish(
            input.commit.tenantId,
            runId,
            input.lease.workItemId,
            input.lease.leaseEpoch,
            { ...input.attempt, status: "completed" },
          )
        : this.#executionAuthority.finishWithCheckpoint(
            input.commit.tenantId,
            runId,
            input.lease.workItemId,
            input.lease.leaseEpoch,
            { ...input.attempt, status: "completed" },
            input.continuation.checkpoint,
          );
    const run = this.#commitRun(input.commit, input.history);
    this.#executionAuthority.apply(execution);
    this.#threadModelStates.set(
      stableJson([input.modelState.tenantId, input.modelState.threadId]),
      clone(input.modelState),
    );
    if (input.continuation !== null) {
      this.#threadContinuations.set(
        continuationKey(input.continuation),
        clone(input.continuation),
      );
    }
    return clone({
      run,
      step: execution.step,
      attempt: execution.attempt,
    });
  }

  async commitTextRunCompletion(
    input: CommitTextRunCompletionInput,
  ): Promise<CommitTextRunCompletionResult> {
    const { runId, threadId } = validateTextRunCompletionInput(input);
    const completionHistory = textCompletionHistoryAppend(input);
    const now = readLeaseClock(this.#clock);
    const receiptKey = stableJson([
      input.idempotency.scope,
      input.idempotency.key,
    ]);
    const prior = this.#executionIdempotency.get(receiptKey);
    if (prior !== undefined) {
      if (prior.tenantId !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      return clone({ ...prior.result, disposition: "replayed" });
    }
    this.#validateExecutionLease(input.tenantId, runId, input.lease, now);

    const currentRun = this.#runs.get(runId) ?? null;
    const currentThread = this.#threads.get(threadId) ?? null;
    if (
      currentRun?.tenantId !== input.tenantId ||
      currentThread?.tenantId !== input.tenantId ||
      currentRun.threadId !== threadId ||
      currentRun.spaceId !== currentThread.spaceId ||
      currentRun.agentVersionId !== input.continuation.agentVersionId
    ) {
      throw new RunStoreError("execution_authority_mismatch");
    }
    if (
      currentRun.revision !== input.run.expectedRevision ||
      currentThread.revision !== input.thread.expectedRevision
    ) {
      throw new RunStoreError("revision_conflict");
    }
    validateTextRunPlanCorrelation(input, currentRun);
    validateEvents(input.run.events, runId, (eventId) =>
      this.#eventIds.has(eventId),
    );
    validateThreadEvents(input.thread.events, threadId, (eventId) =>
      this.#threadEventIds.has(eventId),
    );
    validateMessages(
      input.thread.messages,
      input.thread.events,
      threadId,
      input.tenantId,
      (messageId) => this.#messageIds.has(messageId),
    );
    validateOutbox(input.run.outbox, runId, input.tenantId, (messageId) =>
      this.#outbox.has(messageId),
    );
    if (input.history.items.some((item) => item.runId !== runId)) {
      throw new RunStoreError("model_history_run_id_mismatch");
    }
    validateModelHistoryAppend(
      completionHistory,
      { tenantId: input.tenantId, threadId },
      this.#modelHistory.get(threadId) ?? [],
      (itemId) => this.#modelHistoryItemIds.has(itemId),
    );

    let nextRun: RunState | null = currentRun;
    for (const event of input.run.events) {
      nextRun = reduceRunLifecycleEvent(nextRun, event);
    }
    let nextThread: ThreadState | null = currentThread;
    for (const event of input.thread.events) {
      nextThread = reduceThreadLifecycleEvent(nextThread, event);
    }
    if (nextRun === null || nextThread === null) {
      throw new RunStoreError("text_completion_state_invalid");
    }
    const currentGoal = this.#threadGoals.get(threadId) ?? null;
    const nextGoal = applyRunTerminalGoalMutation(
      currentGoal,
      input.goal,
      currentRun,
      input.run.events.at(-1) as Extract<
        RunLifecycleEvent,
        { type: "run.completed" }
      >,
      input.run.events,
    );
    const nextContinuationRun = reduceGoalContinuationRun(
      input.goalContinuation,
      nextGoal,
      currentRun,
      input.run.events.at(-1)!.occurredAt,
      input.history.items.at(-1)!.sequence + 1,
    );
    if (nextContinuationRun !== null) {
      if (this.#runs.has(nextContinuationRun.runId)) {
        throw new RunStoreError("goal_continuation_run_conflict");
      }
      validateEvents(
        input.goalContinuation!.events,
        nextContinuationRun.runId,
        (eventId) => this.#eventIds.has(eventId),
      );
      validateOutbox(
        input.goalContinuation!.outbox,
        nextContinuationRun.runId,
        input.tenantId,
        (messageId) => this.#outbox.has(messageId),
      );
      validateWorkItems(
        input.goalContinuation!.workItems,
        nextContinuationRun.runId,
        input.tenantId,
        1,
        (workItemId) => this.#workItems.has(workItemId),
        "goalContinuation",
      );
    }
    const preparedGoal = this.#prepareThreadGoalWrite(
      currentGoal,
      nextGoal,
      input.goal,
    );
    const execution = this.#executionAuthority.finish(
      input.tenantId,
      runId,
      input.lease.workItemId,
      input.lease.leaseEpoch,
      { ...input.attempt, status: "completed" },
    );
    settle(this.#workItems, input.lease.workItemId, input.lease, now);

    const result: CommitTextRunCompletionResult = {
      disposition: "committed",
      runState: clone(nextRun),
      threadState: clone(nextThread),
      goalState: nextGoal === null ? null : clone(nextGoal),
      goalContinuation:
        nextContinuationRun === null
          ? null
          : {
              runState: clone(nextContinuationRun),
              historyItem: clone(input.goalContinuation!.historyItem),
              runEvents: clone(input.goalContinuation!.events),
              outbox: clone(input.goalContinuation!.outbox),
              workItems: clone(input.goalContinuation!.workItems),
            },
      runEvents: clone(input.run.events),
      threadEvents: clone(input.thread.events),
      messages: clone(input.thread.messages),
      historyItems: clone(completionHistory.items),
      outbox: clone(input.run.outbox),
      continuation: continuationRecord(input),
      modelState: clone(input.modelState),
      step: clone(execution.step),
      attempt: clone(execution.attempt),
    };
    this.#executionAuthority.apply(execution);
    this.#runs.set(runId, clone(nextRun));
    this.#events.set(runId, [
      ...(this.#events.get(runId) ?? []),
      ...clone(input.run.events),
    ]);
    for (const event of input.run.events) {
      this.#eventIds.add(event.eventId);
    }
    this.#threads.set(threadId, clone(nextThread));
    this.#applyThreadGoalWrite(nextGoal, preparedGoal);
    this.#threadEvents.set(threadId, [
      ...(this.#threadEvents.get(threadId) ?? []),
      ...clone(input.thread.events),
    ]);
    for (const event of input.thread.events) {
      this.#threadEventIds.add(event.eventId);
    }
    this.#messages.set(threadId, [
      ...(this.#messages.get(threadId) ?? []),
      ...clone(input.thread.messages),
    ]);
    for (const message of input.thread.messages) {
      this.#messageIds.add(message.messageId);
    }
    this.#appendModelHistory(threadId, completionHistory.items);
    for (const message of input.run.outbox) {
      this.#outbox.set(
        message.messageId,
        queueRecord(message, message.createdAt),
      );
    }
    if (result.goalContinuation !== null) {
      const continuation = result.goalContinuation;
      this.#runs.set(continuation.runState.runId, clone(continuation.runState));
      this.#events.set(
        continuation.runState.runId,
        clone([...continuation.runEvents]),
      );
      for (const event of continuation.runEvents) {
        this.#eventIds.add(event.eventId);
      }
      for (const message of continuation.outbox) {
        this.#outbox.set(
          message.messageId,
          queueRecord(message, message.createdAt),
        );
      }
      for (const workItem of continuation.workItems) {
        this.#workItems.set(
          workItem.workItemId,
          queueRecord(workItem, workItem.createdAt),
        );
      }
    }
    const continuationKeyValue = continuationKey({
      tenantId: input.tenantId,
      threadId,
      ...input.continuation,
    });
    this.#threadContinuations.delete(continuationKeyValue);
    if (result.continuation !== null) {
      this.#threadContinuations.set(
        continuationKeyValue,
        clone(result.continuation),
      );
    }
    validateThreadModelState(input.modelState);
    this.#threadModelStates.set(
      stableJson([input.tenantId, threadId]),
      clone(input.modelState),
    );
    this.#executionIdempotency.set(receiptKey, {
      tenantId: input.tenantId,
      fingerprint: input.idempotency.requestFingerprint,
      result: clone(result),
    });
    return clone(result);
  }

  async listRunEvents(
    locator: RunLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly RunLifecycleEvent[]> {
    validateEventPage(locator, afterSequence, limit);
    const state = this.#runs.get(locator.runId);
    if (state?.tenantId !== locator.tenantId) {
      return [];
    }
    return clone(
      (this.#events.get(locator.runId) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .slice(0, limit),
    );
  }

  async listPendingOutbox(limit: number): Promise<readonly OutboxMessage[]> {
    validateLimit(limit);
    return pendingItems(this.#outbox, readLeaseClock(this.#clock), limit);
  }

  async claimNextOutbox(input: QueueClaimInput): Promise<OutboxClaim | null> {
    validateQueueClaim(input);
    const claimed = claimNext(this.#outbox, input, readLeaseClock(this.#clock));
    return claimed === null
      ? null
      : { message: clone(claimed.item), lease: claimed.lease };
  }

  async acknowledgeOutbox(input: OutboxLeaseInput): Promise<void> {
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    settle(this.#outbox, input.messageId, input, readLeaseClock(this.#clock));
  }

  async retryOutbox(input: OutboxRetryInput): Promise<void> {
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    validateQueueRetry(input);
    retry(this.#outbox, input.messageId, input, readLeaseClock(this.#clock));
  }

  async listPendingWorkItems(limit: number): Promise<readonly WorkItem[]> {
    validateLimit(limit);
    return pendingItems(this.#workItems, readLeaseClock(this.#clock), limit);
  }

  async claimNextWorkItem(
    input: QueueClaimInput,
  ): Promise<WorkItemClaim | null> {
    validateQueueClaim(input);
    const claimed = claimNext(
      this.#workItems,
      input,
      readLeaseClock(this.#clock),
    );
    return claimed === null
      ? null
      : { workItem: clone(claimed.item), lease: claimed.lease };
  }

  async renewWorkItemLease(input: WorkItemRenewInput): Promise<QueueLease> {
    validateQueueClaim(input);
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    const now = readLeaseClock(this.#clock);
    const record = requiredQueueRecord(this.#workItems, input.workItemId);
    validateRecordLease(record, input, now);
    const expiry = leaseExpiry(now, input.leaseDurationMs);
    record.leaseExpiresAtMs = expiry.expiresAtMs;
    return {
      ownerId: input.ownerId,
      leaseId: input.leaseId,
      epoch: input.leaseEpoch,
      expiresAt: expiry.expiresAt,
    };
  }

  async completeWorkItem(input: WorkItemLeaseInput): Promise<void> {
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    settle(
      this.#workItems,
      input.workItemId,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async retryWorkItem(input: WorkItemRetryInput): Promise<void> {
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    validateQueueRetry(input);
    retry(
      this.#workItems,
      input.workItemId,
      input,
      readLeaseClock(this.#clock),
    );
  }

  #appendModelHistory(
    threadId: string,
    items: readonly ModelHistoryItem[],
  ): void {
    if (items.length === 0) {
      return;
    }
    this.#modelHistory.set(threadId, [
      ...(this.#modelHistory.get(threadId) ?? []),
      ...clone(items),
    ]);
    for (const item of items) {
      this.#modelHistoryItemIds.add(item.itemId);
    }
  }

  #prepareThreadGoalWrite(
    current: ThreadGoal | null,
    next: ThreadGoal | null,
    mutation: TurnStartGoalMutation,
  ): Readonly<{ threadId: string; event: ThreadGoalEvent }> | null {
    if (stableJson(current) === stableJson(next)) return null;
    if (mutation.kind === "keep") {
      throw new RunStoreError("goal_mutation_invalid");
    }
    const threadId = next?.threadId ?? current?.threadId;
    const tenantId = next?.tenantId ?? current?.tenantId;
    if (threadId === undefined || tenantId === undefined) return null;
    const occurredAt =
      next?.updatedAt ??
      (mutation.kind === "clear" ? mutation.occurredAt : undefined);
    if (occurredAt === undefined) {
      throw new RunStoreError("goal_event_timestamp_invalid");
    }
    const events = this.#threadGoalEvents.get(threadId) ?? [];
    const event = createThreadGoalEvent({
      current,
      next,
      lastSequence: events.at(-1)?.sequence ?? 0,
      occurredAt,
      tenantId,
      threadId,
    });
    return event === null ? null : { threadId, event };
  }

  #applyThreadGoalWrite(
    next: ThreadGoal | null,
    prepared: Readonly<{ threadId: string; event: ThreadGoalEvent }> | null,
  ): void {
    if (prepared === null) return;
    const { threadId, event } = prepared;
    if (next === null) {
      this.#threadGoals.delete(threadId);
    } else {
      this.#threadGoals.set(threadId, clone(next));
    }
    this.#threadGoalEvents.set(threadId, [
      ...(this.#threadGoalEvents.get(threadId) ?? []),
      clone(event),
    ]);
  }

  #validateExecutionLease(
    tenantId: string,
    runId: string,
    input: WorkItemLeaseInput,
    now = readLeaseClock(this.#clock),
  ): void {
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    const record = requiredQueueRecord(this.#workItems, input.workItemId);
    if (
      !isWorkItem(record.item) ||
      record.item.tenantId !== tenantId ||
      record.item.runId !== runId
    ) {
      throw new RunStoreError("work_item_scope_mismatch");
    }
    validateRecordLease(record, input, now);
  }
}

function providerReceiptKey(
  input: { tenantId: string; idempotencyKey: string },
  phase: "prepare" | "finalize" | "abort" | "expire",
): string {
  return stableJson([input.tenantId, phase, input.idempotencyKey]);
}

function providerOperationKey(input: {
  tenantId: string;
  operationId: string;
}): string {
  return stableJson([input.tenantId, input.operationId]);
}

function validateReleaseActivationInput(input: {
  bundle: AgentVersionReleaseBundle;
  activation: ActiveAgentVersionRelease["activation"];
}): void {
  if (
    input.activation.tenantId !== input.bundle.tenantId ||
    input.activation.releaseId !== input.bundle.releaseId
  ) {
    throw new RunStoreError("agent_version_release_activation_mismatch");
  }
}

function continuationRecord(
  input: CommitTextRunCompletionInput,
): ThreadContinuationCheckpoint | null {
  if (input.continuation.checkpoint === null) {
    return null;
  }
  const historyItem = input.history.items[0];
  if (historyItem?.type !== "message" || historyItem.role !== "assistant") {
    throw new RunStoreError("text_completion_history_missing");
  }
  return {
    tenantId: input.tenantId,
    threadId: historyItem.threadId,
    agentVersionId: input.continuation.agentVersionId,
    adapterName: input.continuation.adapterName,
    adapterVersion: input.continuation.adapterVersion,
    modelId: input.continuation.modelId,
    throughHistorySequence: historyItem.sequence,
    contextRevision: input.continuation.contextRevision,
    checkpoint: clone(input.continuation.checkpoint),
    updatedAt: historyItem.createdAt,
  };
}

function continuationKey(locator: ThreadContinuationLocator): string {
  return stableJson([
    locator.tenantId,
    locator.threadId,
    locator.agentVersionId,
    locator.adapterName,
    locator.adapterVersion,
    locator.modelId,
  ]);
}

function compareThreadsNewestFirst(
  left: ThreadState,
  right: ThreadState,
): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.threadId.localeCompare(left.threadId)
  );
}

function isBeforeThreadCursor(
  thread: ThreadState,
  cursor: ThreadListQuery["before"],
): boolean {
  return (
    cursor === null ||
    thread.updatedAt < cursor.updatedAt ||
    (thread.updatedAt === cursor.updatedAt && thread.threadId < cursor.threadId)
  );
}

function compareRunsNewestFirst(left: RunState, right: RunState): number {
  return (
    right.updatedAt.localeCompare(left.updatedAt) ||
    right.runId.localeCompare(left.runId)
  );
}

function isBeforeRunCursor(
  run: RunState,
  cursor: ThreadRunListQuery["before"],
): boolean {
  return (
    cursor === null ||
    run.updatedAt < cursor.updatedAt ||
    (run.updatedAt === cursor.updatedAt && run.runId < cursor.runId)
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function toolExecutionActionKey(locator: ToolExecutionActionLocator): string {
  return stableJson([locator.tenantId, locator.runId, locator.actionDigest]);
}

function toolExecutionIdempotencyKey(
  receipt: ToolExecutionReceiptState,
): string {
  return stableJson([receipt.tenantId, receipt.idempotencyKey]);
}

function toolApprovalActionKey(locator: ToolApprovalActionLocator): string {
  return stableJson([locator.tenantId, locator.runId, locator.actionDigest]);
}

function validateRequiredApproval(approval: ToolApprovalState): void {
  try {
    validateToolApprovalState(approval);
  } catch (error) {
    throw normalizeToolApprovalError(error);
  }
  if (approval.status !== "required") {
    throw new RunStoreError("tool_approval_not_required");
  }
}

function validateApprovalReceiptBinding(
  approval: ToolApprovalState,
  receipt: ToolExecutionReceiptState | undefined,
): void {
  if (
    receipt === undefined ||
    receipt.tenantId !== approval.tenantId ||
    receipt.runId !== approval.runId ||
    receipt.receiptId !== approval.receiptId ||
    receipt.workItemId !== approval.workItemId ||
    receipt.actionDigest !== approval.actionDigest ||
    receipt.actionIntent === null ||
    receipt.actionIntent.policySnapshotId !== approval.policySnapshotId ||
    receipt.actionIntent.approvalRequirement !== "perAction"
  ) {
    throw new RunStoreError("tool_approval_receipt_mismatch");
  }
}

function validateApprovalRunCommit(
  approval: ToolApprovalState,
  commit: CommitRunInput,
  phase: "require" | "decide",
): void {
  const event = commit.events[0];
  if (
    commit.tenantId !== approval.tenantId ||
    commit.events.length !== 1 ||
    event?.identity.runId !== approval.runId ||
    commit.workItems.length !== 0 ||
    (phase === "require" &&
      (event?.type !== "run.approval.required" ||
        event.data.approvalId !== approval.approvalId ||
        event.data.actionDigest !== approval.actionDigest)) ||
    (phase === "decide" &&
      (event?.type !== "run.resumed" ||
        event.data.reasonCode !== `tool_approval_${approval.status}`))
  ) {
    throw new RunStoreError("tool_approval_run_commit_mismatch");
  }
}

function normalizeToolApprovalError(error: unknown): Error {
  return error instanceof ToolApprovalError
    ? new RunStoreError(error.code, { cause: error })
    : error instanceof Error
      ? error
      : new RunStoreError("tool_approval_error", { cause: error });
}
