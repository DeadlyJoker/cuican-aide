import { DatabaseSync } from "node:sqlite";
import {
  AgentVersionError,
  parseCompiledAgentVersion,
} from "@crewon/agent-version";
import {
  MAX_WORKFLOW_VALUE_BYTES,
  parseCompiledWorkflowVersion,
  validateWorkflowSchemaValue,
  type WorkflowContentDigester,
} from "@crewon/domain";
import { SqliteWorkflowVersionStore } from "./workflow-version-store.ts";
import { migrateSqliteWorkflowExecutions } from "./workflow-execution-schema.ts";
import { migrateSqliteWorkflowVersions } from "./workflow-version-schema.ts";

import {
  RunLifecycleError,
  ThreadLifecycleError,
  ThreadGoalError,
  validateModelHistoryItem,
  validateThreadGoal,
  validateThreadGoalEvent,
  validateThreadState,
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
  decideToolApproval as decideToolApprovalState,
  terminateToolApproval,
  validateToolApprovalState,
  type ToolApprovalState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import {
  canonicalJson,
  parseExecutionProviderCheckpoint,
  RunStoreError,
  type ActivateAgentVersionReleaseResult,
  type ActiveAgentVersionRelease,
  type AgentVersionAsset,
  type AgentVersionDeployment,
  type AgentVersionReleaseActivation,
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
  type BeginRunAttemptInput,
  type BeginRunAttemptResult,
  type CheckpointRunAttemptInput,
  type CommitLeasedRunTerminalInput,
  type CommitContextCompactionInput,
  type CommitContextCompactionResult,
  type CommitAssistantSampleContinuationInput,
  type CommitAssistantSampleContinuationResult,
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
  type CommitWorkflowRunStartInput,
  type CommitWorkflowRunStartResult,
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
  type MessageView,
  type InvalidatedMessage,
  type ModelProviderSettingsCatalog,
  type ModelProviderSettingsState,
  type ObserveModelDispatchResponseInput,
  type ModelHistoryAppend,
  type OutboxClaim,
  type OutboxLeaseInput,
  type OutboxMessage,
  type OutboxRetryInput,
  type QueueClaimInput,
  type QueueLease,
  type RegisterAgentVersionResult,
  type RunLocator,
  type RunReceiptQuery,
  type ThreadRunListQuery,
  type RunAttemptLocator,
  type RunStepLocator,
  type RetryRunAttemptInput,
  type RunAttemptTransitionResult,
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
  type PrepareModelDispatchInput,
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
  type TransitionModelDispatchInput,
  type TerminateModelDispatchInput,
  type TurnStartReceiptQuery,
  evaluateGoalToolCall,
  type GoalToolExecutionInput,
  type GoalToolExecutionResult,
  type AbandonWorkspaceDeliveryInput,
  type ClaimWorkspaceDeliveryInput,
  type CommitWorkspaceOperationResolutionInput,
  type PrepareWorkspaceOperationActionInput,
  type PrepareWorkspaceOperationInput,
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
  type WorkflowNodeContinuationStore,
  type WorkflowRunCompositionStore,
  type WorkflowRuntimeStore,
} from "@crewon/application";
import {
  validateAutomationRecord,
  type StoredAutomationInvocationReceipt,
} from "./automation-store-support.ts";
import { SqliteAutomationAuthority } from "./sqlite-automation-authority.ts";
import {
  sameAgentVersionAsset,
  sameAgentVersionDeploymentCandidate,
  sameAgentVersionReleaseActivation,
  sameAgentVersionReleaseBundle,
  validateAgentVersionAsset,
  validateAgentVersionDeployment,
  validateAgentVersionReleaseActivation,
  validateAgentVersionReleaseActivationLocator,
  validateAgentVersionReleaseBundle,
  validateAgentVersionReleaseLocator,
  validateAgentVersionReleaseTenant,
  validateAgentVersionList,
  validateAgentVersionLocator,
} from "./agent-version-store-invariants.ts";
import {
  abandonSqliteWorkspaceOperationDelivery,
  claimSqliteWorkspaceOperationDelivery,
  listSqliteWorkspaceOperationDeliveryAttempts,
  listSqliteWorkspaceOperationEvents,
  listSqliteWorkspaceOperations,
  loadSqliteWorkspaceOperation,
  loadSqliteWorkspaceOperationSnapshot,
  loadSqliteWorkspaceOperationReceipt,
  prepareSqliteWorkspaceOperationAction,
  prepareSqliteWorkspaceOperation,
  settleSqliteWorkspaceOperationDelivery,
} from "./sqlite-workspace-operation-store.ts";
import {
  abortSqliteModelProviderSettings,
  expireSqliteModelProviderSettings,
  finalizeSqliteModelProviderSettings,
  loadSqliteModelProviderSettingsState,
  prepareSqliteModelProviderSettings,
} from "./sqlite-model-provider-settings-store.ts";
import {
  leaseExpiry,
  readLeaseClock,
  SystemLeaseClock,
  type LeaseClock,
} from "./lease-clock.ts";
import { configureAndMigrateSqlite, rollback } from "./sqlite-schema.ts";
import { SqliteWorkflowRunCompositionStore } from "./sqlite-workflow-run-composition-store.ts";
import {
  beginSqliteRunAttempt,
  checkpointSqliteRunAttempt,
  recordSqliteRunAttemptProviderTurnState,
  finishSqliteRunAttempt,
  listSqliteRunAttempts,
  loadSqliteRunAttempt,
  loadSqliteRunProviderTurnState,
  loadSqliteRunStep,
} from "./sqlite-execution-authority.ts";
import {
  insertSqliteToolApproval,
  loadSqliteToolApproval,
  loadSqliteToolApprovalByAction,
  loadLatestSqliteToolApprovalForRun,
  updateSqliteToolApproval,
} from "./sqlite-tool-approvals.ts";
import {
  insertSqliteToolExecutionReceipt,
  loadSqliteToolExecutionReceipt,
  loadSqliteToolExecutionReceiptByAction,
  updateSqliteToolExecutionReceipt,
} from "./sqlite-tool-execution-receipts.ts";
import {
  loadSqliteModelDispatchReceipt,
  markSqliteModelDispatchPossiblySent,
  observeSqliteModelDispatchResponse,
  prepareSqliteModelDispatch,
  terminateSqliteModelDispatch,
} from "./sqlite-model-dispatch-evidence.ts";
import {
  requireNonEmpty,
  stableJson,
  parseQueueTimestamp,
  validateClaimedLease,
  validateBeginRunAttemptInput,
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
  validateEventPage,
  validateEvents,
  validateLimit,
  validateMessagePage,
  validateMessageView,
  validateMessageProposedPlan,
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
  validateThreadGoalRetainedRunReceipt,
  validateRecordRunAttemptProviderTurnStateInput,
} from "./store-invariants.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import {
  createThreadGoalEvent,
  validateStoredThreadGoalEventPage,
} from "./thread-goal-event-support.ts";
import {
  decodeStoredThreadEvent,
  validateStoredThreadEventPage,
} from "./thread-event-support.ts";

type SnapshotRow = Readonly<{
  tenant_id: string;
  space_id: string;
  run_id: string;
  revision: number;
  last_sequence: number;
  state_json: string;
  thread_id: string | null;
}>;
type ThreadSnapshotRow = Readonly<{
  tenant_id: string;
  space_id: string;
  thread_id: string;
  created_by_actor_id: string;
  title: string | null;
  status: string;
  revision: number;
  last_event_sequence: number;
  last_message_sequence: number;
  state_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  deleted_at: string | null;
  deleted_by_actor_id: string | null;
}>;
type ThreadGoalRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  goal_id: string;
  revision: number;
  state_json: string;
  updated_at: string;
}>;
type ThreadGoalSnapshotRow = Readonly<{
  tenant_id: string | null;
  thread_id: string | null;
  goal_id: string | null;
  revision: number | null;
  state_json: string | null;
  updated_at: string | null;
  event_sequence: number;
}>;

type ThreadGoalEventRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: number;
  event_id: string;
  event_type: string;
  event_json: string;
  occurred_at: string;
}>;
type ThreadEventRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: number;
  event_id: string;
  event_json: string;
}>;
type MessageRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: number;
  message_id: string;
  role: string;
  content: string;
  content_digest: string;
  created_at: string;
  message_json: string;
  rollback_id?: string | null;
  marker_item_id?: string | null;
  history_sequence?: number | null;
  invalidated_at?: string | null;
}>;
type ModelHistoryRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  sequence: number;
  item_id: string;
  run_id: string | null;
  segment_id: string | null;
  item_type: string;
  item_json: string;
  created_at: string;
}>;
type EventRow = Readonly<{
  tenant_id: string;
  run_id: string;
  sequence: number;
  event_id: string;
  event_json: string;
}>;
type OutboxRow = Readonly<{
  message_id: string;
  tenant_id: string;
  run_id: string;
  topic: string;
  created_at: string;
  message_json: string;
}>;
type WorkItemRow = Readonly<{
  work_item_id: string;
  tenant_id: string;
  run_id: string;
  kind: string;
  created_at: string;
  work_item_json: string;
}>;
type QueueMetadataRow = Readonly<{
  status: string;
  lease_owner_id: string | null;
  lease_id: string | null;
  lease_epoch: number;
  lease_expires_at_ms: number | null;
}>;
type WorkItemExecutionMetadataRow = QueueMetadataRow &
  Readonly<{
    tenant_id: string;
    run_id: string;
  }>;
type ReceiptRow = Readonly<{
  tenant_id: string;
  run_id: string;
  fingerprint: string;
  result_json: string;
}>;
type ThreadReceiptRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  fingerprint: string;
  result_json: string;
}>;
type ThreadContinuationRow = Readonly<{
  tenant_id: string;
  thread_id: string;
  agent_version_id: string;
  adapter_name: string;
  adapter_version: string;
  model_id: string;
  through_history_sequence: number;
  context_revision: string;
  checkpoint_json: string;
  updated_at: string;
  history_item_type: string;
  history_message_role: string | null;
}>;
type ThreadModelStateRow = Readonly<{
  state_json: string;
}>;
type AgentVersionRow = Readonly<{
  tenant_id: string;
  agent_version_id: string;
  content_digest: string;
  asset_json: string;
  created_at: string;
}>;
type AgentVersionDeploymentRow = Readonly<{
  tenant_id: string;
  agent_version_id: string;
  content_digest: string;
  materialization_digest: string;
  deployment_json: string;
  deployed_at: string;
}>;
type AgentVersionReleaseBundleRow = Readonly<{
  tenant_id: string;
  release_id: string;
  manifest_digest: string;
  default_agent_version_id: string;
  bundle_json: string;
}>;
type AgentVersionReleaseActivationRow = Readonly<{
  tenant_id: string;
  activation_id: string;
  release_id: string;
  previous_release_id: string | null;
  operator_principal_id: string;
  operator_actor_id: string;
  operator_space_id: string;
  activation_json: string;
  activated_at: string;
}>;
type AutomationRow = Readonly<{
  tenant_id: string;
  space_id: string;
  automation_id: string;
  thread_id: string;
  revision: number;
  definition_digest: string;
  definition_json: string;
  updated_at: string;
}>;

export class SqliteRunStore implements DomainStore, WorkflowRuntimeStore {
  readonly #database: DatabaseSync;
  readonly #clock: LeaseClock;
  readonly #workflowDigester: WorkflowContentDigester | null;
  readonly #automationAuthority: SqliteAutomationAuthority;
  #workflowRuntime: SqliteWorkflowRunCompositionStore | null = null;
  #closed = false;

  workflowVersionStore(
    digester: WorkflowContentDigester,
  ): SqliteWorkflowVersionStore {
    this.#assertOpen();
    return new SqliteWorkflowVersionStore(this.#database, digester);
  }

  async loadWorkflowExecution(input: { tenantId: string; runId: string }) {
    return this.#workflow().loadWorkflowExecution(input);
  }

  async scheduleWorkflowNodes(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowNodes"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowNodes"]> {
    return this.#workflow().scheduleWorkflowNodes(input);
  }
  async admitWorkflowNodeWork(
    input: Parameters<WorkflowRunCompositionStore["admitWorkflowNodeWork"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["admitWorkflowNodeWork"]> {
    return this.#workflow().admitWorkflowNodeWork(input);
  }
  async settleWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowNode"]> {
    return this.#workflow().settleWorkflowNode(input);
  }
  async recordWorkflowHumanGateDecision(
    input: Parameters<WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["recordWorkflowHumanGateDecision"]> {
    return this.#workflow().recordWorkflowHumanGateDecision(input);
  }
  async settleWorkflowHumanGate(
    input: Parameters<WorkflowRunCompositionStore["settleWorkflowHumanGate"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["settleWorkflowHumanGate"]> {
    return this.#workflow().settleWorkflowHumanGate(input);
  }
  async scheduleWorkflowReconciliation(
    input: Parameters<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["scheduleWorkflowReconciliation"]> {
    return this.#workflow().scheduleWorkflowReconciliation(input);
  }
  async reconcileWorkflowNode(
    input: Parameters<WorkflowRunCompositionStore["reconcileWorkflowNode"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["reconcileWorkflowNode"]> {
    return this.#workflow().reconcileWorkflowNode(input);
  }
  async cancelWorkflowExecution(
    input: Parameters<WorkflowRunCompositionStore["cancelWorkflowExecution"]>[0],
  ): ReturnType<WorkflowRunCompositionStore["cancelWorkflowExecution"]> {
    return this.#workflow().cancelWorkflowExecution(input);
  }
  async loadWorkflowNodeContinuation(
    authority: Parameters<WorkflowNodeContinuationStore["loadWorkflowNodeContinuation"]>[0],
  ): ReturnType<WorkflowNodeContinuationStore["loadWorkflowNodeContinuation"]> {
    return this.#workflow().loadWorkflowNodeContinuation(authority);
  }
  async commitWorkflowAssistantContinuation(
    input: Parameters<WorkflowNodeContinuationStore["commitWorkflowAssistantContinuation"]>[0],
  ): ReturnType<WorkflowNodeContinuationStore["commitWorkflowAssistantContinuation"]> {
    return this.#workflow().commitWorkflowAssistantContinuation(input);
  }
  async commitWorkflowToolContinuation(
    input: Parameters<WorkflowNodeContinuationStore["commitWorkflowToolContinuation"]>[0],
  ): ReturnType<WorkflowNodeContinuationStore["commitWorkflowToolContinuation"]> {
    return this.#workflow().commitWorkflowToolContinuation(input);
  }
  async settleWorkflowNodeModelTerminal(
    input: Parameters<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]>[0],
  ): ReturnType<WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]> {
    return this.#workflow().settleWorkflowNodeModelTerminal(input);
  }

  async settlePreparedWorkflowNodeTerminal(input: Parameters<
    WorkflowNodeContinuationStore["settlePreparedWorkflowNodeTerminal"]>[0]) {
    return this.#workflow().settlePreparedWorkflowNodeTerminal(input);
  }

  constructor(path: string, options: {
    clock?: LeaseClock;
    workflowDigester?: WorkflowContentDigester;
  } = {}) {
    requireNonEmpty(path, "sqlite_path_invalid");
    this.#clock = options.clock ?? new SystemLeaseClock();
    this.#workflowDigester = options.workflowDigester ?? null;
    this.#database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
    });
    this.#automationAuthority = new SqliteAutomationAuthority(this.#database, {
      assertOpen: () => this.#assertOpen(),
      hasPendingProviderSwitch: (tenantId) =>
        this.#hasPendingProviderSwitch(tenantId),
      loadThread: (locator) => this.#loadThread(locator),
      loadRun: (locator) => this.#loadRun(locator),
      loadHistory: (locator) => this.#loadAllModelHistoryItems(locator),
      threadEventIdExists: (id) => this.#threadEventIdExists(id),
      messageIdExists: (id) => this.#messageIdExists(id),
      historyItemIdExists: (id) => this.#modelHistoryItemIdExists(id),
      runEventIdExists: (id) => this.#eventIdExists(id),
      outboxIdExists: (id) => this.#outboxMessageIdExists(id),
      workItemIdExists: (id) => this.#workItemIdExists(id),
      loadInvocationAuthority: (receipt) =>
        this.#loadAutomationInvocationAuthority(receipt),
      writeThreadSnapshot: (current, next, expectedRevision) =>
        this.#writeThreadSnapshot(current, next, expectedRevision),
      writeThreadEvents: (events, tenantId) =>
        this.#writeThreadEvents(events, tenantId),
      writeMessages: (messages) => this.#writeMessages(messages),
      writeHistory: (items) => this.#writeModelHistoryItems(items),
      writeRunSnapshot: (current, next, expectedRevision) =>
        this.#writeSnapshot(current, next, expectedRevision),
      writeRunThreadBinding: (current, next) =>
        this.#writeRunThreadBinding(current, next),
      writeRunEvents: (events, tenantId) => this.#writeEvents(events, tenantId),
      writeOutbox: (messages) => this.#writeOutbox(messages),
      writeWorkItems: (items) => this.#writeWorkItems(items),
    });
    try {
      configureAndMigrateSqlite(this.#database);
      migrateSqliteWorkflowVersions(this.#database);
      migrateSqliteWorkflowExecutions(this.#database);
      if (this.#workflowDigester !== null)
        this.#workflowRuntime = new SqliteWorkflowRunCompositionStore(
          this.#database,
          { digester: this.#workflowDigester, clock: this.#clock },
        );
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw normalizeSqliteError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#database.close();
    this.#closed = true;
  }

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
    this.#assertOpen();
    requireNonEmpty(input.tenantId, "model_provider_settings_tenant_invalid");
    try {
      return loadSqliteModelProviderSettingsState(
        this.#database,
        input.tenantId,
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async prepareModelProviderSettings(
    input: PrepareModelProviderSettingsInput,
  ): Promise<PrepareModelProviderSettingsResult> {
    this.#assertOpen();
    try {
      return prepareSqliteModelProviderSettings(this.#database, input, () =>
        readLeaseClock(this.#clock),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async finalizeModelProviderSettings(
    input: FinalizeModelProviderSettingsInput,
  ): Promise<FinalizeModelProviderSettingsResult> {
    this.#assertOpen();
    try {
      return finalizeSqliteModelProviderSettings(this.#database, input, () =>
        readLeaseClock(this.#clock),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async abortModelProviderSettings(
    input: AbortModelProviderSettingsInput,
  ): Promise<AbortModelProviderSettingsResult> {
    this.#assertOpen();
    try {
      return abortSqliteModelProviderSettings(this.#database, input, () =>
        readLeaseClock(this.#clock),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async expireModelProviderSettings(
    input: ExpireModelProviderSettingsInput,
  ): Promise<ExpireModelProviderSettingsResult> {
    this.#assertOpen();
    try {
      return expireSqliteModelProviderSettings(this.#database, input, () =>
        readLeaseClock(this.#clock),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async registerAgentVersion(
    asset: AgentVersionAsset,
  ): Promise<RegisterAgentVersionResult> {
    this.#assertOpen();
    validateAgentVersionAsset(asset);
    try {
      const inserted = this.#database
        .prepare(
          `INSERT OR IGNORE INTO agent_versions (
             tenant_id,
             agent_version_id,
             content_digest,
             asset_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          asset.tenantId,
          asset.agentVersionId,
          asset.contentDigest,
          stableJson(asset),
          asset.createdAt,
        );
      const existing = this.#loadAgentVersion(asset);
      if (existing === null) {
        throw new RunStoreError("agent_version_register_failed");
      }
      if (!sameAgentVersionAsset(existing, asset)) {
        throw new RunStoreError("agent_version_id_conflict");
      }
      return {
        disposition: inserted.changes === 1 ? "registered" : "existing",
        asset: clone(existing),
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionAsset | null> {
    this.#assertOpen();
    validateAgentVersionLocator(input);
    try {
      return clone(this.#loadAgentVersion(input));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listAgentVersions(input: {
    tenantId: string;
    afterAgentVersionId: string | null;
    limit: number;
  }): Promise<readonly AgentVersionAsset[]> {
    this.#assertOpen();
    validateAgentVersionList(input);
    try {
      const rows = this.#database
        .prepare(
          `SELECT tenant_id, agent_version_id, content_digest, asset_json,
                  created_at
           FROM agent_versions
           WHERE tenant_id = ?
             AND (? IS NULL OR agent_version_id > ?)
           ORDER BY agent_version_id ASC
           LIMIT ?`,
        )
        .all(
          input.tenantId,
          input.afterAgentVersionId,
          input.afterAgentVersionId,
          input.limit,
        ) as unknown as AgentVersionRow[];
      return rows.map(decodeSqliteAgentVersion);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadAgentVersionDeployment(input: {
    tenantId: string;
    agentVersionId: string;
  }): Promise<AgentVersionDeployment | null> {
    this.#assertOpen();
    validateAgentVersionLocator(input);
    try {
      return clone(this.#loadAgentVersionDeployment(input));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async activateAgentVersionRelease(input: {
    bundle: AgentVersionReleaseBundle;
    activation: AgentVersionReleaseActivation;
    expectedActiveReleaseId: string | null;
  }): Promise<ActivateAgentVersionReleaseResult> {
    this.#assertOpen();
    validateAgentVersionReleaseBundle(input.bundle);
    validateAgentVersionReleaseActivation(input.activation);
    validateReleaseActivationInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const replayActivation = this.#loadAgentVersionReleaseActivation({
        tenantId: input.activation.tenantId,
        activationId: input.activation.activationId,
      });
      if (replayActivation !== null) {
        const replayBundle = this.#loadAgentVersionReleaseBundle({
          tenantId: replayActivation.tenantId,
          releaseId: replayActivation.releaseId,
        });
        if (
          replayBundle === null ||
          !sameAgentVersionReleaseBundle(replayBundle, input.bundle) ||
          !sameAgentVersionReleaseActivation(replayActivation, input.activation)
        ) {
          throw new RunStoreError("agent_version_release_activation_conflict");
        }
        this.#database.exec("COMMIT");
        return {
          disposition: "replayed",
          release: clone({
            bundle: replayBundle,
            activation: replayActivation,
          }),
        };
      }
      const active = this.#loadActiveAgentVersionRelease(input.bundle.tenantId);
      if (
        (active?.bundle.releaseId ?? null) !== input.expectedActiveReleaseId ||
        input.activation.previousReleaseId !== input.expectedActiveReleaseId
      ) {
        throw new RunStoreError("agent_version_release_active_conflict");
      }
      const existingBundle = this.#loadAgentVersionReleaseBundle(input.bundle);
      if (
        existingBundle !== null &&
        !sameAgentVersionReleaseBundle(existingBundle, input.bundle)
      ) {
        throw new RunStoreError("agent_version_release_bundle_conflict");
      }
      const deployments = input.bundle.deployments.map((candidate) => {
        const asset = this.#loadAgentVersion(candidate);
        if (asset === null) {
          throw new RunStoreError("agent_version_release_asset_missing");
        }
        if (asset.contentDigest !== candidate.contentDigest) {
          throw new RunStoreError("agent_version_release_asset_mismatch");
        }
        const existing = this.#loadAgentVersionDeployment(candidate);
        if (
          existing !== null &&
          !sameAgentVersionDeploymentCandidate(existing, candidate)
        ) {
          throw new RunStoreError("agent_version_deployment_conflict");
        }
        return {
          ...candidate,
          deployedAt: input.activation.activatedAt,
        } satisfies AgentVersionDeployment;
      });
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO agent_version_release_bundles (
             tenant_id, release_id, manifest_digest,
             default_agent_version_id, bundle_json
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.bundle.tenantId,
          input.bundle.releaseId,
          input.bundle.manifestDigest,
          input.bundle.defaultAgentVersionId,
          stableJson(input.bundle),
        );
      for (const deployment of deployments) {
        this.#database
          .prepare(
            `INSERT OR IGNORE INTO agent_version_deployments (
               tenant_id, agent_version_id, content_digest,
               materialization_digest, deployment_json, deployed_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            deployment.tenantId,
            deployment.agentVersionId,
            deployment.contentDigest,
            deployment.materializationDigest,
            stableJson(deployment),
            deployment.deployedAt,
          );
      }
      this.#database
        .prepare(
          `INSERT INTO agent_version_release_activations (
             tenant_id, activation_id, release_id, previous_release_id,
             operator_principal_id, operator_actor_id, operator_space_id,
             activation_json, activated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.activation.tenantId,
          input.activation.activationId,
          input.activation.releaseId,
          input.activation.previousReleaseId,
          input.activation.operator.principalId,
          input.activation.operator.actorId,
          input.activation.operator.spaceId,
          stableJson(input.activation),
          input.activation.activatedAt,
        );
      this.#database
        .prepare(
          `INSERT INTO active_agent_version_releases (
             tenant_id, release_id, activation_id, activated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET
             release_id = excluded.release_id,
             activation_id = excluded.activation_id,
             activated_at = excluded.activated_at`,
        )
        .run(
          input.activation.tenantId,
          input.activation.releaseId,
          input.activation.activationId,
          input.activation.activatedAt,
        );
      this.#database.exec("COMMIT");
      return {
        disposition: "activated",
        release: clone({
          bundle: input.bundle,
          activation: input.activation,
        }),
      };
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): Promise<AgentVersionReleaseBundle | null> {
    this.#assertOpen();
    validateAgentVersionReleaseLocator(input);
    try {
      return clone(this.#loadAgentVersionReleaseBundle(input));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): Promise<AgentVersionReleaseActivation | null> {
    this.#assertOpen();
    validateAgentVersionReleaseActivationLocator(input);
    try {
      return clone(this.#loadAgentVersionReleaseActivation(input));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadActiveAgentVersionRelease(input: {
    tenantId: string;
  }): Promise<ActiveAgentVersionRelease | null> {
    this.#assertOpen();
    validateAgentVersionReleaseTenant(input);
    try {
      return clone(this.#loadActiveAgentVersionRelease(input.tenantId));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadThread(locator: ThreadLocator): Promise<ThreadState | null> {
    this.#assertOpen();
    validateThreadLocator(locator);
    try {
      return this.#loadThread(locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadInSpace(
    locator: ThreadSpaceLocator,
  ): Promise<ThreadState | null> {
    this.#assertOpen();
    validateThreadSpaceLocator(locator);
    try {
      const thread = this.#loadThread(locator);
      return thread?.spaceId === locator.spaceId ? thread : null;
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadWorkspaceOperationReceipt(
    query: WorkspaceOperationReceiptQuery,
  ): Promise<WorkspaceOperationMutationResult | null> {
    this.#assertOpen();
    return loadSqliteWorkspaceOperationReceipt(this.#database, query);
  }

  async prepareWorkspaceOperation(
    input: PrepareWorkspaceOperationInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    this.#assertOpen();
    return prepareSqliteWorkspaceOperation(
      this.#database,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async loadWorkspaceOperation(input: {
    tenantId: string;
    spaceId: string;
    threadId: string;
    executionId: string;
  }): Promise<WorkspaceOperationRecord | null> {
    this.#assertOpen();
    return loadSqliteWorkspaceOperation(this.#database, input);
  }

  async loadWorkspaceOperationSnapshot(
    locator: WorkspaceOperationLocator,
  ): Promise<WorkspaceOperationSnapshot | null> {
    this.#assertOpen();
    return loadSqliteWorkspaceOperationSnapshot(this.#database, locator);
  }

  async listWorkspaceOperationEvents(
    query: WorkspaceOperationEventQuery,
  ): Promise<readonly WorkspaceOperationEvent[]> {
    this.#assertOpen();
    return listSqliteWorkspaceOperationEvents(this.#database, query);
  }

  async listWorkspaceOperations(
    query: WorkspaceOperationListQuery,
  ): Promise<WorkspaceOperationListPage> {
    this.#assertOpen();
    return listSqliteWorkspaceOperations(this.#database, query);
  }

  async prepareWorkspaceOperationAction(
    input: PrepareWorkspaceOperationActionInput,
  ): Promise<WorkspaceOperationPreparationResult> {
    this.#assertOpen();
    return prepareSqliteWorkspaceOperationAction(
      this.#database,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async claimWorkspaceOperationDelivery(
    input: ClaimWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    this.#assertOpen();
    return claimSqliteWorkspaceOperationDelivery(
      this.#database,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async listWorkspaceOperationDeliveryAttempts(
    query: WorkspaceDeliveryAttemptQuery,
  ): Promise<readonly WorkspaceDeliveryAttempt[]> {
    this.#assertOpen();
    return listSqliteWorkspaceOperationDeliveryAttempts(this.#database, query);
  }

  async abandonWorkspaceOperationDelivery(
    input: AbandonWorkspaceDeliveryInput,
  ): Promise<WorkspaceDeliveryAttempt> {
    this.#assertOpen();
    return abandonSqliteWorkspaceOperationDelivery(
      this.#database,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async settleWorkspaceOperationDelivery(
    input: CommitWorkspaceOperationResolutionInput,
  ): Promise<WorkspaceDeliverySettlementResult> {
    this.#assertOpen();
    return settleSqliteWorkspaceOperationDelivery(
      this.#database,
      input,
      readLeaseClock(this.#clock),
    );
  }

  async loadThreadGoal(locator: ThreadLocator): Promise<ThreadGoal | null> {
    this.#assertOpen();
    validateThreadLocator(locator);
    try {
      if (this.#loadThread(locator) === null) return null;
      return this.#loadThreadGoal(locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadGoalSnapshot(
    locator: ThreadLocator,
  ): Promise<ThreadGoalSnapshot> {
    this.#assertOpen();
    validateThreadLocator(locator);
    try {
      const row = this.#database
        .prepare(
          `SELECT
             goal.tenant_id,
             goal.thread_id,
             goal.goal_id,
             goal.revision,
             goal.state_json,
             goal.updated_at,
             COALESCE((
               SELECT MAX(event.sequence)
               FROM thread_goal_events AS event
               WHERE event.tenant_id = thread.tenant_id
                 AND event.thread_id = thread.thread_id
             ), 0) AS event_sequence
           FROM threads AS thread
           LEFT JOIN thread_goals AS goal
             ON goal.tenant_id = thread.tenant_id
            AND goal.thread_id = thread.thread_id
           WHERE thread.tenant_id = ? AND thread.thread_id = ?`,
        )
        .get(locator.tenantId, locator.threadId) as
        | ThreadGoalSnapshotRow
        | undefined;
      if (row === undefined) return { goal: null, eventSequence: 0 };
      return {
        goal:
          row.state_json === null
            ? null
            : decodeStoredThreadGoal(row as ThreadGoalRow, locator),
        eventSequence: row.event_sequence,
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listThreadGoalEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadGoalEvent[]> {
    this.#assertOpen();
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    validateLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT tenant_id, thread_id, sequence, event_id, event_type, event_json, occurred_at
         FROM thread_goal_events
         WHERE tenant_id = ? AND thread_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(
        locator.tenantId,
        locator.threadId,
        afterSequence,
        limit,
      ) as unknown as ThreadGoalEventRow[];
    const events = rows.map((row) => decodeStoredThreadGoalEvent(row, locator));
    validateStoredThreadGoalEventPage(events, locator, afterSequence);
    return events;
  }

  async loadThreadGoalMutationReceipt(input: {
    tenantId: string;
    threadId: string;
    idempotency: import("@crewon/application").IdempotencyDescriptor;
  }): Promise<CommitThreadGoalMutationResult | null> {
    this.#assertOpen();
    validateThreadLocator(input);
    try {
      const prior = this.#loadThreadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior === null) return null;
      if (prior.tenant_id !== input.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.thread_id !== input.threadId) {
        throw new RunStoreError("goal_mutation_receipt_invalid");
      }
      if (prior.fingerprint !== input.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const result = parseStoredJson<CommitThreadGoalMutationResult>(
        prior.result_json,
        "goal_mutation_receipt_invalid",
      );
      validateStoredThreadGoalMutationResult(result, prior);
      return clone({ ...result, disposition: "replayed" });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadActiveRun(
    locator: ThreadLocator,
  ): Promise<import("@crewon/application").ThreadGoalActiveRun | null> {
    this.#assertOpen();
    validateThreadLocator(locator);
    try {
      const rows = this.#database
        .prepare(
          `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
                  snapshots.revision, snapshots.last_sequence,
                  snapshots.state_json, bindings.thread_id
           FROM run_snapshots AS snapshots
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = snapshots.tenant_id
            AND bindings.run_id = snapshots.run_id
           WHERE snapshots.tenant_id = ?
             AND bindings.thread_id = ?
             AND json_extract(snapshots.state_json, '$.status')
                 NOT IN ('completed', 'failed', 'canceled')`,
        )
        .all(locator.tenantId, locator.threadId) as unknown as SnapshotRow[];
      if (rows.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      if (rows[0] === undefined) return null;
      const state = decodeStoredRunState(rows[0], {
        tenantId: locator.tenantId,
        runId: rows[0].run_id,
      });
      const workRows = this.#database
        .prepare(
          `SELECT json_extract(work_item_json, '$.payload.trigger') AS trigger
           FROM work_items
           WHERE tenant_id = ? AND run_id = ? AND status != 'completed'`,
        )
        .all(locator.tenantId, state.runId) as unknown as {
        trigger: string | null;
      }[];
      if (workRows.length > 1) {
        throw new RunStoreError("goal_active_run_work_item_invariant");
      }
      const trigger = workRows[0]?.trigger;
      return {
        state,
        trigger:
          trigger === "goalContinuation" || trigger === "goalActivation"
            ? trigger
            : "default",
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async commitThreadGoalMutation(
    input: CommitThreadGoalMutationInput,
  ): Promise<CommitThreadGoalMutationResult> {
    this.#assertOpen();
    validateThreadGoalMutationInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadThreadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.thread_id !== input.threadId) {
          throw new RunStoreError("goal_mutation_receipt_invalid");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = parseStoredJson<CommitThreadGoalMutationResult>(
          prior.result_json,
          "goal_mutation_receipt_invalid",
        );
        validateStoredThreadGoalMutationResult(result, prior);
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }

      if (
        input.continuation !== null &&
        this.#hasPendingProviderSwitch(input.tenantId)
      ) {
        throw new RunStoreError("model_provider_settings_switch_pending");
      }

      const thread = this.#loadThread({
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      if (thread === null || thread.status !== "active") {
        throw new RunStoreError("thread_not_found");
      }
      const activeRows = this.#database
        .prepare(
          `SELECT snapshots.tenant_id, snapshots.space_id, snapshots.run_id,
                  snapshots.revision, snapshots.last_sequence,
                  snapshots.state_json, bindings.thread_id
           FROM run_snapshots AS snapshots
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = snapshots.tenant_id
            AND bindings.run_id = snapshots.run_id
           WHERE snapshots.tenant_id = ?
             AND bindings.thread_id = ?
             AND json_extract(snapshots.state_json, '$.status')
                 NOT IN ('completed', 'failed', 'canceled')`,
        )
        .all(input.tenantId, input.threadId) as unknown as SnapshotRow[];
      if (activeRows.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      const activeRun =
        activeRows[0] === undefined
          ? null
          : decodeStoredRunState(activeRows[0], {
              tenantId: input.tenantId,
              runId: activeRows[0].run_id,
            });
      validateThreadGoalActiveRunFence(input.expectedActiveRun, activeRun);

      const currentGoal = this.#loadThreadGoal({
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const nextGoal = applyTurnStartGoalMutation(currentGoal, input.goal, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const activeWorkRows =
        activeRun === null
          ? []
          : (this.#database
              .prepare(
                `SELECT work_item_id,
                        json_extract(work_item_json, '$.payload.trigger') AS trigger
                 FROM work_items
                 WHERE tenant_id = ? AND run_id = ? AND status != 'completed'`,
              )
              .all(input.tenantId, activeRun.runId) as unknown as {
              work_item_id: string;
              trigger: string | null;
            }[]);
      if (activeWorkRows.length > 1) {
        throw new RunStoreError("goal_active_run_work_item_invariant");
      }
      const activeTrigger = activeWorkRows[0]?.trigger;
      const shouldCancel = shouldCancelQueuedRunForGoal(
        activeRun,
        nextGoal,
        activeTrigger === "goalContinuation" ||
          activeTrigger === "goalActivation"
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
          (eventId) => this.#eventIdExists(eventId),
          (messageId) => this.#outboxMessageIdExists(messageId),
        );
        for (const event of input.queuedRunCancellation.events) {
          pendingEventIds.add(event.eventId);
        }
        for (const message of input.queuedRunCancellation.outbox) {
          pendingOutboxIds.add(message.messageId);
        }
        if (activeWorkRows.length !== 1) {
          throw new RunStoreError("goal_queued_run_work_item_invalid");
        }
        canceledWorkItemId = activeWorkRows[0]!.work_item_id;
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
            pendingEventIds.has(eventId) || this.#eventIdExists(eventId),
          (messageId) =>
            pendingOutboxIds.has(messageId) ||
            this.#outboxMessageIdExists(messageId),
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
          this.#loadAllModelHistoryItems({
            tenantId: input.tenantId,
            threadId: input.threadId,
          }),
          (itemId) => this.#modelHistoryItemIdExists(itemId),
        );
        const continuation = reduceThreadGoalContinuation(
          input.continuation,
          nextGoal,
          thread,
          (eventId) =>
            pendingEventIds.has(eventId) || this.#eventIdExists(eventId),
          (messageId) =>
            pendingOutboxIds.has(messageId) ||
            this.#outboxMessageIdExists(messageId),
          (workItemId) => this.#workItemIdExists(workItemId),
        );
        if (continuation.runState.runId === activeRun?.runId) {
          throw new RunStoreError("goal_activation_run_conflict");
        }
        continuationResult = {
          historyItem: continuation.historyItem,
          runState: continuation.runState,
          runEvents: input.continuation.events,
          outbox: input.continuation.outbox,
          workItems: input.continuation.workItems,
        };
      } else if (input.continuation !== null) {
        throw new RunStoreError("goal_activation_unexpected");
      }

      this.#writeTurnStartGoal(
        input.goal,
        nextGoal,
        input.tenantId,
        input.threadId,
      );
      if (canceledRunState !== null && input.queuedRunCancellation !== null) {
        this.#writeSnapshot(activeRun, canceledRunState, activeRun!.revision);
        this.#writeEvents(input.queuedRunCancellation.events, input.tenantId);
        this.#writeOutbox(input.queuedRunCancellation.outbox);
        const completed = this.#database
          .prepare(
            `UPDATE work_items
             SET status = 'completed', lease_owner_id = NULL, lease_id = NULL,
                 lease_expires_at_ms = NULL, completed_at_ms = ?,
                 last_error_code = 'goal_mutated'
             WHERE work_item_id = ? AND status != 'completed'`,
          )
          .run(
            parseQueueTimestamp(
              canceledRunState.updatedAt,
              "goal_mutation_timestamp_invalid",
            ),
            canceledWorkItemId,
          );
        if (completed.changes !== 1) {
          throw new RunStoreError("goal_queued_run_work_item_conflict");
        }
      }
      if (retainedRunState !== null && input.retainedRunUpdate !== null) {
        this.#writeSnapshot(activeRun, retainedRunState, activeRun!.revision);
        this.#writeEvents(input.retainedRunUpdate.events, input.tenantId);
        this.#writeOutbox(input.retainedRunUpdate.outbox);
      }
      if (continuationResult !== null && input.continuation !== null) {
        this.#writeModelHistoryItems(input.continuation.history.items);
        this.#writeSnapshot(null, continuationResult.runState, 0);
        this.#writeRunThreadBinding(null, continuationResult.runState);
        this.#writeEvents(input.continuation.events, input.tenantId);
        this.#writeOutbox(input.continuation.outbox);
        this.#writeWorkItems(input.continuation.workItems);
      }
      const result: CommitThreadGoalMutationResult = {
        disposition: "committed",
        goalChanged: stableJson(currentGoal) !== stableJson(nextGoal),
        goalState: nextGoal,
        canceledRunState,
        retainedRun:
          retainedRunState === null || input.retainedRunUpdate === null
            ? null
            : {
                runState: retainedRunState,
                runEvents: input.retainedRunUpdate.events,
                outbox: input.retainedRunUpdate.outbox,
              },
        continuation: continuationResult,
      };
      this.#database
        .prepare(
          `INSERT INTO thread_idempotency_receipts (
             tenant_id, scope, idempotency_key, thread_id, fingerprint,
             result_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          input.threadId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async executeGoalTool(
    input: GoalToolExecutionInput,
  ): Promise<GoalToolExecutionResult> {
    this.#assertOpen();
    validateGoalToolExecutionInput(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        now,
      );
      const prior = this.#loadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = parseStoredJson<GoalToolExecutionResult>(
          prior.result_json,
          "goal_tool_receipt_invalid",
        );
        validateStoredGoalToolResult(result, prior, input.threadId);
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }
      const run = this.#loadRun({
        tenantId: input.tenantId,
        runId: input.runId,
      });
      if (run === null || run.threadId !== input.threadId) {
        throw new RunStoreError("run_not_found");
      }
      const requested = (
        this.#database
          .prepare(
            `SELECT tenant_id, run_id, sequence, event_id, event_json
             FROM run_events
             WHERE tenant_id = ? AND run_id = ?
             ORDER BY sequence ASC`,
          )
          .all(input.tenantId, input.runId) as unknown as EventRow[]
      )
        .map((row) =>
          decodeStoredEvent(row, {
            tenantId: input.tenantId,
            runId: input.runId,
          }),
        )
        .find(
          (event) =>
            event.type === "tool.requested" &&
            event.data.callId === input.request.callId,
        );
      validateGoalToolRequestedEvent(input, requested ?? null);
      const current = this.#loadThreadGoal({
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const evaluation = evaluateGoalToolCall(
        current,
        run,
        input.request.name,
        input.request.input,
        input.occurredAt,
        input.proposedGoalId,
      );
      const next = applyTurnStartGoalMutation(current, evaluation.mutation, {
        tenantId: input.tenantId,
        threadId: input.threadId,
      });
      const accounting = prepareGoalToolAccounting(input, run, evaluation);
      validateEvents(accounting.runEvents, run.runId, (eventId) =>
        this.#eventIdExists(eventId),
      );
      validateOutbox(accounting.outbox, run.runId, run.tenantId, (messageId) =>
        this.#outboxMessageIdExists(messageId),
      );
      this.#writeTurnStartGoal(
        evaluation.mutation,
        next,
        input.tenantId,
        input.threadId,
      );
      if (accounting.runEvents.length > 0) {
        this.#writeSnapshot(run, accounting.runState, run.revision);
        this.#writeEvents(accounting.runEvents, input.tenantId);
        this.#writeOutbox(accounting.outbox);
      }
      const result: GoalToolExecutionResult = {
        disposition: "committed",
        goalState: next,
        runState: accounting.runState,
        runEvents: accounting.runEvents,
        outbox: accounting.outbox,
        output: evaluation.output,
        isError: evaluation.isError,
      };
      this.#database
        .prepare(
          `INSERT INTO idempotency_receipts (
             tenant_id, scope, idempotency_key, run_id, fingerprint, result_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          input.runId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async listThreads(query: ThreadListQuery): Promise<readonly ThreadState[]> {
    this.#assertOpen();
    validateThreadListQuery(query);
    try {
      const rows = this.#database
        .prepare(
          `SELECT
             tenant_id,
             space_id,
             thread_id,
             created_by_actor_id,
             title,
             status,
             revision,
             last_event_sequence,
             last_message_sequence,
             state_json,
             created_at,
             updated_at,
             archived_at,
             deleted_at,
             deleted_by_actor_id
           FROM threads
           WHERE tenant_id = ?
             AND space_id = ?
             AND status != 'deleted'
             AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND thread_id < ?))
           ORDER BY updated_at DESC, thread_id DESC
           LIMIT ?`,
        )
        .all(
          query.tenantId,
          query.spaceId,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.threadId ?? null,
          query.limit,
        ) as unknown as ThreadSnapshotRow[];
      return rows.map((row) =>
        decodeStoredThreadState(row, {
          tenantId: query.tenantId,
          threadId: row.thread_id,
        }),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async commitThread(input: CommitThreadInput): Promise<CommitThreadResult> {
    this.#assertOpen();
    const threadId = validateThreadCommitInput(input);
    const fingerprint = input.idempotency.requestFingerprint;

    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadThreadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== fingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = parseStoredJson<CommitThreadResult>(
          prior.result_json,
          "thread_idempotency_receipt_invalid",
        );
        validateThreadReceiptResult(result, {
          tenantId: prior.tenant_id,
          threadId: prior.thread_id,
        });
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }

      if (input.sourceFence !== undefined) {
        const source = this.#loadThread({
          tenantId: input.tenantId,
          threadId: input.sourceFence.threadId,
        });
        if (
          source?.spaceId !== input.sourceFence.spaceId ||
          source.revision !== input.sourceFence.expectedRevision
        ) {
          throw new RunStoreError("thread_fork_source_revision_conflict");
        }
      }

      const current = this.#loadThread({
        tenantId: input.tenantId,
        threadId,
      });
      if (input.expectedRevision !== (current?.revision ?? 0)) {
        throw new RunStoreError("revision_conflict");
      }
      if (input.tombstone !== undefined) {
        const activeRuns = this.#database
          .prepare(
            `SELECT snapshots.run_id
             FROM run_snapshots AS snapshots
             JOIN run_thread_bindings AS bindings
               ON bindings.tenant_id = snapshots.tenant_id
              AND bindings.run_id = snapshots.run_id
             WHERE snapshots.tenant_id = ?
               AND bindings.thread_id = ?
               AND json_extract(snapshots.state_json, '$.status')
                   NOT IN ('completed', 'failed', 'canceled')`,
          )
          .all(input.tenantId, threadId) as unknown as { run_id: string }[];
        if (activeRuns.length > 1) {
          throw new RunStoreError("thread_active_run_invariant");
        }
        if (activeRuns.length !== 0) {
          throw new RunStoreError("thread_active_run_conflict");
        }
        const unsettledWork = this.#database
          .prepare(
            `SELECT work.work_item_id
             FROM work_items AS work
             JOIN run_thread_bindings AS bindings
               ON bindings.tenant_id = work.tenant_id
              AND bindings.run_id = work.run_id
             WHERE work.tenant_id = ?
               AND bindings.thread_id = ?
               AND work.status != 'completed'`,
          )
          .all(input.tenantId, threadId) as unknown as {
          work_item_id: string;
        }[];
        if (unsettledWork.length !== 0) {
          throw new RunStoreError("thread_active_work_conflict");
        }
        const currentGoal = this.#loadThreadGoal({
          tenantId: input.tenantId,
          threadId,
        });
        if (
          (currentGoal?.revision ?? null) !==
          input.tombstone.expectedGoalRevision
        ) {
          throw new RunStoreError("goal_revision_conflict");
        }
      }
      validateThreadEvents(input.events, threadId, (eventId) =>
        this.#threadEventIdExists(eventId),
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
        (messageId) => this.#messageIdExists(messageId),
      );
      validateModelHistoryAppend(
        input.history,
        { tenantId: input.tenantId, threadId },
        this.#loadAllModelHistoryItems({
          tenantId: input.tenantId,
          threadId,
        }),
        (itemId) => this.#modelHistoryItemIdExists(itemId),
      );

      this.#writeThreadSnapshot(current, next, input.expectedRevision);
      this.#writeThreadEvents(input.events, input.tenantId);
      this.#writeMessages(input.messages);
      this.#writeModelHistoryItems(input.history.items);
      if (input.tombstone !== undefined) {
        this.#writeTurnStartGoal(
          {
            kind: "clear",
            expectedRevision: input.tombstone.expectedGoalRevision,
            occurredAt: input.tombstone.occurredAt,
          },
          null,
          input.tenantId,
          threadId,
        );
      }
      const result: CommitThreadResult = {
        disposition: "committed",
        state: next,
        events: input.events,
        messages: input.messages,
        historyItems: input.history.items,
      };
      this.#database
        .prepare(
          `INSERT INTO thread_idempotency_receipts (
            tenant_id,
            scope,
            idempotency_key,
            thread_id,
            fingerprint,
            result_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          threadId,
          fingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadRollbackReceipt(
    query: ThreadRollbackReceiptQuery,
  ): Promise<CommitThreadRollbackResult | null> {
    this.#assertOpen();
    validateThreadRollbackReceiptQuery(query);
    try {
      const prior = this.#loadThreadReceipt(
        query.idempotency.scope,
        query.idempotency.key,
      );
      if (prior === null) return null;
      if (prior.tenant_id !== query.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== query.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const result = parseStoredJson<CommitThreadRollbackResult>(
        prior.result_json,
        "thread_rollback_receipt_invalid",
      );
      validateThreadRollbackReceiptResult(result, query);
      this.#validateStoredRollbackReceiptAuthority(result);
      return clone({ ...result, disposition: "replayed" });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async commitThreadRollback(
    input: CommitThreadRollbackInput,
  ): Promise<CommitThreadRollbackResult> {
    this.#assertOpen();
    const threadId = input.event.identity.threadId;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadThreadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = parseStoredJson<CommitThreadRollbackResult>(
          prior.result_json,
          "thread_rollback_receipt_invalid",
        );
        validateThreadRollbackReceiptResult(result, {
          tenantId: prior.tenant_id,
          threadId: prior.thread_id,
        });
        this.#validateStoredRollbackReceiptAuthority(result);
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }

      const activeRuns = this.#database
        .prepare(
          `SELECT snapshots.run_id
           FROM run_snapshots AS snapshots
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = snapshots.tenant_id
            AND bindings.run_id = snapshots.run_id
           WHERE snapshots.tenant_id = ?
             AND bindings.thread_id = ?
             AND json_extract(snapshots.state_json, '$.status')
                 NOT IN ('completed', 'failed', 'canceled')`,
        )
        .all(input.tenantId, threadId) as unknown as { run_id: string }[];
      if (activeRuns.length > 1) {
        throw new RunStoreError("thread_active_run_invariant");
      }
      if (activeRuns.length !== 0) {
        throw new RunStoreError("thread_active_run_conflict");
      }
      const unsettledWork = this.#database
        .prepare(
          `SELECT work.work_item_id
           FROM work_items AS work
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = work.tenant_id
            AND bindings.run_id = work.run_id
           WHERE work.tenant_id = ?
             AND bindings.thread_id = ?
             AND work.status != 'completed'`,
        )
        .all(input.tenantId, threadId) as unknown as {
        work_item_id: string;
      }[];
      if (unsettledWork.length !== 0) {
        throw new RunStoreError("thread_active_work_conflict");
      }

      const locator = { tenantId: input.tenantId, threadId };
      const current = this.#loadThread(locator);
      const history = this.#loadAllModelHistoryItems(locator);
      const messageRows = this.#database
        .prepare(
          `SELECT tenant_id, thread_id, sequence, message_id, role, content,
                  content_digest, created_at, message_json
           FROM messages
           WHERE tenant_id = ? AND thread_id = ?
           ORDER BY sequence ASC`,
        )
        .all(input.tenantId, threadId) as unknown as MessageRow[];
      const messages = messageRows.map((row) =>
        decodeStoredMessage(row, locator),
      );
      const prepared = prepareThreadRollbackCommit(
        input,
        current,
        history,
        messages,
      );
      validateThreadEvents([input.event], threadId, (eventId) =>
        this.#threadEventIdExists(eventId),
      );
      validateModelHistoryAppend(
        {
          expectedLastSequence: input.expectedHistorySequence,
          items: [input.marker],
        },
        locator,
        history,
        (itemId) => this.#modelHistoryItemIdExists(itemId),
      );

      const continuationCount = this.#database
        .prepare(
          `SELECT COUNT(*) AS value FROM thread_continuations
           WHERE tenant_id = ? AND thread_id = ?`,
        )
        .get(input.tenantId, threadId) as { value: number };
      const invalidatedModelState =
        this.#database
          .prepare(
            `SELECT 1 FROM thread_model_states
             WHERE tenant_id = ? AND thread_id = ?`,
          )
          .get(input.tenantId, threadId) !== undefined;

      this.#writeThreadSnapshot(
        current,
        prepared.state,
        input.expectedThreadRevision,
      );
      this.#writeThreadEvents([input.event], input.tenantId);
      this.#writeModelHistoryItems([input.marker]);
      const insertInvalidation = this.#database.prepare(
        `INSERT INTO message_invalidations (
           tenant_id, thread_id, message_sequence, history_sequence,
           rollback_id, marker_item_id, marker_history_sequence, invalidated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const invalidated of prepared.invalidatedMessages) {
        insertInvalidation.run(
          input.tenantId,
          threadId,
          invalidated.messageSequence,
          invalidated.invalidation.historySequence,
          invalidated.invalidation.rollbackId,
          invalidated.invalidation.markerItemId,
          input.marker.sequence,
          invalidated.invalidation.invalidatedAt,
        );
      }
      this.#database
        .prepare(
          `DELETE FROM thread_continuations
           WHERE tenant_id = ? AND thread_id = ?`,
        )
        .run(input.tenantId, threadId);
      this.#database
        .prepare(
          `DELETE FROM thread_model_states
           WHERE tenant_id = ? AND thread_id = ?`,
        )
        .run(input.tenantId, threadId);

      const result: CommitThreadRollbackResult = {
        disposition: "committed",
        state: prepared.state,
        event: input.event,
        marker: input.marker,
        invalidatedMessages: prepared.invalidatedMessages,
        invalidatedContinuationCount: continuationCount.value,
        invalidatedModelState,
      };
      this.#database
        .prepare(
          `INSERT INTO thread_rollback_commits (
             tenant_id, thread_id, rollback_id, event_sequence,
             marker_history_sequence, invalidated_continuation_count,
             invalidated_model_state, committed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          threadId,
          input.marker.rollbackId,
          input.event.sequence,
          input.marker.sequence,
          continuationCount.value,
          invalidatedModelState ? 1 : 0,
          input.event.occurredAt,
        );
      this.#database
        .prepare(
          `INSERT INTO thread_idempotency_receipts (
             tenant_id, scope, idempotency_key, thread_id, fingerprint,
             result_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          threadId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadTurnStartReceipt(
    query: TurnStartReceiptQuery,
  ): Promise<CommitTurnStartResult | null> {
    this.#assertOpen();
    validateTurnStartReceiptQuery(query);
    try {
      const prior = this.#loadReceipt(
        query.idempotency.scope,
        query.idempotency.key,
      );
      if (prior === null) return null;
      if (prior.tenant_id !== query.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== query.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const result = normalizeStoredTurnStartResult(
        parseStoredJson<CommitTurnStartResult>(
          prior.result_json,
          "turn_start_idempotency_receipt_invalid",
        ),
      );
      validateStoredTurnStartReceiptResult(result, prior, query.threadId);
      return clone({ ...result, disposition: "replayed" });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async commitTurnStart(
    input: CommitTurnStartInput,
  ): Promise<CommitTurnStartResult> {
    this.#assertOpen();
    const { runId, threadId } = validateTurnStartInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = normalizeStoredTurnStartResult(
          parseStoredJson<CommitTurnStartResult>(
            prior.result_json,
            "turn_start_idempotency_receipt_invalid",
          ),
        );
        validateStoredTurnStartReceiptResult(result, prior, threadId);
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }

      if (this.#hasPendingProviderSwitch(input.tenantId)) {
        throw new RunStoreError("model_provider_settings_switch_pending");
      }

      const currentThread = this.#loadThread({
        tenantId: input.tenantId,
        threadId,
      });
      if (currentThread === null) {
        throw new RunStoreError("thread_not_found");
      }
      if (currentThread.revision !== input.thread.expectedRevision) {
        throw new RunStoreError("revision_conflict");
      }
      if (currentThread.status !== "active") {
        throw new RunStoreError("thread_not_active");
      }
      const activeRun = this.#database
        .prepare(
          `SELECT 1
           FROM run_snapshots AS snapshots
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = snapshots.tenant_id
            AND bindings.run_id = snapshots.run_id
           WHERE snapshots.tenant_id = ?
             AND bindings.thread_id = ?
             AND json_extract(snapshots.state_json, '$.status')
                 NOT IN ('completed', 'failed', 'canceled')
           LIMIT 1`,
        )
        .get(input.tenantId, threadId);
      if (activeRun !== undefined) {
        throw new RunStoreError("thread_active_run_conflict");
      }
      if (this.#loadRun({ tenantId: input.tenantId, runId }) !== null) {
        throw new RunStoreError("revision_conflict");
      }
      const nextGoal = applyTurnStartGoalMutation(
        this.#loadThreadGoal({ tenantId: input.tenantId, threadId }),
        input.goal,
        { tenantId: input.tenantId, threadId },
      );
      validateTurnStartGoalBinding(nextGoal, input);

      validateThreadEvents(input.thread.events, threadId, (eventId) =>
        this.#threadEventIdExists(eventId),
      );
      validateMessages(
        input.thread.messages,
        input.thread.events,
        threadId,
        input.tenantId,
        (messageId) => this.#messageIdExists(messageId),
      );
      validateModelHistoryAppend(
        input.thread.history,
        { tenantId: input.tenantId, threadId },
        this.#loadAllModelHistoryItems({
          tenantId: input.tenantId,
          threadId,
        }),
        (itemId) => this.#modelHistoryItemIdExists(itemId),
      );
      let nextThread: ThreadState | null = currentThread;
      for (const event of input.thread.events) {
        nextThread = reduceThreadLifecycleEvent(nextThread, event);
      }
      if (nextThread === null) {
        throw new RunStoreError("thread_events_empty");
      }

      validateEvents(input.run.events, runId, (eventId) =>
        this.#eventIdExists(eventId),
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
        this.#outboxMessageIdExists(messageId),
      );
      validateWorkItems(
        input.run.workItems,
        runId,
        input.tenantId,
        input.run.events.at(-1)?.sequence ?? 0,
        (workItemId) => this.#workItemIdExists(workItemId),
      );

      this.#writeThreadSnapshot(
        currentThread,
        nextThread,
        input.thread.expectedRevision,
      );
      this.#writeThreadEvents(input.thread.events, input.tenantId);
      this.#writeMessages(input.thread.messages);
      this.#writeModelHistoryItems(input.thread.history.items);
      this.#writeTurnStartGoal(input.goal, nextGoal, input.tenantId, threadId);
      this.#writeSnapshot(null, nextRun, input.run.expectedRevision);
      this.#writeRunThreadBinding(null, nextRun);
      this.#writeEvents(input.run.events, input.tenantId);
      this.#writeOutbox(input.run.outbox);
      this.#writeWorkItems(input.run.workItems);
      const result: CommitTurnStartResult = {
        disposition: "committed",
        threadState: nextThread,
        runState: nextRun,
        goalState: nextGoal,
        threadEvents: input.thread.events,
        messages: input.thread.messages,
        historyItems: input.thread.history.items,
        runEvents: input.run.events,
        outbox: input.run.outbox,
        workItems: input.run.workItems,
      };
      this.#database
        .prepare(
          `INSERT INTO idempotency_receipts (
            tenant_id,
            scope,
            idempotency_key,
            run_id,
            fingerprint,
            result_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          runId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async listMessages(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
    view: MessageView = "standard",
  ): Promise<readonly MessageRecord[]> {
    this.#assertOpen();
    validateMessagePage(locator, afterSequence, limit);
    validateMessageView(view);
    try {
      const rows = this.#database
        .prepare(
          `SELECT
             messages.tenant_id,
             messages.thread_id,
             messages.sequence,
             messages.message_id,
             messages.role,
             messages.content,
             messages.content_digest,
             messages.created_at,
             messages.message_json,
             invalidations.rollback_id,
             invalidations.marker_item_id,
             invalidations.history_sequence,
             invalidations.invalidated_at
           FROM messages
           LEFT JOIN message_invalidations AS invalidations
             ON invalidations.tenant_id = messages.tenant_id
            AND invalidations.thread_id = messages.thread_id
            AND invalidations.message_sequence = messages.sequence
           WHERE messages.tenant_id = ?
             AND messages.thread_id = ?
             AND messages.sequence > ?
             AND (? = 'audit' OR invalidations.message_sequence IS NULL)
           ORDER BY messages.sequence ASC
           LIMIT ?`,
        )
        .all(
          locator.tenantId,
          locator.threadId,
          afterSequence,
          view,
          limit,
        ) as unknown as MessageRow[];
      return rows.map((row) => decodeStoredMessage(row, locator, view));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listThreadEvents(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ThreadLifecycleEvent[]> {
    this.#assertOpen();
    validateThreadLocator(locator);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RunStoreError("after_sequence_invalid");
    }
    validateLimit(limit);
    try {
      const rows = this.#database
        .prepare(
          `SELECT tenant_id, thread_id, sequence, event_id, event_json
           FROM thread_events
           WHERE tenant_id = ? AND thread_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`,
        )
        .all(
          locator.tenantId,
          locator.threadId,
          afterSequence,
          limit,
        ) as unknown as ThreadEventRow[];
      const events = rows.map((row) =>
        decodeStoredThreadEvent(
          {
            tenantId: row.tenant_id,
            threadId: row.thread_id,
            sequence: row.sequence,
            eventId: row.event_id,
            eventJson: row.event_json,
          },
          locator,
        ),
      );
      validateStoredThreadEventPage(events, locator, afterSequence);
      return events;
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadModelHistoryHead(
    locator: ThreadLocator,
  ): Promise<import("@crewon/domain").ModelHistoryHead | null> {
    this.#assertOpen();
    validateThreadLocator(locator);
    try {
      if (this.#loadThread(locator) === null) {
        return null;
      }
      const row = this.#database
        .prepare(
          `SELECT MAX(sequence) AS last_sequence
           FROM model_history_items
           WHERE tenant_id = ? AND thread_id = ?`,
        )
        .get(locator.tenantId, locator.threadId) as
        | { last_sequence: number | null }
        | undefined;
      return {
        tenantId: locator.tenantId,
        threadId: locator.threadId,
        lastSequence: row?.last_sequence ?? 0,
      };
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ModelHistoryItem[]> {
    this.#assertOpen();
    validateModelHistoryPage(locator, afterSequence, limit);
    try {
      if (this.#loadThread(locator) === null) {
        return [];
      }
      return this.#loadModelHistoryItems(locator, afterSequence, limit);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadRun(locator: RunLocator): Promise<RunState | null> {
    this.#assertOpen();
    validateRunLocator(locator);
    try {
      return this.#loadRun(locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadRunReceipt(
    query: RunReceiptQuery,
  ): Promise<CommitRunResult | null> {
    this.#assertOpen();
    validateRunReceiptQuery(query);
    try {
      const prior = this.#loadReceipt(
        query.idempotency.scope,
        query.idempotency.key,
      );
      if (prior === null) return null;
      if (prior.tenant_id !== query.tenantId) {
        throw new RunStoreError("tenant_id_mismatch");
      }
      if (prior.fingerprint !== query.idempotency.requestFingerprint) {
        throw new RunStoreError("idempotency_conflict");
      }
      const result = normalizeStoredRunResult(
        parseStoredJson<CommitRunResult>(
          prior.result_json,
          "idempotency_receipt_invalid",
        ),
      );
      validateStoredReceiptResult(result, prior);
      if (result.state.threadId !== query.threadId) {
        throw new RunStoreError("idempotency_receipt_invalid");
      }
      return clone({ ...result, disposition: "replayed" });
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listThreadRuns(
    query: ThreadRunListQuery,
  ): Promise<readonly RunState[]> {
    this.#assertOpen();
    validateThreadRunListQuery(query);
    try {
      const rows = this.#database
        .prepare(
          `SELECT
             snapshots.tenant_id,
             snapshots.space_id,
             snapshots.run_id,
             snapshots.revision,
             snapshots.last_sequence,
             snapshots.state_json,
             bindings.thread_id
           FROM run_snapshots AS snapshots
           JOIN run_thread_bindings AS bindings
             ON bindings.tenant_id = snapshots.tenant_id
            AND bindings.run_id = snapshots.run_id
           WHERE snapshots.tenant_id = ?
             AND snapshots.space_id = ?
             AND bindings.thread_id = ?
             AND (? IS NULL OR snapshots.updated_at < ? OR (snapshots.updated_at = ? AND snapshots.run_id < ?))
           ORDER BY snapshots.updated_at DESC, snapshots.run_id DESC
           LIMIT ?`,
        )
        .all(
          query.tenantId,
          query.spaceId,
          query.threadId,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.updatedAt ?? null,
          query.before?.runId ?? null,
          query.limit,
        ) as unknown as SnapshotRow[];
      return rows.map((row) =>
        decodeStoredRunState(row, {
          tenantId: query.tenantId,
          runId: row.run_id,
        }),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadRunStep(locator: RunStepLocator) {
    this.#assertOpen();
    validateRunStepLocator(locator);
    try {
      return clone(loadSqliteRunStep(this.#database, locator));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadRunAttempt(locator: RunAttemptLocator) {
    this.#assertOpen();
    validateRunAttemptLocator(locator);
    try {
      return clone(loadSqliteRunAttempt(this.#database, locator));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listRunAttempts(
    locator: RunStepLocator,
    afterAttemptNumber: number,
    limit: number,
  ) {
    this.#assertOpen();
    validateRunAttemptPage(locator, afterAttemptNumber, limit);
    try {
      return clone(
        listSqliteRunAttempts(
          this.#database,
          locator,
          afterAttemptNumber,
          limit,
        ),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadRunProviderTurnState(
    locator: Readonly<{
      tenantId: string;
      runId: string;
    }>,
  ) {
    this.#assertOpen();
    try {
      return loadSqliteRunProviderTurnState(this.#database, locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async beginRunAttempt(
    input: BeginRunAttemptInput,
  ): Promise<BeginRunAttemptResult> {
    this.#assertOpen();
    validateBeginRunAttemptInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const run = this.#loadRun({
        tenantId: input.tenantId,
        runId: input.runId,
      });
      if (run === null) {
        throw new RunStoreError("execution_authority_mismatch");
      }
      if (
        run.status !== "running" &&
        !(run.status === "reconciling" && input.mode === "reconcile")
      ) {
        throw new RunStoreError("run_not_running_conflict");
      }
      const result = beginSqliteRunAttempt(this.#database, input);
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async checkpointRunAttempt(input: CheckpointRunAttemptInput) {
    this.#assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const result = checkpointSqliteRunAttempt(
        this.#database,
        { tenantId: input.tenantId, runId: input.runId, ...input.attempt },
        input.lease.workItemId,
        input.lease.leaseEpoch,
        input.checkpoint,
        input.checkpointDigest,
        input.checkpointedAt,
      );
      if (input.modelDispatch !== undefined) {
        observeSqliteModelDispatchResponse(this.#database, {
          tenantId: input.tenantId,
          runId: input.runId,
          lease: input.lease,
          attempt: input.attempt,
          operationId: input.modelDispatch.operationId,
          requestSequence: input.modelDispatch.requestSequence,
          expectedRevision: input.modelDispatch.expectedRevision,
          checkpointDigest: input.checkpointDigest,
          transitionedAt: input.checkpointedAt,
        });
      }
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadModelDispatchReceipt(
    locator: RunAttemptLocator & Readonly<{ operationId: string }>,
  ) {
    this.#assertOpen();
    try {
      return clone(loadSqliteModelDispatchReceipt(this.#database, locator));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async prepareModelDispatch(input: PrepareModelDispatchInput) {
    return this.#mutateModelDispatch(input, () =>
      prepareSqliteModelDispatch(this.#database, input),
    );
  }

  async markModelDispatchPossiblySent(input: TransitionModelDispatchInput) {
    return this.#mutateModelDispatch(input, () =>
      markSqliteModelDispatchPossiblySent(this.#database, input),
    );
  }

  async observeModelDispatchResponse(input: ObserveModelDispatchResponseInput) {
    return this.#mutateModelDispatch(input, () =>
      observeSqliteModelDispatchResponse(this.#database, input),
    );
  }

  async terminateModelDispatch(input: TerminateModelDispatchInput) {
    return this.#mutateModelDispatch(input, () =>
      terminateSqliteModelDispatch(this.#database, input),
    );
  }

  async #mutateModelDispatch(
    input: PrepareModelDispatchInput | TransitionModelDispatchInput,
    mutation: () => import("@crewon/domain").ModelDispatchReceipt,
  ) {
    this.#assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const result = mutation();
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async recordRunAttemptProviderTurnState(
    input: import("@crewon/application").RecordRunAttemptProviderTurnStateInput,
  ) {
    validateRecordRunAttemptProviderTurnStateInput(input);
    this.#assertOpen();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const result = recordSqliteRunAttemptProviderTurnState(
        this.#database,
        { tenantId: input.tenantId, runId: input.runId, ...input.attempt },
        input.lease.workItemId,
        input.lease.leaseEpoch,
        input.providerTurnState,
        input.observedAt,
      );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadToolExecutionReceipt(
    locator: ToolExecutionReceiptLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    this.#assertOpen();
    validateToolExecutionReceiptLocator(locator);
    try {
      return clone(loadSqliteToolExecutionReceipt(this.#database, locator));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadToolApproval(
    locator: ToolApprovalLocator,
  ): Promise<ToolApprovalState | null> {
    this.#assertOpen();
    validateApprovalLocator(locator);
    try {
      return loadSqliteToolApproval(this.#database, locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadToolApprovalByAction(
    locator: ToolApprovalActionLocator,
  ): Promise<ToolApprovalState | null> {
    this.#assertOpen();
    validateApprovalActionLocator(locator);
    try {
      return loadSqliteToolApprovalByAction(this.#database, locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadLatestToolApprovalForRun(
    locator: ToolApprovalRunLocator,
  ): Promise<ToolApprovalState | null> {
    this.#assertOpen();
    requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
    requireNonEmpty(locator.runId, "approval_run_id_invalid");
    try {
      return loadLatestSqliteToolApprovalForRun(this.#database, locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async requireToolApproval(
    input: RequireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.#assertOpen();
    validateRequiredApproval(input.approval);
    validateQueueRetry({
      ...input.lease,
      retryAfterMs: input.retryAfterMs,
      reasonCode: "tool_approval_required",
    });
    validateApprovalRunCommit(input.approval, input.commit, "require");
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.approval.tenantId,
        input.approval.runId,
        input.lease,
        now,
      );
      const receipt = loadSqliteToolExecutionReceipt(this.#database, {
        tenantId: input.approval.tenantId,
        runId: input.approval.runId,
        receiptId: input.approval.receiptId,
      });
      validateApprovalReceiptBinding(input.approval, receipt ?? undefined);
      if (
        loadSqliteToolApproval(this.#database, input.approval) !== null ||
        loadSqliteToolApprovalByAction(this.#database, input.approval) !== null
      ) {
        throw new RunStoreError("tool_approval_conflict");
      }
      const run = this.#commitRun(input.commit, input.lease, null, true);
      insertSqliteToolApproval(this.#database, input.approval);
      this.#retryWorkItemWithinTransaction(
        {
          ...input.lease,
          retryAfterMs: input.retryAfterMs,
          reasonCode: "tool_approval_required",
        },
        now,
      );
      this.#database.exec("COMMIT");
      return clone({ approval: input.approval, run });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async decideToolApproval(
    input: DecideToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.#assertOpen();
    validateApprovalLocator(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = loadSqliteToolApproval(this.#database, input);
      if (current === null) {
        throw new RunStoreError("tool_approval_not_found");
      }
      let approval: ToolApprovalState;
      try {
        approval = decideToolApprovalState(current, {
          ...input.decision,
          expectedRevision: input.expectedRevision,
        });
      } catch (error) {
        throw normalizeToolApprovalError(error);
      }
      validateApprovalRunCommit(approval, input.commit, "decide");
      const workItem = this.#database
        .prepare(
          `SELECT tenant_id, run_id, status, lease_owner_id, lease_id, lease_expires_at_ms
           FROM work_items
           WHERE work_item_id = ?`,
        )
        .get(approval.workItemId) as
        | {
            tenant_id: string;
            run_id: string;
            status: string;
            lease_owner_id: string | null;
            lease_id: string | null;
            lease_expires_at_ms: number | null;
          }
        | undefined;
      if (
        workItem?.tenant_id !== approval.tenantId ||
        workItem.run_id !== approval.runId ||
        workItem.status !== "pending" ||
        workItem.lease_owner_id !== null ||
        workItem.lease_id !== null ||
        workItem.lease_expires_at_ms !== null
      ) {
        throw new RunStoreError("approval_work_item_not_held");
      }
      const run = this.#commitRun(input.commit, null, null, true);
      updateSqliteToolApproval(this.#database, current, approval);
      const wake = this.#database
        .prepare(
          `UPDATE work_items
           SET available_at_ms = ?, last_error_code = NULL
           WHERE work_item_id = ? AND status = 'pending'`,
        )
        .run(now, approval.workItemId);
      if (wake.changes !== 1) {
        throw new RunStoreError("approval_work_item_wake_conflict");
      }
      this.#database.exec("COMMIT");
      return clone({ approval, run });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async expireToolApproval(
    input: ExpireToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.#assertOpen();
    validateApprovalLocator(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = loadSqliteToolApproval(this.#database, input);
      if (current === null) {
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
      const run = this.#commitRun(input.commit, input.lease, null, true);
      updateSqliteToolApproval(this.#database, current, approval);
      this.#database.exec("COMMIT");
      return clone({ approval, run });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async supersedeToolApproval(
    input: SupersedeToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.#assertOpen();
    validateApprovalLocator(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = loadSqliteToolApproval(this.#database, input);
      if (current === null) {
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
      const run = this.#commitRun(input.commit, input.lease, null, true);
      updateSqliteToolApproval(this.#database, current, approval);
      this.#database.exec("COMMIT");
      return clone({ approval, run });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async replaceToolApproval(
    input: ReplaceToolApprovalInput,
  ): Promise<ToolApprovalCommitResult> {
    this.#assertOpen();
    validateRequiredApproval(input.replacement);
    validateQueueRetry({
      ...input.lease,
      retryAfterMs: input.retryAfterMs,
      reasonCode: "tool_approval_required",
    });
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const current = loadSqliteToolApproval(this.#database, input.current);
      if (current === null) {
        throw new RunStoreError("tool_approval_not_found");
      }
      const existing = loadSqliteToolApprovalByAction(
        this.#database,
        input.replacement,
      );
      if (existing !== null) {
        validateToolApprovalReplacementReplay(current, existing, input);
        const run = this.#commitRun(input.commit, null, null, true);
        this.#database.exec("COMMIT");
        return clone({ approval: existing, run });
      }
      this.#validateExecutionLease(
        current.tenantId,
        current.runId,
        input.lease,
        now,
      );
      validateToolApprovalReplacement(current, input);
      const receipt = loadSqliteToolExecutionReceipt(this.#database, {
        tenantId: input.replacement.tenantId,
        runId: input.replacement.runId,
        receiptId: input.replacement.receiptId,
      });
      validateApprovalReceiptBinding(input.replacement, receipt ?? undefined);
      if (
        loadSqliteToolApproval(this.#database, input.replacement) !== null ||
        loadSqliteToolApprovalByAction(this.#database, input.replacement) !==
          null
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
      const run = this.#commitRun(input.commit, input.lease, null, true);
      updateSqliteToolApproval(this.#database, current, superseded);
      insertSqliteToolApproval(this.#database, input.replacement);
      this.#retryWorkItemWithinTransaction(
        {
          ...input.lease,
          retryAfterMs: input.retryAfterMs,
          reasonCode: "tool_approval_required",
        },
        now,
      );
      this.#database.exec("COMMIT");
      return clone({ approval: input.replacement, run });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadToolExecutionReceiptByAction(
    locator: ToolExecutionActionLocator,
  ): Promise<ToolExecutionReceiptState | null> {
    this.#assertOpen();
    validateToolExecutionActionLocator(locator);
    try {
      return clone(
        loadSqliteToolExecutionReceiptByAction(this.#database, locator),
      );
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async prepareToolExecution(
    input: PrepareToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    this.#assertOpen();
    validatePrepareToolExecutionInput(input);
    const { receipt } = input;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        receipt.tenantId,
        receipt.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const step = loadSqliteRunStep(this.#database, receipt);
      const attempt = loadSqliteRunAttempt(this.#database, receipt);
      if (
        step?.currentAttemptId !== receipt.attemptId ||
        attempt?.status !== "running" ||
        attempt.workItemId !== receipt.workItemId
      ) {
        throw new RunStoreError("tool_receipt_attempt_not_current");
      }
      insertSqliteToolExecutionReceipt(this.#database, receipt);
      this.#database.exec("COMMIT");
      return clone(receipt);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async transitionToolExecution(
    input: TransitionToolExecutionInput,
  ): Promise<ToolExecutionReceiptState> {
    this.#assertOpen();
    validateTransitionToolExecutionInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const current = loadSqliteToolExecutionReceipt(this.#database, input);
      if (current === null) {
        throw new RunStoreError("tool_receipt_not_found");
      }
      const next = applyToolExecutionTransition(current, input);
      updateSqliteToolExecutionReceipt(this.#database, current, next);
      this.#database.exec("COMMIT");
      return clone(next);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async commitToolExecutionCompletion(
    input: CommitToolExecutionCompletionInput,
  ): Promise<CommitToolExecutionCompletionResult> {
    this.#assertOpen();
    const runId = validateToolExecutionCompletionInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.commit.tenantId,
        runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const current = loadSqliteToolExecutionReceipt(
        this.#database,
        input.receipt,
      );
      if (current === null) {
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
      const prior = this.#loadReceipt(
        input.commit.idempotency.scope,
        input.commit.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.commit.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const run = normalizeStoredRunResult(
          parseStoredJson<CommitRunResult>(
            prior.result_json,
            "idempotency_receipt_invalid",
          ),
        );
        validateStoredReceiptResult(run, prior);
        const replay = validateToolExecutionCompletionReplay(
          input,
          current,
          loadSqliteRunStep(this.#database, current),
          loadSqliteRunAttempt(this.#database, current),
        );
        this.#database.exec("COMMIT");
        return clone({
          run: { ...run, disposition: "replayed" },
          receipt: current,
          ...replay,
        });
      }
      const currentRun = this.#loadRun({
        tenantId: input.commit.tenantId,
        runId,
      });
      if (currentRun === null) throw new RunStoreError("run_not_found");
      const currentGoal = this.#loadThreadGoal({
        tenantId: currentRun.tenantId,
        threadId: currentRun.threadId,
      });
      const nextGoal = applyToolCompletionGoalMutation(
        currentGoal,
        input,
        currentRun,
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
      const execution = finishSqliteRunAttempt(this.#database, {
        tenantId: input.commit.tenantId,
        runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: {
          ...input.attempt,
          status: "completed",
          checkpointDigest: null,
        },
      });
      const run = this.#commitRun(
        input.commit,
        input.lease,
        input.history,
        true,
      );
      if (run.disposition === "committed" && nextGoal !== currentGoal) {
        this.#writeTurnStartGoal(
          input.goal,
          nextGoal,
          currentRun.tenantId,
          currentRun.threadId,
        );
      }
      updateSqliteToolExecutionReceipt(this.#database, current, receipt);
      this.#database.exec("COMMIT");
      return clone({
        run,
        receipt,
        step: execution.step,
        attempt: execution.attempt,
      });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async commitToolExecutionUnknownOutcome(
    input: CommitToolExecutionUnknownOutcomeInput,
  ): Promise<CommitToolExecutionUnknownOutcomeResult> {
    this.#assertOpen();
    const runId = validateToolExecutionUnknownOutcomeInput(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.commit.tenantId,
        runId,
        input.lease,
        now,
      );
      const current = loadSqliteToolExecutionReceipt(
        this.#database,
        input.receipt,
      );
      if (current === null) {
        throw new RunStoreError("tool_receipt_not_found");
      }
      const receipt = applyToolExecutionUnknownOutcome(current, input);
      const execution = finishSqliteRunAttempt(this.#database, {
        tenantId: input.commit.tenantId,
        runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: {
          ...input.attempt,
          status: "failed",
          checkpointDigest: null,
          failure: { code: "tool_outcome_unknown", retryable: true },
        },
      });
      const run = this.#commitRun(input.commit, input.lease, null, true);
      if (receipt !== current) {
        updateSqliteToolExecutionReceipt(this.#database, current, receipt);
      }
      this.#retryWorkItemWithinTransaction(
        {
          ...input.lease,
          retryAfterMs: input.retryAfterMs,
          reasonCode: "tool_outcome_unknown",
        },
        now,
      );
      this.#database.exec("COMMIT");
      return clone({
        run,
        receipt,
        step: execution.step,
        attempt: execution.attempt,
      });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async retryRunAttempt(
    input: RetryRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    this.#assertOpen();
    validateRetryRunAttemptInput(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        now,
      );
      const result = finishSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId,
        runId: input.runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: { ...input.attempt, status: "failed" },
      });
      this.#retryWorkItemWithinTransaction(
        {
          ...input.lease,
          retryAfterMs: input.retryAfterMs,
          reasonCode: input.attempt.failure.code,
        },
        now,
      );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async completeRunAttempt(
    input: CompleteRunAttemptInput,
  ): Promise<RunAttemptTransitionResult> {
    this.#assertOpen();
    validateCompleteRunAttemptInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.tenantId,
        input.runId,
        input.lease,
        readLeaseClock(this.#clock),
      );
      const result = finishSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId,
        runId: input.runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: { ...input.attempt, status: "completed" },
      });
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadContinuation(
    locator: ThreadContinuationLocator,
  ): Promise<ThreadContinuationCheckpoint | null> {
    this.#assertOpen();
    validateThreadContinuationLocator(locator);
    try {
      return this.#loadThreadContinuation(locator);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async loadThreadModelState(
    locator: Readonly<{ tenantId: string; threadId: string }>,
  ): Promise<ThreadModelState | null> {
    this.#assertOpen();
    requireNonEmpty(locator.tenantId, "tenant_id_invalid");
    requireNonEmpty(locator.threadId, "thread_id_invalid");
    try {
      const row = this.#database
        .prepare(
          `SELECT state_json
           FROM thread_model_states
           WHERE tenant_id = ? AND thread_id = ?`,
        )
        .get(locator.tenantId, locator.threadId) as
        | ThreadModelStateRow
        | undefined;
      if (row === undefined) {
        return null;
      }
      const state = parseStoredJson<ThreadModelState>(
        row.state_json,
        "stored_thread_model_state_invalid",
      );
      validateThreadModelState(state);
      if (
        state.tenantId !== locator.tenantId ||
        state.threadId !== locator.threadId
      ) {
        throw new RunStoreError("stored_thread_model_state_invalid");
      }
      return clone(state);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async commitRun(input: CommitRunInput): Promise<CommitRunResult> {
    return this.#commitRun(input, null, null);
  }

  async commitWorkflowRunStart(
    input: CommitWorkflowRunStartInput,
  ): Promise<CommitWorkflowRunStartResult> {
    this.#assertOpen();
    if (this.#workflowDigester === null)
      throw new RunStoreError("workflow_run_admission_not_configured");
    const workflowDigester = this.#workflowDigester;
    const replay = this.#readWorkflowAdmissionReplay(input);
    if (replay !== null) return replay;
    const candidateRoute = await input.resolveCandidateRoute();
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const concurrentReplay = this.#loadWorkflowAdmissionReplay(input);
      if (concurrentReplay !== null) {
        this.#database.exec("COMMIT");
        return concurrentReplay;
      }
      const thread = this.#loadThread({ tenantId: input.tenantId,
        threadId: input.threadId });
      if (thread === null || thread.spaceId !== input.spaceId ||
          thread.status !== "active")
        throw new RunStoreError("thread_not_active");
      const row = this.#database.prepare(
        `SELECT tenant_id,workflow_id,workflow_version_id,content_digest,
                definition_json,created_at FROM workflow_versions
         WHERE tenant_id=? AND workflow_version_id=?`,
      ).get(input.tenantId, input.workflowVersionId) as
        | { tenant_id: string; workflow_id: string; workflow_version_id: string;
            content_digest: string; definition_json: string; created_at: string }
        | undefined;
      if (row === undefined) throw new RunStoreError("workflow_version_not_found");
      const compiled = parseCompiledWorkflowVersion(
        row.definition_json, workflowDigester);
      if (compiled.workflowId !== row.workflow_id ||
          compiled.workflowVersionId !== row.workflow_version_id ||
          compiled.contentDigest !== row.content_digest)
        throw new RunStoreError("workflow_version_corrupt");
      const workflowVersion = { schemaVersion: "crewon.workflow-version-asset.v0" as const,
        tenantId: row.tenant_id, workflowId: row.workflow_id,
        workflowVersionId: row.workflow_version_id, contentDigest: row.content_digest,
        definitionJson: row.definition_json, createdAt: row.created_at };
      const activeRelease = this.#loadActiveAgentVersionRelease(input.tenantId);
      if (activeRelease === null) throw new RunStoreError("agent_version_release_not_active");
      const ids = [...new Set(compiled.nodes.flatMap((node) =>
        node.kind === "humanGate" ? []
          : [node.kind === "verification" ? node.verifierAgentVersionId : node.agentVersionId]))];
      const deployments = ids.map((agentVersionId) => {
        const deployment = this.#loadAgentVersionDeployment({ tenantId: input.tenantId,
          agentVersionId });
        const asset = this.#loadAgentVersion({ tenantId: input.tenantId, agentVersionId });
        const candidate = activeRelease.bundle.deployments.find(
          (item) => item.agentVersionId === agentVersionId);
        if (deployment === null || asset === null || candidate === undefined ||
            deployment.contentDigest !== asset.contentDigest)
          throw new RunStoreError("workflow_agent_deployment_mismatch");
        if (!sameAgentVersionDeploymentCandidate(candidate, deployment))
          throw new RunStoreError("workflow_agent_deployment_mismatch");
        const compiledAgent = parseCompiledAgentVersion(
          asset.definitionJson, workflowDigester);
        if (compiledAgent.agentVersionId !== asset.agentVersionId ||
            compiledAgent.contentDigest !== asset.contentDigest)
          throw new RunStoreError("workflow_agent_deployment_mismatch");
        return deployment;
      });
      const defaultId = activeRelease.bundle.defaultAgentVersionId;
      const defaultDeployment = this.#loadAgentVersionDeployment({ tenantId: input.tenantId,
        agentVersionId: defaultId });
      const defaultAsset = this.#loadAgentVersion({ tenantId: input.tenantId,
        agentVersionId: defaultId });
      const defaultCandidate = activeRelease.bundle.deployments.find(
        (item) => item.agentVersionId === defaultId);
      if (defaultDeployment === null || defaultAsset === null || defaultCandidate === undefined ||
          defaultDeployment.contentDigest !== defaultAsset.contentDigest ||
          !sameAgentVersionDeploymentCandidate(defaultCandidate, defaultDeployment))
        throw new RunStoreError("workflow_agent_deployment_mismatch");
      const compiledDefault = parseCompiledAgentVersion(
        defaultAsset.definitionJson, workflowDigester);
      if (compiledDefault.agentVersionId !== defaultAsset.agentVersionId ||
          compiledDefault.contentDigest !== defaultAsset.contentDigest)
        throw new RunStoreError("workflow_run_route_mismatch");
      const route = candidateRoute;
      if (route.agentVersionId !== defaultDeployment.agentVersionId ||
          route.authorityId !== defaultDeployment.authorityId ||
          route.workspaceBindingId !== defaultDeployment.workspaceBindingId ||
          route.runtimeGeneration !== compiledDefault.runtimeGeneration ||
          route.policySnapshotId !== compiledDefault.policySnapshotId)
        throw new RunStoreError("workflow_run_route_mismatch");
      const prepared = input.prepare({ workflowVersion, route });
      const rootJson = canonicalJson(prepared.workflowInputValue.value);
      if (prepared.workflowInputValue.schemaVersion !==
          "crewon.workflow-execution-value.v0" ||
          !/^[-A-Za-z0-9:._]{1,200}$/u.test(prepared.workflowInputValue.valueId) ||
          !/^sha256:[a-f0-9]{64}$/u.test(prepared.workflowInputValue.valueDigest) ||
          rootJson !== canonicalJson(input.workflowInput) ||
          new TextEncoder().encode(rootJson).byteLength > MAX_WORKFLOW_VALUE_BYTES ||
          workflowDigester.sha256(rootJson) !== prepared.workflowInputValue.valueDigest)
        throw new RunStoreError("workflow_execution_value_invalid");
      this.#validateWorkflowPreparedCommit(input, prepared.commit,
        workflowVersion, route, prepared.workflowInputValue);
      const run = this.#commitRun(prepared.commit, null, null, true, true);
      const work = run.workItems[0];
      const ref = { valueId: prepared.workflowInputValue.valueId,
        valueDigest: prepared.workflowInputValue.valueDigest };
      const payload = work?.payload as Record<string, unknown> | undefined;
      if (work === undefined || payload?.schemaVersion !==
          "crewon.workflow-scheduler-work-item.v1" ||
          payload.trigger !== "workflowScheduler" ||
          stableJson(payload.workflowInput) !== stableJson(ref) ||
          stableJson(payload.binding) !== stableJson({ workflowId: compiled.workflowId,
            workflowVersionId: compiled.workflowVersionId,
            contentDigest: compiled.contentDigest }) ||
          typeof payload.schedulerOperationId !== "string")
        throw new RunStoreError("workflow_scheduler_work_item_mismatch");
      this.#database.prepare(
        `INSERT INTO workflow_execution_values
         (tenant_id,run_id,value_id,role,node_id,value_digest,value_json,created_at)
         VALUES (?,?,?,'rootInput',NULL,?,?,?)`,
      ).run(input.tenantId, run.state.runId, ref.valueId, ref.valueDigest,
        rootJson, run.state.createdAt);
      const result = { authority: { workflowVersion, route }, run };
      this.#database.prepare(
        `INSERT INTO workflow_run_admission_receipts
         (tenant_id,scope,idempotency_key,fingerprint,run_id,result_json)
         VALUES (?,?,?,?,?,?)`,
      ).run(input.tenantId, input.idempotency.scope, input.idempotency.key,
        input.idempotency.requestFingerprint, run.state.runId, stableJson(result));
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async commitLeasedRun(input: CommitLeasedRunInput): Promise<CommitRunResult> {
    validateQueueLease(
      input.lease,
      input.lease.workItemId,
      "work_item_id_invalid",
    );
    return this.#commitRun(input.commit, input.lease, input.history);
  }

  async commitLeasedRunTerminal(
    input: CommitLeasedRunTerminalInput,
  ): Promise<CommitLeasedRunTerminalResult> {
    this.#assertOpen();
    const runId = validateLeasedRunTerminalInput(input);
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#validateExecutionLease(
        input.commit.tenantId,
        runId,
        input.lease,
        now,
      );
      const currentRun = this.#loadRun({
        tenantId: input.commit.tenantId,
        runId,
      });
      if (currentRun === null) throw new RunStoreError("run_not_found");
      const currentGoal = this.#loadThreadGoal({
        tenantId: currentRun.tenantId,
        threadId: currentRun.threadId,
      });
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
          this.#loadAllModelHistoryItems({
            tenantId: currentRun.tenantId,
            threadId: currentRun.threadId,
          }),
          (itemId) => this.#modelHistoryItemIdExists(itemId),
        );
      }
      const execution =
        input.attempt === null
          ? null
          : finishSqliteRunAttempt(this.#database, {
              tenantId: input.commit.tenantId,
              runId,
              workItemId: input.lease.workItemId,
              leaseEpoch: input.lease.leaseEpoch,
              attempt: input.attempt,
            });
      const run = this.#commitRun(
        input.commit,
        input.lease,
        input.history,
        true,
      );
      if (run.disposition === "committed" && nextGoal !== currentGoal) {
        this.#writeTurnStartGoal(
          input.goal,
          nextGoal,
          currentRun.tenantId,
          currentRun.threadId,
        );
      }
      this.#settleWorkItemWithinTransaction(input.lease, now);
      this.#database.exec("COMMIT");
      return clone({
        run,
        goalState: run.disposition === "committed" ? nextGoal : currentGoal,
        step: execution?.step ?? null,
        attempt: execution?.attempt ?? null,
      });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async commitContextCompaction(
    input: CommitContextCompactionInput,
  ): Promise<CommitContextCompactionResult> {
    this.#assertOpen();
    const runId = validateContextCompactionInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadReceipt(
        input.commit.idempotency.scope,
        input.commit.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.commit.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const run = normalizeStoredRunResult(
          parseStoredJson<CommitRunResult>(
            prior.result_json,
            "idempotency_receipt_invalid",
          ),
        );
        validateStoredReceiptResult(run, prior);
        const replay = validateContextCompactionReplay(
          input,
          loadSqliteRunStep(this.#database, {
            tenantId: input.commit.tenantId,
            runId,
            stepId: input.attempt.stepId,
          }),
          loadSqliteRunAttempt(this.#database, {
            tenantId: input.commit.tenantId,
            runId,
            ...input.attempt,
          }),
        );
        this.#database.exec("COMMIT");
        return clone({
          run: { ...run, disposition: "replayed" },
          ...replay,
        });
      }
      validateContextCompactionRunAuthority(
        input,
        this.#loadRun({ tenantId: input.commit.tenantId, runId }),
      );
      const now = readLeaseClock(this.#clock);
      this.#validateExecutionLease(
        input.commit.tenantId,
        runId,
        input.lease,
        now,
      );
      const execution = finishSqliteRunAttempt(this.#database, {
        tenantId: input.commit.tenantId,
        runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: {
          ...input.attempt,
          status: "completed",
          checkpointDigest: null,
        },
      });
      const run = this.#commitRun(
        input.commit,
        input.lease,
        input.history,
        true,
      );
      if (input.completion === "completeRun") {
        this.#settleWorkItemWithinTransaction(input.lease, now);
      }
      this.#database.exec("COMMIT");
      return clone({ run, step: execution.step, attempt: execution.attempt });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async commitAssistantSampleContinuation(
    input: CommitAssistantSampleContinuationInput,
  ): Promise<CommitAssistantSampleContinuationResult> {
    this.#assertOpen();
    const runId = validateAssistantSampleContinuationInput(input);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadReceipt(
        input.commit.idempotency.scope,
        input.commit.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.commit.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.commit.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const storedRun = normalizeStoredRunResult(
          parseStoredJson<CommitRunResult>(
            prior.result_json,
            "idempotency_receipt_invalid",
          ),
        );
        const step = loadSqliteRunStep(this.#database, {
          tenantId: input.commit.tenantId,
          runId,
          stepId: input.attempt.stepId,
        });
        const attempt = loadSqliteRunAttempt(this.#database, {
          tenantId: input.commit.tenantId,
          runId,
          ...input.attempt,
        });
        if (step === null || attempt?.status !== "completed") {
          throw new RunStoreError("assistant_sample_replay_conflict");
        }
        this.#database.exec("COMMIT");
        return clone({
          run: { ...storedRun, disposition: "replayed" },
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
      if (input.continuation !== null) {
        const storedAttempt = loadSqliteRunAttempt(this.#database, {
          tenantId: input.commit.tenantId,
          runId,
          ...input.attempt,
        });
        if (storedAttempt?.providerCheckpoint === null) {
          checkpointSqliteRunAttempt(
            this.#database,
            { tenantId: input.commit.tenantId, runId, ...input.attempt },
            input.lease.workItemId,
            input.lease.leaseEpoch,
            input.continuation.checkpoint,
            input.attempt.checkpointDigest!,
            input.attempt.finishedAt,
          );
        } else if (
          storedAttempt === null ||
          storedAttempt.checkpointDigest !== input.attempt.checkpointDigest ||
          stableJson(storedAttempt.providerCheckpoint) !==
            stableJson(input.continuation.checkpoint)
        ) {
          throw new RunStoreError("attempt_provider_checkpoint_conflict");
        }
      }
      const execution = finishSqliteRunAttempt(this.#database, {
        tenantId: input.commit.tenantId,
        runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: { ...input.attempt, status: "completed" },
      });
      const run = this.#commitRun(
        input.commit,
        input.lease,
        input.history,
        true,
      );
      this.#database
        .prepare(
          `INSERT INTO thread_model_states (tenant_id, thread_id, state_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, thread_id) DO UPDATE SET
           state_json = excluded.state_json, updated_at = excluded.updated_at`,
        )
        .run(
          input.modelState.tenantId,
          input.modelState.threadId,
          stableJson(input.modelState),
          input.modelState.updatedAt,
        );
      if (input.continuation !== null) {
        this.#database
          .prepare(
            `INSERT INTO thread_continuations (
             tenant_id, thread_id, agent_version_id, adapter_name,
             adapter_version, model_id, through_history_sequence,
             context_revision, checkpoint_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, thread_id, agent_version_id, adapter_name, adapter_version, model_id)
           DO UPDATE SET through_history_sequence = excluded.through_history_sequence,
             context_revision = excluded.context_revision,
             checkpoint_json = excluded.checkpoint_json,
             updated_at = excluded.updated_at`,
          )
          .run(
            input.continuation.tenantId,
            input.continuation.threadId,
            input.continuation.agentVersionId,
            input.continuation.adapterName,
            input.continuation.adapterVersion,
            input.continuation.modelId,
            input.continuation.throughHistorySequence,
            input.continuation.contextRevision,
            stableJson(input.continuation.checkpoint),
            input.continuation.updatedAt,
          );
      }
      this.#database.exec("COMMIT");
      return clone({
        run,
        step: execution.step,
        attempt: execution.attempt,
      });
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #commitRun(
    input: CommitRunInput,
    executionLease: WorkItemLeaseInput | null,
    history: ModelHistoryAppend | null,
    withinTransaction = false,
    workflowScheduler = false,
  ): CommitRunResult {
    this.#assertOpen();
    const runId = validateCommitInput(input);
    const fingerprint = input.idempotency.requestFingerprint;

    try {
      if (!withinTransaction) {
        this.#database.exec("BEGIN IMMEDIATE");
      }
      if (executionLease !== null) {
        this.#validateExecutionLease(
          input.tenantId,
          runId,
          executionLease,
          readLeaseClock(this.#clock),
        );
      }
      const prior = this.#loadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== fingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = normalizeStoredRunResult(
          parseStoredJson<CommitRunResult>(
            prior.result_json,
            "idempotency_receipt_invalid",
          ),
        );
        validateStoredReceiptResult(result, prior);
        if (!withinTransaction) {
          this.#database.exec("COMMIT");
        }
        return { ...result, disposition: "replayed" };
      }

      const current = this.#loadRun({ tenantId: input.tenantId, runId });
      if (current === null && this.#hasPendingProviderSwitch(input.tenantId)) {
        throw new RunStoreError("model_provider_settings_switch_pending");
      }
      const actualRevision = current?.revision ?? 0;
      if (input.expectedRevision !== actualRevision) {
        throw new RunStoreError("revision_conflict");
      }

      validateEvents(input.events, runId, (eventId) =>
        this.#eventIdExists(eventId),
      );
      let next = current;
      for (const event of input.events) {
        next = reduceRunLifecycleEvent(next, event);
      }
      if (next === null) {
        throw new RunStoreError("events_empty");
      }
      const thread = this.#loadThread({
        tenantId: next.tenantId,
        threadId: next.threadId,
      });
      if (thread === null || thread.spaceId !== next.spaceId) {
        throw new RunStoreError("thread_not_found");
      }
      if (current === null && thread.status !== "active") {
        throw new RunStoreError("thread_not_active");
      }
      if (input.threadAdmission !== undefined) {
        const historyHead = this.#database
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
             FROM model_history_items
             WHERE tenant_id = ? AND thread_id = ?`,
          )
          .get(next.tenantId, next.threadId) as { last_sequence: number };
        const activeRun = this.#database
          .prepare(
            `SELECT 1
             FROM run_snapshots AS snapshots
             JOIN run_thread_bindings AS bindings
               ON bindings.tenant_id = snapshots.tenant_id
              AND bindings.run_id = snapshots.run_id
             WHERE snapshots.tenant_id = ?
               AND bindings.thread_id = ?
               AND json_extract(snapshots.state_json, '$.status')
                   NOT IN ('completed', 'failed', 'canceled')
             LIMIT 1`,
          )
          .get(next.tenantId, next.threadId);
        validateManualCompactionAdmissionState(input, {
          currentRun: current,
          nextRun: next,
          thread,
          historySequence: Number(historyHead.last_sequence),
          goal: this.#loadThreadGoal({
            tenantId: next.tenantId,
            threadId: next.threadId,
          }),
          hasActiveRun: activeRun !== undefined,
        });
      }
      if (history !== null) {
        if (history.items.some((item) => item.runId !== runId)) {
          throw new RunStoreError("model_history_run_id_mismatch");
        }
        validateModelHistoryAppend(
          history,
          { tenantId: next.tenantId, threadId: next.threadId },
          this.#loadAllModelHistoryItems({
            tenantId: next.tenantId,
            threadId: next.threadId,
          }),
          (itemId) => this.#modelHistoryItemIdExists(itemId),
        );
      }
      validateRunHistoryCorrelation(input.events, history);
      validateOutbox(input.outbox, runId, input.tenantId, (messageId) =>
        this.#outboxMessageIdExists(messageId),
      );
      validateWorkItems(
        input.workItems,
        runId,
        input.tenantId,
        input.events.at(-1)?.sequence ?? 0,
        (workItemId) => this.#workItemIdExists(workItemId),
        workflowScheduler ? "workflowScheduler"
          : input.events.length === 1 && input.events[0]?.type === "run.cancel.requested" &&
              next.purpose === "workflow" ? "workflowCancel"
          : input.threadAdmission === undefined ? "default" : "manualCompaction",
      );
      if (input.events.length === 1 && input.events[0]?.type === "run.cancel.requested" &&
          next.purpose === "workflow" &&
          stableJson(input.workItems[0]?.payload.binding) !==
            stableJson(next.workflowVersionBinding))
        throw new RunStoreError("work_item_payload_invalid");

      this.#writeSnapshot(current, next, input.expectedRevision);
      this.#writeRunThreadBinding(current, next);
      this.#writeEvents(input.events, input.tenantId);
      this.#writeOutbox(input.outbox);
      this.#writeWorkItems(input.workItems);
      if (history !== null) {
        this.#writeModelHistoryItems(history.items);
      }

      const result: CommitRunResult = {
        disposition: "committed",
        state: next,
        events: input.events,
        outbox: input.outbox,
        workItems: input.workItems,
      };
      this.#database
        .prepare(
          `INSERT INTO idempotency_receipts (
            tenant_id,
            scope,
            idempotency_key,
            run_id,
            fingerprint,
            result_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          runId,
          fingerprint,
          stableJson(result),
        );
      if (!withinTransaction) {
        this.#database.exec("COMMIT");
      }
      return clone(result);
    } catch (error) {
      if (!withinTransaction) {
        rollback(this.#database);
      }
      throw normalizeSqliteError(error);
    }
  }

  async commitTextRunCompletion(
    input: CommitTextRunCompletionInput,
  ): Promise<CommitTextRunCompletionResult> {
    this.#assertOpen();
    const { runId, threadId } = validateTextRunCompletionInput(input);
    const completionHistory = textCompletionHistoryAppend(input);
    validateQueueLease(
      input.lease,
      input.lease.workItemId,
      "work_item_id_invalid",
    );
    const now = readLeaseClock(this.#clock);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const prior = this.#loadReceipt(
        input.idempotency.scope,
        input.idempotency.key,
      );
      if (prior !== null) {
        if (prior.tenant_id !== input.tenantId) {
          throw new RunStoreError("tenant_id_mismatch");
        }
        if (prior.fingerprint !== input.idempotency.requestFingerprint) {
          throw new RunStoreError("idempotency_conflict");
        }
        const result = normalizeStoredExecutionResult(
          parseStoredJson<CommitTextRunCompletionResult>(
            prior.result_json,
            "execution_idempotency_receipt_invalid",
          ),
        );
        validateStoredExecutionReceiptResult(result, prior, threadId);
        this.#database.exec("COMMIT");
        return clone({ ...result, disposition: "replayed" });
      }
      this.#validateExecutionLease(input.tenantId, runId, input.lease, now);

      const currentRun = this.#loadRun({
        tenantId: input.tenantId,
        runId,
      });
      const currentThread = this.#loadThread({
        tenantId: input.tenantId,
        threadId,
      });
      if (
        currentRun === null ||
        currentThread === null ||
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
        this.#eventIdExists(eventId),
      );
      validateThreadEvents(input.thread.events, threadId, (eventId) =>
        this.#threadEventIdExists(eventId),
      );
      validateMessages(
        input.thread.messages,
        input.thread.events,
        threadId,
        input.tenantId,
        (messageId) => this.#messageIdExists(messageId),
      );
      validateOutbox(input.run.outbox, runId, input.tenantId, (messageId) =>
        this.#outboxMessageIdExists(messageId),
      );
      if (input.history.items.some((item) => item.runId !== runId)) {
        throw new RunStoreError("model_history_run_id_mismatch");
      }
      validateModelHistoryAppend(
        completionHistory,
        { tenantId: input.tenantId, threadId },
        this.#loadAllModelHistoryItems({
          tenantId: input.tenantId,
          threadId,
        }),
        (itemId) => this.#modelHistoryItemIdExists(itemId),
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
      const currentGoal = this.#loadThreadGoal({
        tenantId: input.tenantId,
        threadId,
      });
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
        if (
          this.#loadRun({
            tenantId: input.tenantId,
            runId: nextContinuationRun.runId,
          }) !== null
        ) {
          throw new RunStoreError("goal_continuation_run_conflict");
        }
        validateEvents(
          input.goalContinuation!.events,
          nextContinuationRun.runId,
          (eventId) => this.#eventIdExists(eventId),
        );
        validateOutbox(
          input.goalContinuation!.outbox,
          nextContinuationRun.runId,
          input.tenantId,
          (messageId) => this.#outboxMessageIdExists(messageId),
        );
        validateWorkItems(
          input.goalContinuation!.workItems,
          nextContinuationRun.runId,
          input.tenantId,
          1,
          (workItemId) => this.#workItemIdExists(workItemId),
          "goalContinuation",
        );
      }

      const execution = finishSqliteRunAttempt(this.#database, {
        tenantId: input.tenantId,
        runId,
        workItemId: input.lease.workItemId,
        leaseEpoch: input.lease.leaseEpoch,
        attempt: { ...input.attempt, status: "completed" },
      });

      this.#writeSnapshot(currentRun, nextRun, input.run.expectedRevision);
      this.#writeRunThreadBinding(currentRun, nextRun);
      this.#writeEvents(input.run.events, input.tenantId);
      this.#writeOutbox(input.run.outbox);
      this.#writeThreadSnapshot(
        currentThread,
        nextThread,
        input.thread.expectedRevision,
      );
      this.#writeThreadEvents(input.thread.events, input.tenantId);
      this.#writeMessages(input.thread.messages);
      this.#writeModelHistoryItems(completionHistory.items);
      if (nextGoal !== currentGoal) {
        this.#writeTurnStartGoal(
          input.goal,
          nextGoal,
          input.tenantId,
          threadId,
        );
      }
      if (nextContinuationRun !== null) {
        this.#writeSnapshot(null, nextContinuationRun, 0);
        this.#writeRunThreadBinding(null, nextContinuationRun);
        this.#writeEvents(input.goalContinuation!.events, input.tenantId);
        this.#writeOutbox(input.goalContinuation!.outbox);
        this.#writeWorkItems(input.goalContinuation!.workItems);
      }
      const continuation = continuationRecord(input);
      this.#writeThreadContinuation(input, continuation);
      validateThreadModelState(input.modelState);
      this.#database
        .prepare(
          `INSERT INTO thread_model_states (
             tenant_id, thread_id, state_json, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id, thread_id) DO UPDATE SET
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.modelState.tenantId,
          input.modelState.threadId,
          stableJson(input.modelState),
          input.modelState.updatedAt,
        );
      this.#settleWorkItemWithinTransaction(input.lease, now);
      const result: CommitTextRunCompletionResult = {
        disposition: "committed",
        runState: nextRun,
        threadState: nextThread,
        goalState: nextGoal,
        goalContinuation:
          nextContinuationRun === null
            ? null
            : {
                runState: nextContinuationRun,
                historyItem: input.goalContinuation!.historyItem,
                runEvents: input.goalContinuation!.events,
                outbox: input.goalContinuation!.outbox,
                workItems: input.goalContinuation!.workItems,
              },
        runEvents: input.run.events,
        threadEvents: input.thread.events,
        messages: input.thread.messages,
        historyItems: completionHistory.items,
        outbox: input.run.outbox,
        continuation,
        modelState: input.modelState,
        step: execution.step,
        attempt: execution.attempt,
      };
      this.#database
        .prepare(
          `INSERT INTO idempotency_receipts (
            tenant_id,
            scope,
            idempotency_key,
            run_id,
            fingerprint,
            result_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tenantId,
          input.idempotency.scope,
          input.idempotency.key,
          runId,
          input.idempotency.requestFingerprint,
          stableJson(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async listRunEvents(
    locator: RunLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly RunLifecycleEvent[]> {
    this.#assertOpen();
    validateEventPage(locator, afterSequence, limit);
    try {
      const rows = this.#database
        .prepare(
          `SELECT tenant_id, run_id, sequence, event_id, event_json
           FROM run_events
           WHERE tenant_id = ? AND run_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`,
        )
        .all(
          locator.tenantId,
          locator.runId,
          afterSequence,
          limit,
        ) as unknown as EventRow[];
      return rows.map((row) => decodeStoredEvent(row, locator));
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async listPendingOutbox(limit: number): Promise<readonly OutboxMessage[]> {
    this.#assertOpen();
    validateLimit(limit);
    const now = readLeaseClock(this.#clock);
    try {
      const rows = this.#database
        .prepare(
          `SELECT message_id, tenant_id, run_id, topic, created_at, message_json
           FROM outbox
           WHERE (status = 'pending' AND available_at_ms <= ?)
              OR (status = 'leased' AND lease_expires_at_ms <= ?)
           ORDER BY outbox_order ASC
           LIMIT ?`,
        )
        .all(now, now, limit) as unknown as OutboxRow[];
      return rows.map(decodeStoredOutboxMessage);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async claimNextOutbox(input: QueueClaimInput): Promise<OutboxClaim | null> {
    this.#assertOpen();
    validateQueueClaim(input);
    return this.#claimOutbox(input, readLeaseClock(this.#clock));
  }

  async acknowledgeOutbox(input: OutboxLeaseInput): Promise<void> {
    this.#assertOpen();
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    this.#settleOutbox(input, readLeaseClock(this.#clock));
  }

  async retryOutbox(input: OutboxRetryInput): Promise<void> {
    this.#assertOpen();
    validateQueueLease(input, input.messageId, "outbox_message_id_invalid");
    validateQueueRetry(input);
    this.#retryOutbox(input, readLeaseClock(this.#clock));
  }

  async listPendingWorkItems(limit: number): Promise<readonly WorkItem[]> {
    this.#assertOpen();
    validateLimit(limit);
    const now = readLeaseClock(this.#clock);
    try {
      const rows = this.#database
        .prepare(
          `SELECT work_item_id, tenant_id, run_id, kind, created_at, work_item_json
           FROM work_items
           WHERE (status = 'pending' AND available_at_ms <= ?)
              OR (status = 'leased' AND lease_expires_at_ms <= ?)
           ORDER BY work_item_order ASC
           LIMIT ?`,
        )
        .all(now, now, limit) as unknown as WorkItemRow[];
      return rows.map(decodeStoredWorkItem);
    } catch (error) {
      throw normalizeSqliteError(error);
    }
  }

  async claimNextWorkItem(
    input: QueueClaimInput,
  ): Promise<WorkItemClaim | null> {
    this.#assertOpen();
    validateQueueClaim(input);
    return this.#claimWorkItem(input, readLeaseClock(this.#clock));
  }

  async renewWorkItemLease(input: WorkItemRenewInput): Promise<QueueLease> {
    this.#assertOpen();
    validateQueueClaim(input);
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    const now = readLeaseClock(this.#clock);
    const expiry = leaseExpiry(now, input.leaseDurationMs);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#loadWorkItemMetadata(input.workItemId);
      validateMetadataLease(row, input, now, "completed");
      const update = this.#database
        .prepare(
          `UPDATE work_items
           SET lease_expires_at_ms = ?
           WHERE work_item_id = ?`,
        )
        .run(expiry.expiresAtMs, input.workItemId);
      if (update.changes !== 1) {
        throw new RunStoreError("queue_renewal_conflict");
      }
      this.#database.exec("COMMIT");
      return {
        ownerId: input.ownerId,
        leaseId: input.leaseId,
        epoch: input.leaseEpoch,
        expiresAt: expiry.expiresAt,
      };
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  async completeWorkItem(input: WorkItemLeaseInput): Promise<void> {
    this.#assertOpen();
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    this.#settleWorkItem(input, readLeaseClock(this.#clock));
  }

  async retryWorkItem(input: WorkItemRetryInput): Promise<void> {
    this.#assertOpen();
    validateQueueLease(input, input.workItemId, "work_item_id_invalid");
    validateQueueRetry(input);
    this.#retryWorkItem(input, readLeaseClock(this.#clock));
  }

  #claimOutbox(input: QueueClaimInput, now: number): OutboxClaim | null {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare(
          `SELECT
             message_id,
             tenant_id,
             run_id,
             topic,
             created_at,
             message_json,
             lease_epoch
           FROM outbox
           WHERE (status = 'pending' AND available_at_ms <= ?)
              OR (status = 'leased' AND lease_expires_at_ms <= ?)
           ORDER BY outbox_order ASC
           LIMIT 1`,
        )
        .get(now, now) as (OutboxRow & { lease_epoch: number }) | undefined;
      if (row === undefined) {
        this.#database.exec("COMMIT");
        return null;
      }
      const message = decodeStoredOutboxMessage(row);
      const epoch = nextLeaseEpoch(row.lease_epoch);
      const expiry = leaseExpiry(now, input.leaseDurationMs);
      const update = this.#database
        .prepare(
          `UPDATE outbox
           SET
             status = 'leased',
             lease_owner_id = ?,
             lease_id = ?,
             lease_epoch = ?,
             lease_expires_at_ms = ?,
             attempt_count = attempt_count + 1
           WHERE message_id = ?`,
        )
        .run(
          input.ownerId,
          input.leaseId,
          epoch,
          expiry.expiresAtMs,
          message.messageId,
        );
      if (update.changes !== 1) {
        throw new RunStoreError("queue_claim_conflict");
      }
      this.#database.exec("COMMIT");
      return {
        message,
        lease: lease(input, epoch, expiry.expiresAt),
      };
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #settleOutbox(input: OutboxLeaseInput, now: number): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#loadOutboxMetadata(input.messageId);
      validateMetadataLease(row, input, now, "delivered");
      const update = this.#database
        .prepare(
          `UPDATE outbox
           SET
             status = 'delivered',
             lease_owner_id = NULL,
             lease_id = NULL,
             lease_expires_at_ms = NULL,
             delivered_at_ms = ?
           WHERE message_id = ?`,
        )
        .run(now, input.messageId);
      if (update.changes !== 1) {
        throw new RunStoreError("queue_settlement_conflict");
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #retryOutbox(input: OutboxRetryInput, now: number): void {
    const availableAt = retryAvailableAt(now, input.retryAfterMs);
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#loadOutboxMetadata(input.messageId);
      validateMetadataLease(row, input, now, "delivered");
      const update = this.#database
        .prepare(
          `UPDATE outbox
           SET
             status = 'pending',
             available_at_ms = ?,
             lease_owner_id = NULL,
             lease_id = NULL,
             lease_expires_at_ms = NULL,
             last_error_code = ?
           WHERE message_id = ?`,
        )
        .run(availableAt, input.reasonCode, input.messageId);
      if (update.changes !== 1) {
        throw new RunStoreError("queue_retry_conflict");
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #claimWorkItem(input: QueueClaimInput, now: number): WorkItemClaim | null {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#database
        .prepare(
          `SELECT
             work_item_id,
             tenant_id,
             run_id,
             kind,
             created_at,
             work_item_json,
             lease_epoch
           FROM work_items
           WHERE (status = 'pending' AND available_at_ms <= ?)
              OR (status = 'leased' AND lease_expires_at_ms <= ?)
           ORDER BY work_item_order ASC
           LIMIT 1`,
        )
        .get(now, now) as (WorkItemRow & { lease_epoch: number }) | undefined;
      if (row === undefined) {
        this.#database.exec("COMMIT");
        return null;
      }
      const workItem = decodeStoredWorkItem(row);
      const epoch = nextLeaseEpoch(row.lease_epoch);
      const expiry = leaseExpiry(now, input.leaseDurationMs);
      const update = this.#database
        .prepare(
          `UPDATE work_items
           SET
             status = 'leased',
             lease_owner_id = ?,
             lease_id = ?,
             lease_epoch = ?,
             lease_expires_at_ms = ?,
             attempt_count = attempt_count + 1
           WHERE work_item_id = ?`,
        )
        .run(
          input.ownerId,
          input.leaseId,
          epoch,
          expiry.expiresAtMs,
          workItem.workItemId,
        );
      if (update.changes !== 1) {
        throw new RunStoreError("queue_claim_conflict");
      }
      this.#database.exec("COMMIT");
      return {
        workItem,
        lease: lease(input, epoch, expiry.expiresAt),
      };
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #settleWorkItem(input: WorkItemLeaseInput, now: number): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#settleWorkItemWithinTransaction(input, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #retryWorkItem(input: WorkItemRetryInput, now: number): void {
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#retryWorkItemWithinTransaction(input, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #settleWorkItemWithinTransaction(
    input: WorkItemLeaseInput,
    now: number,
  ): void {
    const row = this.#loadWorkItemMetadata(input.workItemId);
    validateMetadataLease(row, input, now, "completed");
    const update = this.#database
      .prepare(
        `UPDATE work_items
         SET
           status = 'completed',
           lease_owner_id = NULL,
           lease_id = NULL,
           lease_expires_at_ms = NULL,
           completed_at_ms = ?
         WHERE work_item_id = ?`,
      )
      .run(now, input.workItemId);
    if (update.changes !== 1) {
      throw new RunStoreError("queue_settlement_conflict");
    }
  }

  #retryWorkItemWithinTransaction(
    input: WorkItemRetryInput,
    now: number,
  ): void {
    const availableAt = retryAvailableAt(now, input.retryAfterMs);
    const row = this.#loadWorkItemMetadata(input.workItemId);
    validateMetadataLease(row, input, now, "completed");
    const update = this.#database
      .prepare(
        `UPDATE work_items
         SET
           status = 'pending',
           available_at_ms = ?,
           lease_owner_id = NULL,
           lease_id = NULL,
           lease_expires_at_ms = NULL,
           last_error_code = ?
         WHERE work_item_id = ?`,
      )
      .run(availableAt, input.reasonCode, input.workItemId);
    if (update.changes !== 1) {
      throw new RunStoreError("queue_retry_conflict");
    }
  }

  #loadOutboxMetadata(messageId: string): QueueMetadataRow {
    const row = this.#database
      .prepare(
        `SELECT status, lease_owner_id, lease_id, lease_epoch, lease_expires_at_ms
         FROM outbox
         WHERE message_id = ?`,
      )
      .get(messageId) as QueueMetadataRow | undefined;
    return requiredMetadata(row);
  }

  #loadWorkItemMetadata(workItemId: string): QueueMetadataRow {
    const row = this.#database
      .prepare(
        `SELECT status, lease_owner_id, lease_id, lease_epoch, lease_expires_at_ms
         FROM work_items
         WHERE work_item_id = ?`,
      )
      .get(workItemId) as QueueMetadataRow | undefined;
    return requiredMetadata(row);
  }

  #validateExecutionLease(
    tenantId: string,
    runId: string,
    input: WorkItemLeaseInput,
    now: number,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT
           tenant_id,
           run_id,
           status,
           lease_owner_id,
           lease_id,
           lease_epoch,
           lease_expires_at_ms
         FROM work_items
         WHERE work_item_id = ?`,
      )
      .get(input.workItemId) as WorkItemExecutionMetadataRow | undefined;
    if (row === undefined) {
      throw new RunStoreError("queue_item_not_found");
    }
    if (row.tenant_id !== tenantId || row.run_id !== runId) {
      throw new RunStoreError("work_item_scope_mismatch");
    }
    validateMetadataLease(row, input, now, "completed");
  }

  #hasPendingProviderSwitch(tenantId: string): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 FROM model_provider_settings_operations
           WHERE tenant_id = ? AND status = 'pending' LIMIT 1`,
        )
        .get(tenantId) !== undefined
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RunStoreError("store_closed");
    }
  }

  #workflow(): SqliteWorkflowRunCompositionStore {
    this.#assertOpen();
    if (this.#workflowRuntime === null)
      throw new RunStoreError("workflow_run_admission_not_configured");
    return this.#workflowRuntime;
  }

  #loadAgentVersion(input: {
    tenantId: string;
    agentVersionId: string;
  }): AgentVersionAsset | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, agent_version_id, content_digest, asset_json,
                created_at
         FROM agent_versions
         WHERE tenant_id = ? AND agent_version_id = ?`,
      )
      .get(input.tenantId, input.agentVersionId) as AgentVersionRow | undefined;
    return row === undefined ? null : decodeSqliteAgentVersion(row);
  }

  #loadAgentVersionDeployment(input: {
    tenantId: string;
    agentVersionId: string;
  }): AgentVersionDeployment | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, agent_version_id, content_digest,
                materialization_digest, deployment_json, deployed_at
         FROM agent_version_deployments
         WHERE tenant_id = ? AND agent_version_id = ?`,
      )
      .get(input.tenantId, input.agentVersionId) as
      | AgentVersionDeploymentRow
      | undefined;
    return row === undefined ? null : decodeSqliteAgentVersionDeployment(row);
  }

  #loadAgentVersionReleaseBundle(input: {
    tenantId: string;
    releaseId: string;
  }): AgentVersionReleaseBundle | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, release_id, manifest_digest,
                default_agent_version_id, bundle_json
         FROM agent_version_release_bundles
         WHERE tenant_id = ? AND release_id = ?`,
      )
      .get(input.tenantId, input.releaseId) as
      | AgentVersionReleaseBundleRow
      | undefined;
    return row === undefined
      ? null
      : decodeSqliteAgentVersionReleaseBundle(row);
  }

  #loadAgentVersionReleaseActivation(input: {
    tenantId: string;
    activationId: string;
  }): AgentVersionReleaseActivation | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, activation_id, release_id, previous_release_id,
                operator_principal_id, operator_actor_id, operator_space_id,
                activation_json, activated_at
         FROM agent_version_release_activations
         WHERE tenant_id = ? AND activation_id = ?`,
      )
      .get(input.tenantId, input.activationId) as
      | AgentVersionReleaseActivationRow
      | undefined;
    return row === undefined
      ? null
      : decodeSqliteAgentVersionReleaseActivation(row);
  }

  #loadActiveAgentVersionRelease(
    tenantId: string,
  ): ActiveAgentVersionRelease | null {
    const row = this.#database
      .prepare(
        `SELECT b.tenant_id, b.release_id, b.manifest_digest,
                b.default_agent_version_id, b.bundle_json,
                a.activation_id, a.previous_release_id,
                a.operator_principal_id, a.operator_actor_id,
                a.operator_space_id, a.activation_json, a.activated_at
         FROM active_agent_version_releases p
         JOIN agent_version_release_bundles b
           ON b.tenant_id = p.tenant_id AND b.release_id = p.release_id
         JOIN agent_version_release_activations a
           ON a.tenant_id = p.tenant_id AND a.activation_id = p.activation_id
         WHERE p.tenant_id = ?`,
      )
      .get(tenantId) as
      | (AgentVersionReleaseBundleRow & AgentVersionReleaseActivationRow)
      | undefined;
    if (row === undefined) {
      return null;
    }
    const bundle = decodeSqliteAgentVersionReleaseBundle(row);
    const activation = decodeSqliteAgentVersionReleaseActivation(row);
    if (
      bundle.tenantId !== activation.tenantId ||
      bundle.releaseId !== activation.releaseId
    ) {
      throw new RunStoreError("agent_version_release_active_corrupt");
    }
    return { bundle, activation };
  }

  #loadThread(locator: ThreadLocator): ThreadState | null {
    const row = this.#database
      .prepare(
        `SELECT
           tenant_id,
           space_id,
           thread_id,
           created_by_actor_id,
           title,
           status,
           revision,
           last_event_sequence,
           last_message_sequence,
           state_json,
           created_at,
           updated_at,
           archived_at,
           deleted_at,
           deleted_by_actor_id
         FROM threads
         WHERE tenant_id = ? AND thread_id = ?`,
      )
      .get(locator.tenantId, locator.threadId) as ThreadSnapshotRow | undefined;
    if (row === undefined) {
      return null;
    }
    return decodeStoredThreadState(row, locator);
  }

  #loadThreadGoal(locator: ThreadLocator): ThreadGoal | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, thread_id, goal_id, revision, state_json, updated_at
         FROM thread_goals
         WHERE tenant_id = ? AND thread_id = ?`,
      )
      .get(locator.tenantId, locator.threadId) as ThreadGoalRow | undefined;
    return row === undefined ? null : decodeStoredThreadGoal(row, locator);
  }

  #writeTurnStartGoal(
    mutation: CommitTurnStartInput["goal"],
    next: ThreadGoal | null,
    tenantId: string,
    threadId: string,
  ): void {
    if (mutation.kind === "keep") return;
    const current = this.#loadThreadGoal({ tenantId, threadId });
    if (mutation.kind === "clear") {
      if (mutation.expectedRevision === null) return;
      const deleted = this.#database
        .prepare(
          `DELETE FROM thread_goals
           WHERE tenant_id = ? AND thread_id = ? AND revision = ?`,
        )
        .run(tenantId, threadId, mutation.expectedRevision);
      if (deleted.changes !== 1) {
        throw new RunStoreError("goal_revision_conflict");
      }
      this.#writeThreadGoalEvent(
        current,
        null,
        mutation.occurredAt,
        tenantId,
        threadId,
      );
      return;
    }
    if (next === null) throw new RunStoreError("goal_mutation_invalid");
    if (mutation.expectedRevision === null) {
      this.#database
        .prepare(
          `INSERT INTO thread_goals (
             tenant_id, thread_id, goal_id, revision, state_json, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          threadId,
          next.goalId,
          next.revision,
          stableJson(next),
          next.updatedAt,
        );
      this.#writeThreadGoalEvent(
        current,
        next,
        next.updatedAt,
        tenantId,
        threadId,
      );
      return;
    }
    const updated = this.#database
      .prepare(
        `UPDATE thread_goals
         SET goal_id = ?, revision = ?, state_json = ?, updated_at = ?
         WHERE tenant_id = ? AND thread_id = ? AND revision = ?`,
      )
      .run(
        next.goalId,
        next.revision,
        stableJson(next),
        next.updatedAt,
        tenantId,
        threadId,
        mutation.expectedRevision,
      );
    if (updated.changes !== 1) {
      throw new RunStoreError("goal_revision_conflict");
    }
    this.#writeThreadGoalEvent(
      current,
      next,
      next.updatedAt,
      tenantId,
      threadId,
    );
  }

  #writeThreadGoalEvent(
    current: ThreadGoal | null,
    next: ThreadGoal | null,
    occurredAt: string,
    tenantId: string,
    threadId: string,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS last_sequence
         FROM thread_goal_events
         WHERE tenant_id = ? AND thread_id = ?`,
      )
      .get(tenantId, threadId) as { last_sequence: number };
    const event = createThreadGoalEvent({
      current,
      next,
      lastSequence: row.last_sequence,
      occurredAt,
      tenantId,
      threadId,
    });
    if (event === null) return;
    this.#database
      .prepare(
        `INSERT INTO thread_goal_events (
           tenant_id, thread_id, sequence, event_id, event_type, event_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        threadId,
        event.sequence,
        event.eventId,
        event.type,
        stableJson(event),
        event.occurredAt,
      );
  }

  #loadModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): ModelHistoryItem[] {
    const rows = this.#database
      .prepare(
        `SELECT
           tenant_id,
           thread_id,
           sequence,
           item_id,
           run_id,
           segment_id,
           item_type,
           item_json,
           created_at
         FROM model_history_items
         WHERE tenant_id = ? AND thread_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`,
      )
      .all(
        locator.tenantId,
        locator.threadId,
        afterSequence,
        limit,
      ) as unknown as ModelHistoryRow[];
    return rows.map((row) => decodeStoredModelHistoryItem(row, locator));
  }

  #loadAllModelHistoryItems(locator: ThreadLocator): ModelHistoryItem[] {
    const rows = this.#database
      .prepare(
        `SELECT
           tenant_id,
           thread_id,
           sequence,
           item_id,
           run_id,
           segment_id,
           item_type,
           item_json,
           created_at
         FROM model_history_items
         WHERE tenant_id = ? AND thread_id = ?
         ORDER BY sequence ASC`,
      )
      .all(locator.tenantId, locator.threadId) as unknown as ModelHistoryRow[];
    return rows.map((row) => decodeStoredModelHistoryItem(row, locator));
  }

  #loadRun(locator: RunLocator): RunState | null {
    const row = this.#database
      .prepare(
        `SELECT
           snapshots.tenant_id,
           snapshots.space_id,
           snapshots.run_id,
           snapshots.revision,
           snapshots.last_sequence,
           snapshots.state_json,
           bindings.thread_id
         FROM run_snapshots AS snapshots
         LEFT JOIN run_thread_bindings AS bindings
           ON bindings.tenant_id = snapshots.tenant_id
          AND bindings.run_id = snapshots.run_id
         WHERE snapshots.tenant_id = ? AND snapshots.run_id = ?`,
      )
      .get(locator.tenantId, locator.runId) as SnapshotRow | undefined;
    if (row === undefined) {
      return null;
    }
    return decodeStoredRunState(row, locator);
  }

  #loadThreadContinuation(
    locator: ThreadContinuationLocator,
  ): ThreadContinuationCheckpoint | null {
    const row = this.#database
      .prepare(
        `SELECT
           c.tenant_id,
           c.thread_id,
           c.agent_version_id,
           c.adapter_name,
           c.adapter_version,
           c.model_id,
           c.through_history_sequence,
           c.context_revision,
           c.checkpoint_json,
           c.updated_at,
           h.item_type AS history_item_type,
           json_extract(h.item_json, '$.role') AS history_message_role
         FROM thread_continuations c
         JOIN model_history_items h
           ON h.tenant_id = c.tenant_id
          AND h.thread_id = c.thread_id
          AND h.sequence = c.through_history_sequence
         WHERE c.tenant_id = ?
           AND c.thread_id = ?
           AND c.agent_version_id = ?
           AND c.adapter_name = ?
           AND c.adapter_version = ?
           AND c.model_id = ?`,
      )
      .get(
        locator.tenantId,
        locator.threadId,
        locator.agentVersionId,
        locator.adapterName,
        locator.adapterVersion,
        locator.modelId,
      ) as ThreadContinuationRow | undefined;
    if (row === undefined) {
      return null;
    }
    return decodeThreadContinuation(row, locator);
  }

  #writeThreadContinuation(
    input: CommitTextRunCompletionInput,
    continuation: ThreadContinuationCheckpoint | null,
  ): void {
    const identity = input.continuation;
    const message = requiredTextCompletionMessage(input);
    this.#database
      .prepare(
        `DELETE FROM thread_continuations
         WHERE tenant_id = ?
           AND thread_id = ?
           AND agent_version_id = ?
           AND adapter_name = ?
           AND adapter_version = ?
           AND model_id = ?`,
      )
      .run(
        input.tenantId,
        message.threadId,
        identity.agentVersionId,
        identity.adapterName,
        identity.adapterVersion,
        identity.modelId,
      );
    if (continuation === null) {
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO thread_continuations (
           tenant_id,
           thread_id,
           agent_version_id,
           adapter_name,
           adapter_version,
           model_id,
           through_history_sequence,
           context_revision,
           checkpoint_json,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        continuation.tenantId,
        continuation.threadId,
        continuation.agentVersionId,
        continuation.adapterName,
        continuation.adapterVersion,
        continuation.modelId,
        continuation.throughHistorySequence,
        continuation.contextRevision,
        stableJson(continuation.checkpoint),
        continuation.updatedAt,
      );
  }

  #validateStoredRollbackReceiptAuthority(
    result: CommitThreadRollbackResult,
  ): void {
    const locator = {
      tenantId: result.state.tenantId,
      threadId: result.state.threadId,
    };
    const history = this.#loadAllModelHistoryItems(locator);
    const messageRows = this.#database
      .prepare(
        `SELECT tenant_id, thread_id, sequence, message_id, role, content,
                content_digest, created_at, message_json
         FROM messages
         WHERE tenant_id = ? AND thread_id = ?
         ORDER BY sequence ASC`,
      )
      .all(locator.tenantId, locator.threadId) as unknown as MessageRow[];
    const messages = messageRows.map((row) =>
      decodeStoredMessage(row, locator),
    );
    const invalidationRows = this.#database
      .prepare(
        `SELECT messages.message_id, invalidations.message_sequence,
                invalidations.history_sequence, invalidations.rollback_id,
                invalidations.marker_item_id, invalidations.invalidated_at
         FROM message_invalidations AS invalidations
         JOIN messages
           ON messages.tenant_id = invalidations.tenant_id
          AND messages.thread_id = invalidations.thread_id
          AND messages.sequence = invalidations.message_sequence
         WHERE invalidations.tenant_id = ?
           AND invalidations.thread_id = ?
           AND invalidations.rollback_id = ?
         ORDER BY invalidations.message_sequence ASC`,
      )
      .all(
        locator.tenantId,
        locator.threadId,
        result.marker.rollbackId,
      ) as unknown as {
      message_id: string;
      message_sequence: number;
      history_sequence: number;
      rollback_id: string;
      marker_item_id: string;
      invalidated_at: string;
    }[];
    const invalidatedMessages: InvalidatedMessage[] = invalidationRows.map(
      (row) => ({
        messageId: row.message_id,
        messageSequence: row.message_sequence,
        invalidation: {
          rollbackId: row.rollback_id,
          markerItemId: row.marker_item_id,
          historySequence: row.history_sequence,
          invalidatedAt: row.invalidated_at,
        },
      }),
    );
    const effects = this.#database
      .prepare(
        `SELECT invalidated_continuation_count, invalidated_model_state
         FROM thread_rollback_commits
         WHERE tenant_id = ? AND thread_id = ? AND rollback_id = ?`,
      )
      .get(locator.tenantId, locator.threadId, result.marker.rollbackId) as
      | {
          invalidated_continuation_count: number;
          invalidated_model_state: number;
        }
      | undefined;
    if (effects === undefined) {
      throw new RunStoreError("thread_rollback_receipt_authority_invalid");
    }
    validateThreadRollbackReceiptAuthority(
      result,
      history,
      messages,
      invalidatedMessages,
      {
        invalidatedContinuationCount: effects.invalidated_continuation_count,
        invalidatedModelState: effects.invalidated_model_state === 1,
      },
    );
  }

  #loadReceipt(scope: string, idempotencyKey: string): ReceiptRow | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, run_id, fingerprint, result_json
         FROM idempotency_receipts
         WHERE scope = ? AND idempotency_key = ?`,
      )
      .get(scope, idempotencyKey) as ReceiptRow | undefined;
    return row ?? null;
  }

  #validateWorkflowAdmissionReplay(
    input: CommitWorkflowRunStartInput,
    receiptRunId: string,
    result: CommitWorkflowRunStartResult,
  ): void {
    if (result.run.disposition !== "committed" ||
        receiptRunId !== result.run.state.runId ||
        result.run.state.tenantId !== input.tenantId ||
        result.run.state.spaceId !== input.spaceId ||
        result.run.state.threadId !== input.threadId ||
        result.authority.workflowVersion.tenantId !== input.tenantId ||
        result.authority.workflowVersion.workflowVersionId !== input.workflowVersionId)
      throw new RunStoreError("workflow_run_admission_receipt_corrupt");
    const run = this.#loadRun({ tenantId: result.run.state.tenantId,
      runId: result.run.state.runId });
    const versionRow = this.#database.prepare(
      `SELECT tenant_id,workflow_id,workflow_version_id,content_digest,
              definition_json,created_at FROM workflow_versions
       WHERE tenant_id=? AND workflow_version_id=?`,
    ).get(input.tenantId, input.workflowVersionId) as
      | { tenant_id: string; workflow_id: string; workflow_version_id: string;
          content_digest: string; definition_json: string; created_at: string }
      | undefined;
    const durableVersion = versionRow === undefined ? null : {
      schemaVersion: "crewon.workflow-version-asset.v0" as const,
      tenantId: versionRow.tenant_id, workflowId: versionRow.workflow_id,
      workflowVersionId: versionRow.workflow_version_id,
      contentDigest: versionRow.content_digest,
      definitionJson: versionRow.definition_json, createdAt: versionRow.created_at,
    };
    const compiled = durableVersion === null || this.#workflowDigester === null
      ? null : parseCompiledWorkflowVersion(
          durableVersion.definitionJson, this.#workflowDigester);
    const roots = this.#database.prepare(
      `SELECT value_id,value_digest,value_json FROM workflow_execution_values
       WHERE tenant_id=? AND run_id=? AND role='rootInput' AND node_id IS NULL`,
    ).all(result.run.state.tenantId, result.run.state.runId) as unknown as {
      value_id: string;
      value_digest: string;
      value_json: string;
    }[];
    const root = roots[0];
    const work = result.run.workItems[0];
    const event = result.run.events[0];
    const outbox = result.run.outbox[0];
    const storedEvent = event === undefined ? undefined : this.#database.prepare(
      `SELECT tenant_id,run_id,sequence,event_id,event_json FROM run_events
       WHERE tenant_id=? AND event_id=?`,
    ).get(result.run.state.tenantId, event.eventId) as
      | EventRow | undefined;
    const storedOutbox = outbox === undefined ? undefined : this.#database.prepare(
      `SELECT message_id,tenant_id,run_id,topic,created_at,message_json FROM outbox
       WHERE tenant_id=? AND message_id=?`,
    ).get(result.run.state.tenantId, outbox.messageId) as
      | OutboxRow | undefined;
    const storedWork = work === undefined ? undefined : this.#database.prepare(
      `SELECT work_item_id,tenant_id,run_id,kind,created_at,work_item_json
       FROM work_items WHERE tenant_id=? AND work_item_id=?`,
    ).get(result.run.state.tenantId, work.workItemId) as
      | WorkItemRow | undefined;
    const generalReceipt = this.#database.prepare(
      `SELECT count(*) AS count FROM idempotency_receipts
       WHERE tenant_id=? AND run_id=? AND result_json=?`,
    ).get(input.tenantId, receiptRunId, stableJson(result.run)) as
      | { count: number }
      | undefined;
    const ref = work?.payload.workflowInput as
      | { valueId?: unknown; valueDigest?: unknown }
      | undefined;
    const binding = {
      workflowId: durableVersion?.workflowId,
      workflowVersionId: durableVersion?.workflowVersionId,
      contentDigest: durableVersion?.contentDigest,
    };
    if (run === null || durableVersion === null || compiled === null ||
        stableJson(durableVersion) !== stableJson(result.authority.workflowVersion) ||
        compiled.contentDigest !== durableVersion.contentDigest ||
        compiled.workflowId !== durableVersion.workflowId ||
        result.run.events.length !== 1 || result.run.outbox.length !== 1 ||
        result.run.workItems.length !== 1 || event?.type !== "run.created" ||
        event.sequence !== 1 || event.identity.runId !== receiptRunId ||
        event.data.tenantId !== input.tenantId ||
        event.data.spaceId !== input.spaceId ||
        event.data.threadId !== input.threadId ||
        event.data.purpose !== "workflow" || event.data.goalBinding !== null ||
        stableJson(run) !== stableJson(result.run.state) ||
        run.agentVersionId !== result.authority.route.agentVersionId ||
        run.authorityId !== result.authority.route.authorityId ||
        run.runtimeGeneration !== result.authority.route.runtimeGeneration ||
        run.policySnapshotId !== result.authority.route.policySnapshotId ||
        run.workspaceBindingId !== result.authority.route.workspaceBindingId ||
        roots.length !== 1 || root === undefined ||
        ref?.valueId !== root.value_id ||
        ref.valueDigest !== root.value_digest ||
        this.#workflowDigester === null ||
        canonicalJson(JSON.parse(root.value_json)) !== root.value_json ||
        canonicalJson(input.workflowInput) !== root.value_json ||
        this.#workflowDigester.sha256(root.value_json) !== root.value_digest ||
        stableJson(validateWorkflowSchemaValue(
          JSON.parse(root.value_json), compiled.inputSchema)) !== root.value_json ||
        stableJson(event.data.workflowVersionBinding) !== stableJson(binding) ||
        event.data.agentVersionId !== result.authority.route.agentVersionId ||
        event.data.authorityId !== result.authority.route.authorityId ||
        event.data.runtimeGeneration !== result.authority.route.runtimeGeneration ||
        event.data.policySnapshotId !== result.authority.route.policySnapshotId ||
        event.data.workspaceBindingId !== result.authority.route.workspaceBindingId ||
        storedEvent?.tenant_id !== input.tenantId ||
        storedEvent.run_id !== receiptRunId || storedEvent.sequence !== 1 ||
        storedEvent.event_id !== event.eventId ||
        storedEvent.event_json !== stableJson(event) ||
        outbox?.tenantId !== input.tenantId || outbox.runId !== receiptRunId ||
        outbox.topic !== "run.updated" ||
        stableJson(outbox.payload) !== stableJson({
          eventId: event.eventId,
          eventType: event.type,
          throughSequence: event.sequence,
        }) ||
        storedOutbox?.tenant_id !== input.tenantId ||
        storedOutbox.run_id !== receiptRunId ||
        storedOutbox.message_id !== outbox.messageId ||
        storedOutbox?.topic !== outbox?.topic ||
        storedOutbox.created_at !== outbox.createdAt ||
        storedOutbox?.message_json !== stableJson(outbox) ||
        work?.tenantId !== input.tenantId || work.runId !== receiptRunId ||
        work.kind !== "run.execute" ||
        work.payload.schemaVersion !== "crewon.workflow-scheduler-work-item.v1" ||
        work.payload.trigger !== "workflowScheduler" ||
        stableJson(work.payload.binding) !== stableJson(binding) ||
        storedWork?.tenant_id !== input.tenantId ||
        storedWork.run_id !== receiptRunId || storedWork.kind !== work.kind ||
        storedWork.work_item_id !== work.workItemId ||
        storedWork.created_at !== work.createdAt ||
        storedWork?.work_item_json !== stableJson(work) ||
        generalReceipt === undefined || generalReceipt.count !== 1)
      throw new RunStoreError("workflow_run_admission_receipt_corrupt");
  }

  #readWorkflowAdmissionReplay(
    input: CommitWorkflowRunStartInput,
  ): CommitWorkflowRunStartResult | null {
    try {
      this.#database.exec("BEGIN");
      const result = this.#loadWorkflowAdmissionReplay(input);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.#database);
      throw normalizeSqliteError(error);
    }
  }

  #loadWorkflowAdmissionReplay(
    input: CommitWorkflowRunStartInput,
  ): CommitWorkflowRunStartResult | null {
    const prior = this.#database.prepare(
      `SELECT tenant_id,run_id,fingerprint,result_json FROM workflow_run_admission_receipts
       WHERE scope=? AND idempotency_key=?`,
    ).get(input.idempotency.scope, input.idempotency.key) as
      | { tenant_id: string; run_id: string; fingerprint: string; result_json: string }
      | undefined;
    if (prior === undefined) return null;
    if (prior.tenant_id !== input.tenantId ||
        prior.fingerprint !== input.idempotency.requestFingerprint)
      throw new RunStoreError("idempotency_conflict");
    const result = parseStoredJson<CommitWorkflowRunStartResult>(
      prior.result_json, "workflow_run_admission_receipt_invalid");
    this.#validateWorkflowAdmissionReplay(input, prior.run_id, result);
    return clone({ ...result, run: { ...result.run, disposition: "replayed" } });
  }

  #validateWorkflowPreparedCommit(
    input: CommitWorkflowRunStartInput,
    commit: CommitRunInput,
    workflowVersion: import("@crewon/application").WorkflowVersionAsset,
    route: import("@crewon/application").RunRoute,
    root: import("@crewon/application").WorkflowRunInputAuthority,
  ): void {
    const event = commit.events[0];
    const outbox = commit.outbox[0];
    const work = commit.workItems[0];
    if (commit.tenantId !== input.tenantId || commit.expectedRevision !== 0 ||
        commit.events.length !== 1 || event?.type !== "run.created" ||
        event.sequence !== 1 || event.data.tenantId !== input.tenantId ||
        event.data.spaceId !== input.spaceId || event.data.threadId !== input.threadId ||
        event.data.purpose !== "workflow" || event.data.goalBinding !== null ||
        event.data.authorityId !== route.authorityId ||
        event.data.runtimeGeneration !== route.runtimeGeneration ||
        event.data.agentVersionId !== route.agentVersionId ||
        event.data.policySnapshotId !== route.policySnapshotId ||
        event.data.workspaceBindingId !== route.workspaceBindingId ||
        stableJson(event.data.workflowVersionBinding) !== stableJson({
          workflowId: workflowVersion.workflowId,
          workflowVersionId: workflowVersion.workflowVersionId,
          contentDigest: workflowVersion.contentDigest }) ||
        commit.outbox.length !== 1 || outbox?.topic !== "run.updated" ||
        outbox.tenantId !== input.tenantId || outbox.runId !== event.identity.runId ||
        stableJson(outbox.payload) !== stableJson({ eventId: event.eventId,
          eventType: event.type, throughSequence: 1 }) ||
        commit.workItems.length !== 1 || work?.kind !== "run.execute" ||
        work.tenantId !== input.tenantId || work.runId !== event.identity.runId ||
        stableJson((work.payload as Record<string, unknown>).workflowInput) !==
          stableJson({ valueId: root.valueId, valueDigest: root.valueDigest }))
      throw new RunStoreError("workflow_run_prepare_invalid");
  }

  #loadThreadReceipt(
    scope: string,
    idempotencyKey: string,
  ): ThreadReceiptRow | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, thread_id, fingerprint, result_json
         FROM thread_idempotency_receipts
         WHERE scope = ? AND idempotency_key = ?`,
      )
      .get(scope, idempotencyKey) as ThreadReceiptRow | undefined;
    return row ?? null;
  }

  #eventIdExists(eventId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM run_events WHERE event_id = ?")
        .get(eventId) !== undefined
    );
  }

  #threadEventIdExists(eventId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM thread_events WHERE event_id = ?")
        .get(eventId) !== undefined
    );
  }

  #messageIdExists(messageId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM messages WHERE message_id = ?")
        .get(messageId) !== undefined
    );
  }

  #modelHistoryItemIdExists(itemId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM model_history_items WHERE item_id = ?")
        .get(itemId) !== undefined
    );
  }

  #outboxMessageIdExists(messageId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM outbox WHERE message_id = ?")
        .get(messageId) !== undefined
    );
  }

  #workItemIdExists(workItemId: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 FROM work_items WHERE work_item_id = ?")
        .get(workItemId) !== undefined
    );
  }

  #loadAutomationRecord(
    automationId: string,
  ): AutomationDefinitionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT tenant_id, space_id, automation_id, thread_id, revision,
                definition_digest, definition_json, updated_at
         FROM automations WHERE automation_id = ?`,
      )
      .get(automationId) as AutomationRow | undefined;
    return row === undefined ? null : parseSqliteAutomationRow(row);
  }

  #loadAutomationInvocationAuthority(
    receipt: StoredAutomationInvocationReceipt,
  ) {
    const result = receipt.result;
    const threadId = result.record.definition.threadId;
    const locator = { tenantId: receipt.tenantId, threadId };
    const threadEvents = (
      this.#database
        .prepare(
          `SELECT tenant_id, thread_id, sequence, event_id, event_json
           FROM thread_events WHERE tenant_id = ? AND thread_id = ?
           ORDER BY sequence ASC`,
        )
        .all(receipt.tenantId, threadId) as unknown as ThreadEventRow[]
    ).map((row) =>
      decodeStoredThreadEvent(
        {
          tenantId: row.tenant_id,
          threadId: row.thread_id,
          sequence: row.sequence,
          eventId: row.event_id,
          eventJson: row.event_json,
        },
        locator,
      ),
    );
    const messageRow = this.#database
      .prepare(
        `SELECT messages.tenant_id, messages.thread_id, messages.sequence,
                messages.message_id, messages.role, messages.content,
                messages.content_digest, messages.created_at,
                messages.message_json, invalidations.rollback_id,
                invalidations.marker_item_id, invalidations.history_sequence,
                invalidations.invalidated_at
         FROM messages
         LEFT JOIN message_invalidations AS invalidations
           ON invalidations.tenant_id = messages.tenant_id
          AND invalidations.thread_id = messages.thread_id
          AND invalidations.message_sequence = messages.sequence
         WHERE messages.tenant_id = ? AND messages.message_id = ?`,
      )
      .get(receipt.tenantId, result.message.messageId) as
      | MessageRow
      | undefined;
    const historyRow = this.#database
      .prepare(
        `SELECT tenant_id, thread_id, sequence, item_id, run_id, segment_id,
                item_type, item_json, created_at
         FROM model_history_items WHERE tenant_id = ? AND item_id = ?`,
      )
      .get(receipt.tenantId, result.historyItem.itemId) as
      | ModelHistoryRow
      | undefined;
    const runEvents = (
      this.#database
        .prepare(
          `SELECT tenant_id, run_id, sequence, event_id, event_json
           FROM run_events WHERE tenant_id = ? AND run_id = ?
           ORDER BY sequence ASC`,
        )
        .all(receipt.tenantId, receipt.runId) as unknown as EventRow[]
    ).map((row) =>
      decodeStoredEvent(row, {
        tenantId: receipt.tenantId,
        runId: receipt.runId,
      }),
    );
    const outboxRow = this.#database
      .prepare(
        `SELECT message_id, tenant_id, run_id, topic, created_at, message_json
         FROM outbox WHERE tenant_id = ? AND message_id = ?`,
      )
      .get(receipt.tenantId, result.outbox.messageId) as OutboxRow | undefined;
    const workItemRow = this.#database
      .prepare(
        `SELECT work_item_id, tenant_id, run_id, kind, created_at,
                work_item_json
         FROM work_items WHERE tenant_id = ? AND work_item_id = ?`,
      )
      .get(receipt.tenantId, result.workItem.workItemId) as
      | WorkItemRow
      | undefined;
    return {
      record: this.#loadAutomationRecord(receipt.automationId),
      thread: this.#loadThread(locator),
      threadEvents,
      message:
        messageRow === undefined
          ? null
          : decodeStoredMessage(messageRow, locator, "audit"),
      historyItem:
        historyRow === undefined
          ? null
          : decodeStoredModelHistoryItem(historyRow, locator),
      run: this.#loadRun({ tenantId: receipt.tenantId, runId: receipt.runId }),
      runEvents,
      outbox:
        outboxRow === undefined ? null : decodeStoredOutboxMessage(outboxRow),
      workItem:
        workItemRow === undefined ? null : decodeStoredWorkItem(workItemRow),
    };
  }

  #writeSnapshot(
    current: RunState | null,
    next: RunState,
    expectedRevision: number,
  ): void {
    if (current === null) {
      this.#database
        .prepare(
          `INSERT INTO run_snapshots (
            tenant_id,
            space_id,
            run_id,
            revision,
            last_sequence,
            state_json,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.tenantId,
          next.spaceId,
          next.runId,
          next.revision,
          next.lastSequence,
          stableJson(next),
          next.updatedAt,
        );
      return;
    }

    const update = this.#database
      .prepare(
        `UPDATE run_snapshots
         SET space_id = ?, revision = ?, last_sequence = ?, state_json = ?, updated_at = ?
         WHERE tenant_id = ? AND run_id = ? AND revision = ?`,
      )
      .run(
        next.spaceId,
        next.revision,
        next.lastSequence,
        stableJson(next),
        next.updatedAt,
        next.tenantId,
        next.runId,
        expectedRevision,
      );
    if (update.changes !== 1) {
      throw new RunStoreError("revision_conflict");
    }
  }

  #writeRunThreadBinding(current: RunState | null, next: RunState): void {
    if (current === null) {
      this.#database
        .prepare(
          `INSERT INTO run_thread_bindings (tenant_id, run_id, thread_id)
           VALUES (?, ?, ?)`,
        )
        .run(next.tenantId, next.runId, next.threadId);
      return;
    }
    const row = this.#database
      .prepare(
        `SELECT tenant_id, thread_id
         FROM run_thread_bindings
         WHERE run_id = ?`,
      )
      .get(next.runId) as { tenant_id: string; thread_id: string } | undefined;
    if (
      row === undefined ||
      row.tenant_id !== next.tenantId ||
      row.thread_id !== next.threadId
    ) {
      throw new RunStoreError("stored_run_thread_binding_invalid");
    }
  }

  #writeThreadSnapshot(
    current: ThreadState | null,
    next: ThreadState,
    expectedRevision: number,
  ): void {
    if (current === null) {
      this.#database
        .prepare(
          `INSERT INTO threads (
            tenant_id,
            space_id,
            thread_id,
            created_by_actor_id,
            title,
            status,
            revision,
            last_event_sequence,
            last_message_sequence,
            state_json,
            created_at,
            updated_at,
            archived_at,
            deleted_at,
            deleted_by_actor_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          next.tenantId,
          next.spaceId,
          next.threadId,
          next.createdByActorId,
          next.title,
          next.status,
          next.revision,
          next.lastEventSequence,
          next.lastMessageSequence,
          stableJson(next),
          next.createdAt,
          next.updatedAt,
          next.archivedAt,
          next.deletedAt,
          next.deletedByActorId,
        );
      return;
    }

    const update = this.#database
      .prepare(
        `UPDATE threads
         SET
           title = ?,
           status = ?,
           revision = ?,
           last_event_sequence = ?,
           last_message_sequence = ?,
           state_json = ?,
           updated_at = ?,
           archived_at = ?,
           deleted_at = ?,
           deleted_by_actor_id = ?
         WHERE tenant_id = ? AND thread_id = ? AND revision = ?`,
      )
      .run(
        next.title,
        next.status,
        next.revision,
        next.lastEventSequence,
        next.lastMessageSequence,
        stableJson(next),
        next.updatedAt,
        next.archivedAt,
        next.deletedAt,
        next.deletedByActorId,
        next.tenantId,
        next.threadId,
        expectedRevision,
      );
    if (update.changes !== 1) {
      throw new RunStoreError("revision_conflict");
    }
  }

  #writeThreadEvents(
    events: readonly ThreadLifecycleEvent[],
    tenantId: string,
  ): void {
    const statement = this.#database.prepare(
      `INSERT INTO thread_events (
        tenant_id,
        thread_id,
        sequence,
        event_id,
        event_json
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      statement.run(
        tenantId,
        event.identity.threadId,
        event.sequence,
        event.eventId,
        stableJson(event),
      );
    }
  }

  #writeMessages(messages: readonly MessageRecord[]): void {
    const statement = this.#database.prepare(
      `INSERT INTO messages (
        tenant_id,
        thread_id,
        sequence,
        message_id,
        role,
        content,
        content_digest,
        created_at,
        message_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of messages) {
      statement.run(
        message.tenantId,
        message.threadId,
        message.sequence,
        message.messageId,
        message.role,
        message.content,
        message.contentDigest,
        message.createdAt,
        stableJson(message),
      );
    }
  }

  #writeModelHistoryItems(items: readonly ModelHistoryItem[]): void {
    const statement = this.#database.prepare(
      `INSERT INTO model_history_items (
        tenant_id,
        thread_id,
        sequence,
        item_id,
        run_id,
        segment_id,
        item_type,
        item_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      statement.run(
        item.tenantId,
        item.threadId,
        item.sequence,
        item.itemId,
        item.runId,
        item.segmentId,
        item.type,
        stableJson(item),
        item.createdAt,
      );
    }
  }

  #writeEvents(events: readonly RunLifecycleEvent[], tenantId: string): void {
    const statement = this.#database.prepare(
      `INSERT INTO run_events (
        tenant_id,
        run_id,
        sequence,
        event_id,
        event_json
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      statement.run(
        tenantId,
        event.identity.runId,
        event.sequence,
        event.eventId,
        stableJson(event),
      );
    }
  }

  #writeOutbox(messages: readonly OutboxMessage[]): void {
    const statement = this.#database.prepare(
      `INSERT INTO outbox (
        message_id,
        tenant_id,
        run_id,
        topic,
        message_json,
        created_at,
        available_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of messages) {
      statement.run(
        message.messageId,
        message.tenantId,
        message.runId,
        message.topic,
        stableJson(message),
        message.createdAt,
        parseQueueTimestamp(message.createdAt, "outbox_created_at_invalid"),
      );
    }
  }

  #writeWorkItems(workItems: readonly WorkItem[]): void {
    const statement = this.#database.prepare(
      `INSERT INTO work_items (
        work_item_id,
        tenant_id,
        run_id,
        kind,
        work_item_json,
        created_at,
        available_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const workItem of workItems) {
      statement.run(
        workItem.workItemId,
        workItem.tenantId,
        workItem.runId,
        workItem.kind,
        stableJson(workItem),
        workItem.createdAt,
        parseQueueTimestamp(workItem.createdAt, "work_item_created_at_invalid"),
      );
    }
  }
}

function continuationRecord(
  input: CommitTextRunCompletionInput,
): ThreadContinuationCheckpoint | null {
  if (input.continuation.checkpoint === null) {
    return null;
  }
  const historyItem = requiredTextCompletionHistoryItem(input);
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

function requiredTextCompletionHistoryItem(
  input: CommitTextRunCompletionInput,
): Extract<ModelHistoryItem, { type: "message" }> {
  const item = input.history.items[0];
  if (item?.type !== "message" || item.role !== "assistant") {
    throw new RunStoreError("text_completion_history_missing");
  }
  return item;
}

function requiredTextCompletionMessage(
  input: CommitTextRunCompletionInput,
): MessageRecord {
  const message = input.thread.messages[0];
  if (message === undefined) {
    throw new RunStoreError("text_completion_message_missing");
  }
  return message;
}

function decodeThreadContinuation(
  row: ThreadContinuationRow,
  locator: ThreadContinuationLocator,
): ThreadContinuationCheckpoint {
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    row.agent_version_id !== locator.agentVersionId ||
    row.adapter_name !== locator.adapterName ||
    row.adapter_version !== locator.adapterVersion ||
    row.model_id !== locator.modelId ||
    !(
      (row.history_item_type === "message" &&
        row.history_message_role === "assistant") ||
      (row.history_item_type === "tool_call" &&
        row.history_message_role === null)
    ) ||
    typeof row.context_revision !== "string" ||
    row.context_revision.trim().length === 0 ||
    !Number.isSafeInteger(row.through_history_sequence) ||
    row.through_history_sequence < 1
  ) {
    throw new RunStoreError("stored_thread_continuation_invalid");
  }
  parseQueueTimestamp(row.updated_at, "stored_thread_continuation_invalid");
  let checkpoint: ReturnType<typeof parseExecutionProviderCheckpoint>;
  try {
    checkpoint = parseExecutionProviderCheckpoint(
      parseStoredJson(
        row.checkpoint_json,
        "stored_thread_continuation_invalid",
      ),
    );
  } catch (error) {
    throw new RunStoreError("stored_thread_continuation_invalid", {
      cause: error,
    });
  }
  if (
    checkpoint.adapterName !== locator.adapterName ||
    checkpoint.adapterVersion !== locator.adapterVersion ||
    checkpoint.modelId !== locator.modelId
  ) {
    throw new RunStoreError("stored_thread_continuation_invalid");
  }
  return {
    ...locator,
    throughHistorySequence: row.through_history_sequence,
    contextRevision: row.context_revision,
    checkpoint,
    updatedAt: row.updated_at,
  };
}

function decodeStoredRunState(row: SnapshotRow, locator: RunLocator): RunState {
  const state = normalizeStoredRunState(
    parseStoredJson<RunState>(row.state_json, "stored_run_state_invalid"),
    "stored_run_state_invalid",
  );
  if (
    !isPlainObject(state) ||
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.spaceId !== row.space_id ||
    state.runId !== row.run_id ||
    state.runId !== locator.runId ||
    state.revision !== row.revision ||
    state.lastSequence !== row.last_sequence ||
    row.thread_id === null ||
    state.threadId !== row.thread_id
  ) {
    throw new RunStoreError("stored_run_state_invalid");
  }
  return state;
}

function decodeStoredThreadState(
  row: ThreadSnapshotRow,
  locator: ThreadLocator,
): ThreadState {
  const state = parseStoredJson<ThreadState>(
    row.state_json,
    "stored_thread_state_invalid",
  );
  try {
    validateThreadState(state);
  } catch (error) {
    throw new RunStoreError("stored_thread_state_invalid", { cause: error });
  }
  if (
    !isPlainObject(state) ||
    state.tenantId !== row.tenant_id ||
    state.tenantId !== locator.tenantId ||
    state.spaceId !== row.space_id ||
    state.threadId !== row.thread_id ||
    state.threadId !== locator.threadId ||
    state.createdByActorId !== row.created_by_actor_id ||
    state.title !== row.title ||
    state.status !== row.status ||
    state.revision !== row.revision ||
    state.lastEventSequence !== row.last_event_sequence ||
    state.lastMessageSequence !== row.last_message_sequence ||
    state.createdAt !== row.created_at ||
    state.updatedAt !== row.updated_at ||
    state.archivedAt !== row.archived_at ||
    state.deletedAt !== row.deleted_at ||
    state.deletedByActorId !== row.deleted_by_actor_id ||
    !validThreadForkLineage(state)
  ) {
    throw new RunStoreError("stored_thread_state_invalid");
  }
  return state;
}

function decodeStoredThreadGoal(
  row: ThreadGoalRow,
  locator: ThreadLocator,
): ThreadGoal {
  const goal = parseStoredJson<ThreadGoal>(
    row.state_json,
    "stored_thread_goal_invalid",
  );
  try {
    validateThreadGoal(goal);
  } catch (error) {
    throw new RunStoreError("stored_thread_goal_invalid", { cause: error });
  }
  if (
    goal.tenantId !== row.tenant_id ||
    goal.tenantId !== locator.tenantId ||
    goal.threadId !== row.thread_id ||
    goal.threadId !== locator.threadId ||
    goal.goalId !== row.goal_id ||
    goal.revision !== row.revision ||
    goal.updatedAt !== row.updated_at
  ) {
    throw new RunStoreError("stored_thread_goal_invalid");
  }
  return goal;
}

function decodeStoredThreadGoalEvent(
  row: ThreadGoalEventRow,
  locator: ThreadLocator,
): ThreadGoalEvent {
  const event = parseStoredJson<ThreadGoalEvent>(
    row.event_json,
    "stored_goal_event_invalid",
  );
  try {
    validateThreadGoalEvent(event);
  } catch (error) {
    throw new RunStoreError("stored_goal_event_invalid", { cause: error });
  }
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    event.tenantId !== row.tenant_id ||
    event.threadId !== row.thread_id ||
    event.sequence !== row.sequence ||
    event.eventId !== row.event_id ||
    event.type !== row.event_type ||
    event.occurredAt !== row.occurred_at
  ) {
    throw new RunStoreError("stored_goal_event_invalid");
  }
  return event;
}

function validThreadForkLineage(state: ThreadState): boolean {
  if (
    state.forkedFromThreadId === null &&
    state.forkedThroughHistorySequence === null
  ) {
    return true;
  }
  return (
    typeof state.forkedFromThreadId === "string" &&
    state.forkedFromThreadId.trim().length > 0 &&
    state.forkedFromThreadId !== state.threadId &&
    Number.isSafeInteger(state.forkedThroughHistorySequence) &&
    (state.forkedThroughHistorySequence ?? -1) >= 0
  );
}

function decodeStoredMessage(
  row: MessageRow,
  locator: ThreadLocator,
  view: MessageView = "standard",
): MessageRecord {
  const message = parseStoredJson<MessageRecord>(
    row.message_json,
    "stored_message_invalid",
  );
  if (
    !isPlainObject(message) ||
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    message.tenantId !== row.tenant_id ||
    message.threadId !== row.thread_id ||
    message.sequence !== row.sequence ||
    message.messageId !== row.message_id ||
    message.role !== row.role ||
    message.content !== row.content ||
    message.contentDigest !== row.content_digest ||
    message.createdAt !== row.created_at ||
    message.invalidation !== undefined
  ) {
    throw new RunStoreError("stored_message_invalid");
  }
  validateMessageProposedPlan(message);
  const invalidationValues = [
    row.rollback_id ?? null,
    row.marker_item_id ?? null,
    row.history_sequence ?? null,
    row.invalidated_at ?? null,
  ];
  const hasInvalidation = invalidationValues.every((value) => value !== null);
  if (
    invalidationValues.some((value) => value !== null) !== hasInvalidation ||
    (hasInvalidation &&
      (!Number.isSafeInteger(row.history_sequence) ||
        (row.history_sequence ?? 0) < 1))
  ) {
    throw new RunStoreError("stored_message_invalidation_invalid");
  }
  if (view !== "audit") {
    if (hasInvalidation) {
      throw new RunStoreError("stored_message_invalidation_invalid");
    }
    return message;
  }
  return {
    ...message,
    invalidation: hasInvalidation
      ? {
          rollbackId: row.rollback_id!,
          markerItemId: row.marker_item_id!,
          historySequence: row.history_sequence!,
          invalidatedAt: row.invalidated_at!,
        }
      : null,
  };
}

function decodeStoredModelHistoryItem(
  row: ModelHistoryRow,
  locator: ThreadLocator,
): ModelHistoryItem {
  const item = parseStoredJson<ModelHistoryItem>(
    row.item_json,
    "stored_model_history_item_invalid",
  );
  try {
    validateModelHistoryItem(item);
  } catch (error) {
    throw new RunStoreError("stored_model_history_item_invalid", {
      cause: error,
    });
  }
  if (
    row.tenant_id !== locator.tenantId ||
    row.thread_id !== locator.threadId ||
    item.tenantId !== row.tenant_id ||
    item.threadId !== row.thread_id ||
    item.sequence !== row.sequence ||
    item.itemId !== row.item_id ||
    item.runId !== row.run_id ||
    item.segmentId !== row.segment_id ||
    item.type !== row.item_type ||
    item.createdAt !== row.created_at
  ) {
    throw new RunStoreError("stored_model_history_item_invalid");
  }
  return item;
}

function decodeStoredEvent(
  row: EventRow,
  locator: RunLocator,
): RunLifecycleEvent {
  const event = parseStoredJson<RunLifecycleEvent>(
    row.event_json,
    "stored_event_invalid",
  );
  if (
    !isPlainObject(event) ||
    !isPlainObject(event.identity) ||
    row.tenant_id !== locator.tenantId ||
    row.run_id !== locator.runId ||
    event.identity.runId !== row.run_id ||
    event.sequence !== row.sequence ||
    event.eventId !== row.event_id
  ) {
    throw new RunStoreError("stored_event_invalid");
  }
  return event;
}

function decodeStoredOutboxMessage(row: OutboxRow): OutboxMessage {
  const message = parseStoredJson<OutboxMessage>(
    row.message_json,
    "stored_outbox_message_invalid",
  );
  if (
    !isPlainObject(message) ||
    message.messageId !== row.message_id ||
    message.tenantId !== row.tenant_id ||
    message.runId !== row.run_id ||
    message.topic !== row.topic ||
    message.createdAt !== row.created_at
  ) {
    throw new RunStoreError("stored_outbox_message_invalid");
  }
  return message;
}

function decodeStoredWorkItem(row: WorkItemRow): WorkItem {
  const workItem = parseStoredJson<WorkItem>(
    row.work_item_json,
    "stored_work_item_invalid",
  );
  if (
    !isPlainObject(workItem) ||
    workItem.workItemId !== row.work_item_id ||
    workItem.tenantId !== row.tenant_id ||
    workItem.runId !== row.run_id ||
    workItem.kind !== row.kind ||
    workItem.createdAt !== row.created_at
  ) {
    throw new RunStoreError("stored_work_item_invalid");
  }
  return workItem;
}

function validateStoredReceiptResult(
  result: CommitRunResult,
  row: ReceiptRow,
): void {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.state) ||
    result.disposition !== "committed" ||
    result.state.tenantId !== row.tenant_id ||
    result.state.runId !== row.run_id ||
    !Array.isArray(result.events) ||
    !Array.isArray(result.outbox) ||
    !Array.isArray(result.workItems)
  ) {
    throw new RunStoreError("idempotency_receipt_invalid");
  }
}

function validateStoredGoalToolResult(
  result: GoalToolExecutionResult,
  row: ReceiptRow,
  threadId: string,
): void {
  if (
    !isPlainObject(result) ||
    result.disposition !== "committed" ||
    typeof result.output !== "string" ||
    new TextEncoder().encode(result.output).byteLength > 40_000 ||
    typeof result.isError !== "boolean" ||
    !isPlainObject(result.runState) ||
    result.runState.tenantId !== row.tenant_id ||
    result.runState.runId !== row.run_id ||
    result.runState.threadId !== threadId ||
    !Array.isArray(result.runEvents) ||
    !Array.isArray(result.outbox) ||
    (result.goalState !== null &&
      (!isPlainObject(result.goalState) ||
        result.goalState.tenantId !== row.tenant_id ||
        result.goalState.threadId !== threadId))
  ) {
    throw new RunStoreError("goal_tool_receipt_invalid");
  }
  if (result.goalState !== null) {
    try {
      validateThreadGoal(result.goalState);
    } catch (error) {
      throw new RunStoreError("goal_tool_receipt_invalid", { cause: error });
    }
  }
  const runState = normalizeStoredRunState(
    result.runState,
    "goal_tool_receipt_invalid",
  );
  validateEvents(result.runEvents, runState.runId, () => false);
  validateOutbox(result.outbox, runState.runId, row.tenant_id, () => false);
  if (
    result.runEvents.length !== result.outbox.length ||
    result.runEvents.length > 1 ||
    (result.runEvents[0]?.type === "run.goal.accounting.updated" &&
      (result.runEvents[0].sequence !== runState.lastSequence ||
        stableJson(result.runEvents[0].data.next) !==
          stableJson(runState.goalAccounting)))
  ) {
    throw new RunStoreError("goal_tool_receipt_invalid");
  }
}

function validateStoredThreadGoalMutationResult(
  result: CommitThreadGoalMutationResult,
  row: ThreadReceiptRow,
): void {
  if (
    !isPlainObject(result) ||
    result.disposition !== "committed" ||
    typeof result.goalChanged !== "boolean" ||
    (result.goalState !== null &&
      (!isPlainObject(result.goalState) ||
        result.goalState.tenantId !== row.tenant_id ||
        result.goalState.threadId !== row.thread_id)) ||
    (result.canceledRunState !== null &&
      (!isPlainObject(result.canceledRunState) ||
        result.canceledRunState.tenantId !== row.tenant_id ||
        result.canceledRunState.threadId !== row.thread_id ||
        result.canceledRunState.status !== "canceled")) ||
    (result.retainedRun !== null &&
      (!isPlainObject(result.retainedRun) ||
        !isPlainObject(result.retainedRun.runState) ||
        !Array.isArray(result.retainedRun.runEvents) ||
        !Array.isArray(result.retainedRun.outbox))) ||
    (result.continuation !== null &&
      (!isPlainObject(result.continuation) ||
        !isPlainObject(result.continuation.runState) ||
        !isPlainObject(result.continuation.historyItem) ||
        result.continuation.runState.tenantId !== row.tenant_id ||
        result.continuation.runState.threadId !== row.thread_id ||
        result.continuation.historyItem.tenantId !== row.tenant_id ||
        result.continuation.historyItem.threadId !== row.thread_id ||
        !Array.isArray(result.continuation.runEvents) ||
        !Array.isArray(result.continuation.outbox) ||
        !Array.isArray(result.continuation.workItems)))
  ) {
    throw new RunStoreError("goal_mutation_receipt_invalid");
  }
  if (result.goalState !== null) {
    try {
      validateThreadGoal(result.goalState);
    } catch (error) {
      throw new RunStoreError("goal_mutation_receipt_invalid", {
        cause: error,
      });
    }
  }
  if (result.retainedRun !== null) {
    const runState = normalizeStoredRunState(
      result.retainedRun.runState,
      "goal_mutation_receipt_invalid",
    );
    validateThreadGoalRetainedRunReceipt(
      result.retainedRun,
      runState,
      result.goalState,
      { tenantId: row.tenant_id, threadId: row.thread_id },
    );
  }
}

function validateStoredTurnStartReceiptResult(
  result: CommitTurnStartResult,
  row: ReceiptRow,
  threadId: string,
): void {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.runState) ||
    !isPlainObject(result.threadState) ||
    result.disposition !== "committed" ||
    result.runState.tenantId !== row.tenant_id ||
    result.runState.runId !== row.run_id ||
    result.runState.threadId !== threadId ||
    result.threadState.tenantId !== row.tenant_id ||
    result.threadState.threadId !== threadId ||
    !Array.isArray(result.runEvents) ||
    !Array.isArray(result.threadEvents) ||
    !Array.isArray(result.messages) ||
    !Array.isArray(result.historyItems) ||
    !Array.isArray(result.outbox) ||
    !Array.isArray(result.workItems)
  ) {
    throw new RunStoreError("turn_start_idempotency_receipt_invalid");
  }
  for (const item of result.historyItems) {
    try {
      validateModelHistoryItem(item);
    } catch (error) {
      throw new RunStoreError("turn_start_idempotency_receipt_invalid", {
        cause: error,
      });
    }
    if (item.tenantId !== row.tenant_id || item.threadId !== threadId) {
      throw new RunStoreError("turn_start_idempotency_receipt_invalid");
    }
  }
}

function normalizeStoredTurnStartResult(
  result: CommitTurnStartResult,
): CommitTurnStartResult {
  if (!isPlainObject(result) || !isPlainObject(result.runState)) return result;
  return {
    ...result,
    runState: normalizeStoredRunState(
      result.runState,
      "turn_start_idempotency_receipt_invalid",
    ),
    ...(Object.hasOwn(result, "goalState") ? {} : { goalState: null }),
  };
}

function normalizeStoredRunResult(result: CommitRunResult): CommitRunResult {
  return !isPlainObject(result) || !isPlainObject(result.state)
    ? result
    : {
        ...result,
        state: normalizeStoredRunState(
          result.state,
          "idempotency_receipt_invalid",
        ),
      };
}

function normalizeStoredExecutionResult(
  result: CommitTextRunCompletionResult,
): CommitTextRunCompletionResult {
  if (!isPlainObject(result) || !isPlainObject(result.runState)) return result;
  const goalContinuation = Object.hasOwn(result, "goalContinuation")
    ? result.goalContinuation
    : null;
  return {
    ...result,
    runState: normalizeStoredRunState(
      result.runState,
      "execution_idempotency_receipt_invalid",
    ),
    ...(Object.hasOwn(result, "goalState") ? {} : { goalState: null }),
    goalContinuation:
      goalContinuation === null || !isPlainObject(goalContinuation.runState)
        ? goalContinuation
        : {
            ...goalContinuation,
            runState: normalizeStoredRunState(
              goalContinuation.runState,
              "execution_idempotency_receipt_invalid",
            ),
          },
  };
}

function isTerminalRunStatus(status: RunState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function validateStoredExecutionReceiptResult(
  result: CommitTextRunCompletionResult,
  row: ReceiptRow,
  threadId: string,
): void {
  if (
    !isPlainObject(result) ||
    !isPlainObject(result.runState) ||
    !isPlainObject(result.threadState) ||
    result.disposition !== "committed" ||
    result.runState.tenantId !== row.tenant_id ||
    result.runState.runId !== row.run_id ||
    result.runState.threadId !== threadId ||
    result.threadState.tenantId !== row.tenant_id ||
    result.threadState.threadId !== threadId ||
    !Array.isArray(result.runEvents) ||
    !Array.isArray(result.threadEvents) ||
    !Array.isArray(result.messages) ||
    !Array.isArray(result.historyItems) ||
    !Array.isArray(result.outbox) ||
    !isPlainObject(result.step) ||
    !isPlainObject(result.attempt) ||
    result.step.tenantId !== row.tenant_id ||
    result.step.runId !== row.run_id ||
    result.attempt.tenantId !== row.tenant_id ||
    result.attempt.runId !== row.run_id ||
    result.attempt.stepId !== result.step.stepId ||
    (result.continuation !== null && !isPlainObject(result.continuation)) ||
    (result.goalContinuation !== null &&
      (!isPlainObject(result.goalContinuation) ||
        !isPlainObject(result.goalContinuation.runState) ||
        !isPlainObject(result.goalContinuation.historyItem) ||
        !Array.isArray(result.goalContinuation.runEvents) ||
        !Array.isArray(result.goalContinuation.outbox) ||
        !Array.isArray(result.goalContinuation.workItems) ||
        result.goalContinuation.runState.tenantId !== row.tenant_id ||
        result.goalContinuation.historyItem.runId !==
          result.goalContinuation.runState.runId))
  ) {
    throw new RunStoreError("execution_idempotency_receipt_invalid");
  }
  if (result.continuation !== null) {
    try {
      parseExecutionProviderCheckpoint(result.continuation.checkpoint);
    } catch (error) {
      throw new RunStoreError("execution_idempotency_receipt_invalid", {
        cause: error,
      });
    }
  }
  for (const item of result.historyItems) {
    try {
      validateModelHistoryItem(item);
    } catch (error) {
      throw new RunStoreError("execution_idempotency_receipt_invalid", {
        cause: error,
      });
    }
    if (
      item.tenantId !== row.tenant_id ||
      item.threadId !== result.threadState.threadId
    ) {
      throw new RunStoreError("execution_idempotency_receipt_invalid");
    }
  }
}

function requiredMetadata(row: QueueMetadataRow | undefined): QueueMetadataRow {
  if (row === undefined) {
    throw new RunStoreError("queue_item_not_found");
  }
  return row;
}

function validateMetadataLease(
  row: QueueMetadataRow,
  input: { ownerId: string; leaseId: string; leaseEpoch: number },
  now: number,
  settledStatus: string,
): void {
  const expiresAtMs = row.lease_expires_at_ms ?? 0;
  validateClaimedLease(
    {
      ownerId: row.lease_owner_id ?? "",
      leaseId: row.lease_id ?? "",
      epoch: row.lease_epoch,
    },
    input,
    expiresAtMs,
    now,
    row.status,
    settledStatus,
  );
}

function lease(
  input: QueueClaimInput,
  epoch: number,
  expiresAt: string,
): QueueLease {
  return {
    ownerId: input.ownerId,
    leaseId: input.leaseId,
    epoch,
    expiresAt,
  };
}

function nextLeaseEpoch(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new RunStoreError("lease_epoch_invalid");
  }
  return next;
}

function retryAvailableAt(now: number, retryAfterMs: number): number {
  const availableAt = now + retryAfterMs;
  if (!Number.isSafeInteger(availableAt)) {
    throw new RunStoreError("queue_retry_delay_invalid");
  }
  return availableAt;
}

function parseStoredJson<T>(json: string, code: string): T {
  try {
    const parsed: unknown = JSON.parse(json);
    stableJson(parsed);
    return parsed as T;
  } catch (error) {
    throw new RunStoreError(code, { cause: error });
  }
}

function parseSqliteAutomationRow(
  row: AutomationRow,
): AutomationDefinitionRecord {
  const record = {
    definition: parseStoredJson<AutomationDefinitionRecord["definition"]>(
      row.definition_json,
      "automation_record_invalid",
    ),
    definitionDigest: row.definition_digest,
  };
  validateAutomationRecord(record);
  if (
    row.tenant_id !== record.definition.tenantId ||
    row.space_id !== record.definition.spaceId ||
    row.automation_id !== record.definition.automationId ||
    row.thread_id !== record.definition.threadId ||
    row.revision !== record.definition.revision ||
    row.updated_at !== record.definition.updatedAt
  ) {
    throw new RunStoreError("automation_record_invalid");
  }
  return record;
}

function decodeSqliteAgentVersion(row: AgentVersionRow): AgentVersionAsset {
  try {
    const asset = parseStoredJson<AgentVersionAsset>(
      row.asset_json,
      "agent_version_asset_corrupt",
    );
    validateAgentVersionAsset(asset);
    if (
      asset.tenantId !== row.tenant_id ||
      asset.agentVersionId !== row.agent_version_id ||
      asset.contentDigest !== row.content_digest ||
      asset.createdAt !== row.created_at
    ) {
      throw new Error("agent_version_columns_mismatch");
    }
    return asset;
  } catch (error) {
    throw new RunStoreError("agent_version_asset_corrupt", { cause: error });
  }
}

function decodeSqliteAgentVersionDeployment(
  row: AgentVersionDeploymentRow,
): AgentVersionDeployment {
  try {
    const deployment = parseStoredJson<AgentVersionDeployment>(
      row.deployment_json,
      "agent_version_deployment_corrupt",
    );
    validateAgentVersionDeployment(deployment);
    if (
      deployment.tenantId !== row.tenant_id ||
      deployment.agentVersionId !== row.agent_version_id ||
      deployment.contentDigest !== row.content_digest ||
      deployment.materializationDigest !== row.materialization_digest ||
      deployment.deployedAt !== row.deployed_at
    ) {
      throw new Error("agent_version_deployment_columns_mismatch");
    }
    return deployment;
  } catch (error) {
    throw new RunStoreError("agent_version_deployment_corrupt", {
      cause: error,
    });
  }
}

function decodeSqliteAgentVersionReleaseBundle(
  row: AgentVersionReleaseBundleRow,
): AgentVersionReleaseBundle {
  try {
    const bundle = parseStoredJson<AgentVersionReleaseBundle>(
      row.bundle_json,
      "agent_version_release_bundle_corrupt",
    );
    validateAgentVersionReleaseBundle(bundle);
    if (
      bundle.tenantId !== row.tenant_id ||
      bundle.releaseId !== row.release_id ||
      bundle.manifestDigest !== row.manifest_digest ||
      bundle.defaultAgentVersionId !== row.default_agent_version_id
    ) {
      throw new Error("agent_version_release_bundle_columns_mismatch");
    }
    return bundle;
  } catch (error) {
    throw new RunStoreError("agent_version_release_bundle_corrupt", {
      cause: error,
    });
  }
}

function decodeSqliteAgentVersionReleaseActivation(
  row: AgentVersionReleaseActivationRow,
): AgentVersionReleaseActivation {
  try {
    const activation = parseStoredJson<AgentVersionReleaseActivation>(
      row.activation_json,
      "agent_version_release_activation_corrupt",
    );
    validateAgentVersionReleaseActivation(activation);
    if (
      activation.tenantId !== row.tenant_id ||
      activation.activationId !== row.activation_id ||
      activation.releaseId !== row.release_id ||
      activation.previousReleaseId !== row.previous_release_id ||
      activation.operator.principalId !== row.operator_principal_id ||
      activation.operator.actorId !== row.operator_actor_id ||
      activation.operator.spaceId !== row.operator_space_id ||
      activation.activatedAt !== row.activated_at
    ) {
      throw new Error("agent_version_release_activation_columns_mismatch");
    }
    return activation;
  } catch (error) {
    throw new RunStoreError("agent_version_release_activation_corrupt", {
      cause: error,
    });
  }
}

function validateReleaseActivationInput(input: {
  bundle: AgentVersionReleaseBundle;
  activation: AgentVersionReleaseActivation;
}): void {
  if (
    input.activation.tenantId !== input.bundle.tenantId ||
    input.activation.releaseId !== input.bundle.releaseId
  ) {
    throw new RunStoreError("agent_version_release_activation_mismatch");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateApprovalLocator(locator: ToolApprovalLocator): void {
  requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
  requireNonEmpty(locator.approvalId, "approval_id_invalid");
}

function validateApprovalActionLocator(
  locator: ToolApprovalActionLocator,
): void {
  requireNonEmpty(locator.tenantId, "approval_tenant_id_invalid");
  requireNonEmpty(locator.runId, "approval_run_id_invalid");
  if (!/^sha256:[a-f0-9]{64}$/.test(locator.actionDigest)) {
    throw new RunStoreError("approval_action_digest_invalid");
  }
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

function normalizeSqliteError(error: unknown): Error {
  if (error instanceof AgentVersionError) {
    return new RunStoreError("workflow_agent_deployment_mismatch", {
      cause: error,
    });
  }
  if (error instanceof ThreadGoalError) {
    return new RunStoreError(error.code, { cause: error });
  }
  if (
    error instanceof RunStoreError ||
    error instanceof RunLifecycleError ||
    error instanceof ThreadLifecycleError
  ) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/i.test(message)) {
    return new RunStoreError("sqlite_busy", { cause: error });
  }
  if (/constraint/i.test(message)) {
    return new RunStoreError("sqlite_constraint", { cause: error });
  }
  return new RunStoreError("sqlite_error", { cause: error });
}
