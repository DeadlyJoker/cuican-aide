import { RuntimePreflight } from "./runtime-preflight.ts";
import { AgentRuntimeCapacityError } from "./agent-runtime-capacity.ts";
import { RuntimeStoreAccess } from "./runtime-store-access.ts";
import { RuntimeWorkItemClaims } from "./runtime-work-item-claims.ts";
import {
  CONTINUE_RUN,
  runWithExecutionBudget,
  executionBudget,
  type RuntimeExecutionBudget,
  type RuntimeWorkerStepOutcome,
} from "./runtime-execution-budget.ts";
import type { RuntimeWorkerOutcome } from "./runtime-worker-outcome.ts";
import {
  loadEmptyContinuation,
  selectEmptyContinuation,
} from "./runtime-empty-continuation.ts";
import { loadRuntimeRunProgress } from "./runtime-run-progress.ts";
import {
  MAX_EMPTY_PROVIDER_CONTINUATIONS,
  MAX_ASSISTANT_PROVIDER_CONTINUATIONS,
} from "@crewon/domain";
import { durableCompactionCheckpoint } from "./durable-compaction-checkpoint.ts";
import { recordWorkerAgentEvent } from "./record-worker-agent-event.ts";
import { RuntimeWorkerQueries } from "./runtime-worker-queries.ts";
import type { ExperimentalWorkflowScheduler } from "./workflow-scheduler.ts";
import {
  RuntimeAuthorityError,
  type AuthorityTime,
} from "./runtime-authority-query.ts";
import { ToolResultMaintenance } from "./tool-result-maintenance.ts";
import type { PluginCreditSettlementMaintenancePort } from "./plugins/plugin-credit-settlement-runtime-types.ts";
import { toolResultMaintenanceSources } from "./tool-result-maintenance-sources.ts";
import { durableModelCallSink } from "./durable-model-call-sink.ts";
import { StorageAdmissionError } from "@crewon/application";
import { RunStoreBusyError } from "@crewon/application";
import {
  withToolExecutionCapacity,
  preflightToolExecutionCapacity,
} from "./tool-execution-capacity.ts";
import { withWorkerToolDispatch } from "./plugins/worker-tool-dispatch-authority.ts";
import { settleCanceledToolResults } from "./canceled-tool-results.ts";
import { resolveToolBatch } from "./resolve-tool-batch.ts";
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { loadRuntimeModelContext } from "./runtime-model-context.ts";
import { durableModelUsageSink } from "./durable-model-usage-sink.ts";
import {
  loadToolReconciliationDelay,
  toolReconciliationDelay,
} from "./tool-reconciliation-backoff.ts";
import {
  acknowledgeCommittedToolResult,
  reconcileCommittedToolResults,
} from "./committed-tool-result.ts";

import {
  AgentKernelError,
  type AgentContinuation,
  type AgentKernelPort,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import {
  ApplicationError,
  RunStoreError,
  type DomainStore,
  type RunExecutionPolicyPort,
  type RunExecutionService,
  type RunAttemptIdentity,
  type ThreadContinuationCheckpoint,
  type ToolOutputArtifactPort,
  type WorkItemClaim,
  type WorkItemExecutionScope,
  type GoalToolExecutionResult,
} from "@crewon/application";
import type {
  CanonicalAgentEvent,
  ProviderCheckpoint,
  WorkspaceChangeSummary,
} from "@crewon/contracts";
import {
  ContextHistoryError,
  CONTEXT_COMPACTION_PROMPT,
  projectedContinuationStart,
  type ContextCompactorPort,
  type ContextHistoryItem,
  type GovernedContextBundle,
  type ModelContextProjection,
} from "@crewon/context";
import type {
  RunLifecycleEvent,
  RunState,
  ToolApprovalState,
  ToolExecutionReceiptState,
} from "@crewon/domain";
import { parseAutomationInvocationBinding } from "@crewon/domain";
import {
  InMemoryToolBroker,
  ToolResultCapacityError,
  ToolExecutionPendingError,
  modelVisibleToolOutput,
  type ToolExecutionCommand,
  type ToolDefinition,
  type ToolExecutionPolicy,
  type ToolExecutionResolution,
  type ToolRuntimePort,
} from "@crewon/tool-broker";
import {
  CancellationWatcher,
  LeaseHeartbeat,
  systemRuntimeWorkerScheduler,
  type RuntimeWorkerScheduler,
} from "./runtime-worker-watchers.ts";
import { KernelContextCompactor } from "./kernel-context-compactor.ts";
import {
  decideModelSwitchCompaction,
  type PriorModelCompactionResolverPort,
} from "./model-switch-compaction.ts";
import type {
  AgentExecutionAuthority,
  AgentVersionRuntime,
  AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import { PlanOutputError, parseProposedPlan } from "./plan-output.ts";
import { goalToolsForRun, isGoalToolCall } from "./goal-tools.ts";
import { batchModelOutputEvents } from "./model-output-batches.ts";
import { isRunPlanToolCall, runPlanToolsForRun } from "./run-plan-tools.ts";
import { replaceChangedToolApproval } from "./tool-approval-replacement.ts";
import {
  RuntimeResourceScope,
  externalResourceLease,
} from "./runtime-resource-lease.ts";
import {
  acquireRuntimeResource,
  acquirePriorCompactorResource,
} from "./runtime-resource-resolution.ts";
import {
  acquireInstalledPluginRunToolRuntime,
  readInstalledPluginTaskAdmission,
  InstalledPluginRuntimeError,
  type InstalledPluginRunRuntimeResolverPort,
  type PluginTaskAdmissionProbe,
} from "./plugins/installed-plugin-run-runtime.ts";

export type { RuntimeWorkerScheduler } from "./runtime-worker-watchers.ts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_APPROVAL_RECHECK_MS = 1_000;
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SCAN_INTERVAL_MS = 1_000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_CONTEXT_ITEMS = 256;
const DEFAULT_AUTO_COMPACT_AT_CONTEXT_ITEMS = 192;
const DEFAULT_MAX_CONTEXT_BYTES = 512 * 1024;
const DEFAULT_AUTO_COMPACT_AT_CONTEXT_BYTES = 384 * 1024;
const DEFAULT_AUTO_COMPACT_AT_TOKENS = 200_000;
const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 273_000;
const MAX_CANONICAL_AGENT_EVENT_BYTES = 64 * 1024;
const MAX_TOOL_ARTIFACT_REF_BYTES = 512;
const MIN_MAX_CONTEXT_BYTES = 96 * 1024;
const MIN_AUTO_COMPACT_AT_CONTEXT_BYTES = 72 * 1024;
const HISTORY_PAGE_SIZE = 100;
const DEFAULT_MAX_TOOL_ROUNDS = 32;
const MAX_TOOL_ROUNDS = 128;
const UNSUPPORTED_TOOL_POLICY: ToolExecutionPolicy = {
  effect: "readOnly",
  recovery: "replaySafe",
  resourceBindingId: null,
  credentialBindingId: null,
  executionTarget: {
    kind: "control",
    bindingId: "unsupported-tool-runtime",
  },
  capability: "tool.unsupported",
  approvalRequirement: "none",
  limits: {
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024,
    maxArtifactBytes: 1024 * 1024,
  },
};

export type { ToolRuntimePort } from "@crewon/tool-broker";

export type RuntimeWorkerConfig = Readonly<{
  ownerId: string;
  nextLeaseId: () => string;
  workItemExecutionScope?: WorkItemExecutionScope;
  leaseDurationMs?: number;
  retryAfterMs?: number;
  approvalRecheckMs?: number;
  approvalTtlMs?: number;
  scanIntervalMs?: number | null;
  cancellationPollIntervalMs?: number;
  cancellationScheduler?: RuntimeWorkerScheduler;
  maxContextItems?: number;
  autoCompactAtContextItems?: number | null;
  maxContextBytes?: number;
  autoCompactAtContextBytes?: number | null;
  autoCompactAtTokens?: number | null;
  modelContextWindowTokens?: number;
  maxToolRounds?: number;
  executionBudget?: Partial<RuntimeExecutionBudget>;
  afterRunStarted?: (() => Promise<void>) | undefined;
  afterAttemptStarted?: (() => Promise<void>) | undefined;
  afterProviderResponseCheckpointed?: (() => Promise<void>) | undefined;
  beforeAssistantSampleCommitted?: (() => Promise<void>) | undefined;
  afterAssistantSampleCommitted?: (() => Promise<void>) | undefined;
  afterToolDispatched?:
    | ((receipt: ToolExecutionReceiptState) => Promise<void>)
    | undefined;
  afterToolProviderResolved?:
    | ((resolution: ToolExecutionResolution) => Promise<void>)
    | undefined;
  afterToolReceiptCommitted?:
    | ((receipt: ToolExecutionReceiptState) => Promise<void>)
    | undefined;
  afterGoalToolExecuted?:
    | ((result: GoalToolExecutionResult) => Promise<void>)
    | undefined;
  afterRunPlanToolExecuted?: (() => Promise<void>) | undefined;
}>;

export type { RuntimeWorkerOutcome } from "./runtime-worker-outcome.ts";

type WorkerAgentRuntime = Readonly<{
  executionAuthority: AgentExecutionAuthority;
  kernel: AgentKernelPort;
  policy: RunExecutionPolicyPort;
  toolRuntime: ToolRuntimePort;
  toolDefinitions: readonly ToolDefinition[];
  contextCompactor: ContextCompactorPort;
  governedContextItems: readonly ContextHistoryItem[];
  governedContextBytes: number;
  autoCompactAtTokens: number | null;
  modelContextWindowTokens: number;
  maxToolRounds: number;
}>;

export class RuntimeWorker {
  readonly #executionBudget: RuntimeExecutionBudget;
  readonly #toolResultMaintenance: ToolResultMaintenance;
  readonly #pluginCreditSettlement:
    | PluginCreditSettlementMaintenancePort
    | undefined;
  #pluginCreditSettlementClose: Promise<void> | undefined;
  readonly #store: DomainStore;
  readonly #storeAccess: RuntimeStoreAccess;
  readonly #preflight: RuntimePreflight;
  #runtimeResourceScope: RuntimeResourceScope | null = null;
  readonly #workflowScheduler: ExperimentalWorkflowScheduler | undefined;
  readonly #execution: RunExecutionService;
  readonly #kernel: AgentKernelPort;
  readonly #policy: RunExecutionPolicyPort;
  readonly #toolRuntime: ToolRuntimePort;
  readonly #artifacts: ToolOutputArtifactPort | undefined;
  readonly #toolDefinitions: readonly ToolDefinition[];
  readonly #contextCompactor: ContextCompactorPort;
  readonly #modelSwitchCompactionResolver:
    | PriorModelCompactionResolverPort
    | undefined;
  readonly #agentVersionRuntimeResolver:
    | AgentVersionRuntimeResolverPort
    | undefined;
  readonly #pluginTaskAdmissions: PluginTaskAdmissionProbe | undefined;
  readonly #installedPluginRuntimeResolver:
    | InstalledPluginRunRuntimeResolverPort
    | undefined;
  readonly #governedContextItems: readonly ContextHistoryItem[];
  readonly #governedContextBytes: number;
  readonly #ownerId: string;
  readonly #workItemClaims: RuntimeWorkItemClaims;
  readonly #nextLeaseId: () => string;
  readonly #leaseDurationMs: number;
  readonly #retryAfterMs: number;
  readonly #approvalRecheckMs: number;
  readonly #approvalTtlMs: number;
  readonly #scanIntervalMs: number | null;
  readonly #cancellationPollIntervalMs: number;
  readonly #cancellationScheduler: RuntimeWorkerScheduler;
  readonly #maxContextItems: number;
  readonly #autoCompactAtContextItems: number | null;
  readonly #maxContextBytes: number;
  readonly #autoCompactAtContextBytes: number | null;
  readonly #autoCompactAtTokens: number | null;
  readonly #modelContextWindowTokens: number;
  readonly #maxToolRounds: number;
  readonly #afterRunStarted: (() => Promise<void>) | undefined;
  readonly #afterAttemptStarted: (() => Promise<void>) | undefined;
  readonly #afterProviderResponseCheckpointed:
    | (() => Promise<void>)
    | undefined;
  readonly #beforeAssistantSampleCommitted: (() => Promise<void>) | undefined;
  readonly #afterAssistantSampleCommitted: (() => Promise<void>) | undefined;
  readonly #afterToolDispatched:
    | ((receipt: ToolExecutionReceiptState) => Promise<void>)
    | undefined;
  readonly #afterToolProviderResolved:
    | ((resolution: ToolExecutionResolution) => Promise<void>)
    | undefined;
  readonly #afterToolReceiptCommitted:
    | ((receipt: ToolExecutionReceiptState) => Promise<void>)
    | undefined;
  readonly #afterGoalToolExecuted:
    | ((result: GoalToolExecutionResult) => Promise<void>)
    | undefined;
  readonly #afterRunPlanToolExecuted: (() => Promise<void>) | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  #drain: Promise<RuntimeWorkerOutcome> | null = null;
  #closeTask: Promise<void> | null = null;
  #closed = false;
  readonly #executionControllers = new Set<AbortController>();
  readonly #queries: RuntimeWorkerQueries;
  #lastOutcome: RuntimeWorkerOutcome | null = null;

  constructor(
    dependencies: {
      store: DomainStore;
      storeAccessTime?: AuthorityTime;
      preflightTime?: AuthorityTime;
      experimentalWorkflowScheduler?: ExperimentalWorkflowScheduler;
      execution: RunExecutionService;
      kernel: AgentKernelPort;
      policy: RunExecutionPolicyPort;
      toolRuntime?: ToolRuntimePort;
      artifacts?: ToolOutputArtifactPort;
      toolDefinitions?: readonly ToolDefinition[];
      contextCompactor?: ContextCompactorPort;
      governedContext?: GovernedContextBundle;
      modelSwitchCompactionResolver?: PriorModelCompactionResolverPort;
      agentVersionRuntimeResolver?: AgentVersionRuntimeResolverPort;
      pluginTaskAdmissions?: PluginTaskAdmissionProbe;
      installedPluginRuntimeResolver?: InstalledPluginRunRuntimeResolverPort;
      pluginCreditSettlement?: PluginCreditSettlementMaintenancePort;
    },
    config: RuntimeWorkerConfig,
  ) {
    this.#leaseDurationMs = positiveInteger(
      config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "worker_lease_duration_invalid",
    );
    this.#queries = new RuntimeWorkerQueries({
      leaseDurationMs: this.#leaseDurationMs,
    });
    this.#preflight = new RuntimePreflight({
      leaseDurationMs: this.#leaseDurationMs,
      time: dependencies.preflightTime,
    });
    this.#storeAccess = new RuntimeStoreAccess({
      leaseDurationMs: this.#leaseDurationMs,
      time: dependencies.storeAccessTime,
      onFailure: (error) => {
        this.#queries.interruptPending();
        for (const controller of this.#executionControllers)
          controller.abort(error.code);
      },
    });
    this.#store = this.#storeAccess.store(dependencies.store);
    this.#workItemClaims = new RuntimeWorkItemClaims({
      store: this.#store,
      executionScope: config.workItemExecutionScope,
    });
    this.#workflowScheduler = dependencies.experimentalWorkflowScheduler;
    this.#execution = dependencies.execution.withStoreAccess((store) =>
      this.#storeAccess.store(store),
    );
    this.#kernel = dependencies.kernel;
    this.#policy = dependencies.policy;
    this.#toolRuntime = dependencies.toolRuntime ?? new InMemoryToolBroker();
    this.#artifacts = dependencies.artifacts;
    this.#toolDefinitions = structuredClone(
      dependencies.toolDefinitions ?? this.#toolRuntime.definitions(),
    );
    this.#contextCompactor =
      dependencies.contextCompactor ?? new KernelContextCompactor(this.#kernel);
    this.#modelSwitchCompactionResolver =
      dependencies.modelSwitchCompactionResolver;
    this.#agentVersionRuntimeResolver =
      dependencies.agentVersionRuntimeResolver;
    this.#pluginTaskAdmissions = dependencies.pluginTaskAdmissions;
    this.#installedPluginRuntimeResolver =
      dependencies.installedPluginRuntimeResolver;
    this.#pluginCreditSettlement = dependencies.pluginCreditSettlement;
    let visitRegistry = false;
    this.#toolResultMaintenance = new ToolResultMaintenance({
      store: dependencies.store,
      nextRuntimeLease: toolResultMaintenanceSources({
        ...(this.#installedPluginRuntimeResolver
          ?.nextToolResultMaintenanceLease === undefined
          ? {}
          : {
              installed: () =>
                this.#installedPluginRuntimeResolver!
                  .nextToolResultMaintenanceLease!(),
            }),
        base: () => {
          const resolver = this.#agentVersionRuntimeResolver;
          if (resolver?.nextToolResultMaintenanceLease !== undefined) {
            return resolver.nextToolResultMaintenanceLease();
          }
          visitRegistry = !visitRegistry;
          if (visitRegistry) {
            return externalResourceLease(
              resolver?.nextToolResultMaintenanceRuntime?.() ??
                this.#toolRuntime,
            );
          }
          return externalResourceLease(this.#toolRuntime);
        },
      }),
    });
    this.#governedContextItems =
      dependencies.governedContext?.modelItems() ?? [];
    this.#governedContextBytes = this.#governedContextItems.reduce(
      (total, item) =>
        total + (item.type === "message" ? utf8ByteLength(item.content) : 0),
      0,
    );
    this.#ownerId = requireBoundedString(
      config.ownerId,
      256,
      "worker_owner_id_invalid",
    );
    this.#nextLeaseId = config.nextLeaseId;

    this.#retryAfterMs = nonNegativeInteger(
      config.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      "worker_retry_delay_invalid",
    );
    this.#approvalRecheckMs = positiveIntegerAtMost(
      config.approvalRecheckMs ?? DEFAULT_APPROVAL_RECHECK_MS,
      DEFAULT_APPROVAL_TTL_MS,
      "worker_approval_recheck_invalid",
    );
    this.#approvalTtlMs = positiveIntegerAtMost(
      config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      7 * DEFAULT_APPROVAL_TTL_MS,
      "worker_approval_ttl_invalid",
    );
    this.#scanIntervalMs = optionalPositiveInteger(
      config.scanIntervalMs === undefined
        ? DEFAULT_SCAN_INTERVAL_MS
        : config.scanIntervalMs,
      "worker_scan_interval_invalid",
    );
    this.#cancellationPollIntervalMs = positiveInteger(
      config.cancellationPollIntervalMs ??
        DEFAULT_CANCELLATION_POLL_INTERVAL_MS,
      "worker_cancellation_poll_interval_invalid",
    );
    this.#cancellationScheduler =
      config.cancellationScheduler ?? systemRuntimeWorkerScheduler;
    this.#maxContextItems = positiveIntegerAtMost(
      config.maxContextItems ?? DEFAULT_MAX_CONTEXT_ITEMS,
      DEFAULT_MAX_CONTEXT_ITEMS,
      "worker_context_item_limit_invalid",
    );
    if (this.#maxContextItems < 8) {
      throw new Error("worker_context_item_limit_invalid");
    }
    this.#autoCompactAtContextItems =
      config.autoCompactAtContextItems === null
        ? null
        : positiveInteger(
            config.autoCompactAtContextItems ??
              Math.min(
                DEFAULT_AUTO_COMPACT_AT_CONTEXT_ITEMS,
                Math.floor(this.#maxContextItems * 0.75),
              ),
            "worker_auto_compaction_limit_invalid",
          );
    if (
      this.#autoCompactAtContextItems !== null &&
      (this.#autoCompactAtContextItems < 4 ||
        this.#autoCompactAtContextItems >= this.#maxContextItems)
    ) {
      throw new Error("worker_auto_compaction_limit_invalid");
    }
    this.#maxContextBytes = positiveIntegerAtMost(
      config.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES,
      DEFAULT_MAX_CONTEXT_BYTES,
      "worker_context_byte_limit_invalid",
    );
    if (this.#maxContextBytes < MIN_MAX_CONTEXT_BYTES) {
      throw new Error("worker_context_byte_limit_invalid");
    }
    this.#autoCompactAtContextBytes =
      config.autoCompactAtContextBytes === null
        ? null
        : positiveInteger(
            config.autoCompactAtContextBytes ??
              Math.min(
                DEFAULT_AUTO_COMPACT_AT_CONTEXT_BYTES,
                Math.floor(this.#maxContextBytes * 0.75),
              ),
            "worker_auto_compaction_byte_limit_invalid",
          );
    if (
      this.#autoCompactAtContextBytes !== null &&
      (this.#autoCompactAtContextBytes < MIN_AUTO_COMPACT_AT_CONTEXT_BYTES ||
        this.#autoCompactAtContextBytes >= this.#maxContextBytes)
    ) {
      throw new Error("worker_auto_compaction_byte_limit_invalid");
    }
    if (
      this.#governedContextItems.length > this.#maxContextItems - 2 ||
      this.#governedContextBytes >=
        this.#maxContextBytes - utf8ByteLength(CONTEXT_COMPACTION_PROMPT)
    ) {
      throw new Error("worker_governed_context_limit_exceeded");
    }
    this.#modelContextWindowTokens = positiveInteger(
      config.modelContextWindowTokens ?? DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
      "worker_model_context_window_invalid",
    );
    this.#autoCompactAtTokens =
      config.autoCompactAtTokens === null
        ? null
        : positiveInteger(
            config.autoCompactAtTokens ?? DEFAULT_AUTO_COMPACT_AT_TOKENS,
            "worker_auto_compact_token_limit_invalid",
          );
    if (
      this.#autoCompactAtTokens !== null &&
      this.#autoCompactAtTokens >= this.#modelContextWindowTokens
    ) {
      throw new Error("worker_auto_compact_token_limit_invalid");
    }
    this.#executionBudget = executionBudget(config.executionBudget);
    this.#maxToolRounds = positiveIntegerAtMost(
      config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
      MAX_TOOL_ROUNDS,
      "worker_tool_round_limit_invalid",
    );
    this.#afterRunStarted = config.afterRunStarted;
    this.#afterAttemptStarted = config.afterAttemptStarted;
    this.#beforeAssistantSampleCommitted =
      config.beforeAssistantSampleCommitted;
    this.#afterAssistantSampleCommitted = config.afterAssistantSampleCommitted;
    this.#afterProviderResponseCheckpointed =
      config.afterProviderResponseCheckpointed;
    this.#afterToolDispatched = config.afterToolDispatched;
    this.#afterToolProviderResolved = config.afterToolProviderResolved;
    this.#afterToolReceiptCommitted = config.afterToolReceiptCommitted;
    this.#afterGoalToolExecuted = config.afterGoalToolExecuted;
    this.#afterRunPlanToolExecuted = config.afterRunPlanToolExecuted;
  }

  start(): void {
    if (this.#closed || this.#timer !== null) {
      return;
    }
    void this.wake();
    if (this.#scanIntervalMs === null) {
      return;
    }
    this.#timer = setInterval(() => void this.wake(), this.#scanIntervalMs);
    this.#timer.unref?.();
  }

  wake(): Promise<RuntimeWorkerOutcome> {
    if (this.#closed) {
      return Promise.resolve({ kind: "idle" });
    }
    if (this.#drain !== null) {
      return this.#drain;
    }
    const drain = this.#runOnce()
      .then((outcome) => {
        this.#lastOutcome = outcome;
        return outcome;
      })
      .finally(() => {
        if (this.#drain === drain) {
          this.#drain = null;
        }
      });
    this.#drain = drain;
    return drain;
  }

  lastOutcome(): RuntimeWorkerOutcome | null {
    return this.#lastOutcome;
  }

  watcherResourceSnapshot() {
    return this.#queries.snapshot();
  }

  storeAccessSnapshot() {
    return {
      ...this.#storeAccess.snapshot(),
      wakePending: this.#drain !== null,
    };
  }

  preflightSnapshot() {
    return this.#preflight.snapshot();
  }

  toolResultMaintenanceSnapshot() {
    return this.#toolResultMaintenance.snapshot();
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#closed = true;
    // Financial withdrawal is synchronous and its original physical work must join.
    try {
      this.#pluginCreditSettlementClose = this.#pluginCreditSettlement?.close();
    } catch (error) {
      this.#pluginCreditSettlementClose = Promise.reject(error);
    }
    void this.#pluginCreditSettlementClose?.catch(() => {});
    this.#storeAccess.beginClose();
    this.#preflight.close();
    this.#toolResultMaintenance.close();
    for (const controller of this.#executionControllers)
      controller.abort("runtime_worker_closing");
    this.#queries.interruptPending();
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#closeTask = this.#finishClose();
    return this.#closeTask;
  }

  async #finishClose(): Promise<void> {
    try {
      // One join per Worker; late work keeps its owner but loses all Store access.
      const results = await Promise.allSettled([
        Promise.race([this.#drain, this.#storeAccess.whenClosed()]),
        this.#pluginCreditSettlementClose,
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, "runtime_worker_close_failed");
    } finally {
      this.#storeAccess.close();
      this.#queries.close();
    }
  }

  #executionController(): AbortController {
    const controller = new AbortController();
    this.#executionControllers.add(controller);
    if (this.#closed) controller.abort("runtime_worker_closing");
    return controller;
  }

  async #runOnce(): Promise<RuntimeWorkerOutcome> {
    if (this.#queries.pending || !this.#storeAccess.beginWake())
      return { kind: "idle" };
    const scope: { runId: string | null } = { runId: null };
    const resources = new RuntimeResourceScope();
    this.#runtimeResourceScope = resources;
    try {
      return await this.#runWithStoreAccess(scope);
    } catch (error) {
      if (
        this.#storeAccess.failure() !== null ||
        error instanceof RuntimeAuthorityError
      )
        return scope.runId === null
          ? { kind: "idle" }
          : { kind: "leaseLost", runId: scope.runId };
      throw error;
    } finally {
      this.#runtimeResourceScope = null;
      resources.close();
    }
  }

  async #runWithStoreAccess(scope: {
    runId: string | null;
  }): Promise<RuntimeWorkerOutcome> {
    await this.#toolResultMaintenance.poll();
    if (this.#closed) return { kind: "idle" };
    await this.#pluginCreditSettlement?.poll();
    if (this.#closed) return { kind: "idle" };
    const claim = await this.#workItemClaims.claim({
      ownerId: this.#ownerId,
      leaseId: requireBoundedString(
        this.#nextLeaseId(),
        256,
        "worker_lease_id_invalid",
      ),
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (claim === null) {
      return { kind: "idle" };
    }
    scope.runId = claim.workItem.runId;
    if (this.#closed || this.#storeAccess.failure() !== null)
      return { kind: "leaseLost", runId: scope.runId };
    if (this.#workflowScheduler) {
      const controller = this.#executionController();
      try {
        const outcome = await this.#workflowScheduler.executeIfWorkflow(claim, {
          signal: controller.signal,
          leaseDurationMs: this.#leaseDurationMs,
          retryAfterMs: this.#retryAfterMs,
        });
        if (outcome !== null) return outcome;
      } finally {
        this.#executionControllers.delete(controller);
      }
    }
    try {
      return await this.#executeClaim(claim);
    } catch (error) {
      if (isLeaseLoss(error)) {
        return { kind: "leaseLost", runId: claim.workItem.runId };
      }
      if (
        error instanceof RunStoreBusyError ||
        error instanceof StorageAdmissionError ||
        error instanceof AgentRuntimeCapacityError ||
        error instanceof ToolResultCapacityError ||
        error instanceof ToolExecutionPendingError
      ) {
        try {
          const run =
            error instanceof RunStoreBusyError
              ? null
              : await this.#execution.loadRun(claim);
          if (
            run !== null &&
            run.cancelRequested &&
            run.status !== "reconciling"
          ) {
            return await this.#cancel(claim);
          }
          await this.#store.retryWorkItem({
            ...leaseInput(claim),
            retryAfterMs:
              error instanceof RunStoreBusyError
                ? Math.max(this.#retryAfterMs, error.retryAfterMs)
                : error.retryAfterMs,
            reasonCode: error.code,
          });
          return {
            kind: "retried",
            runId: claim.workItem.runId,
            code: error.code,
          };
        } catch (retryError) {
          if (isLeaseLoss(retryError))
            return { kind: "leaseLost", runId: claim.workItem.runId };
          throw retryError;
        }
      }
      if (error instanceof PermanentWorkerError) {
        const run = await this.#execution.loadRun(claim);
        if (run.cancelRequested) {
          return this.#cancel(claim);
        }
        await this.#execution.failRun(
          claim,
          {
            code: error.code,
            retryable: false,
          },
          await this.#currentAttempt(claim),
        );
        return {
          kind: "failed",
          runId: claim.workItem.runId,
          code: error.code,
        };
      }
      const run = await this.#execution.loadRun(claim);
      if (run.status === "reconciling") {
        const code = failureCode(error);
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs: await loadToolReconciliationDelay(
            this.#store,
            run,
            this.#retryAfterMs,
          ),
          reasonCode: code,
        });
        return { kind: "retried", runId: run.runId, code };
      }
      if (run.cancelRequested) {
        return this.#cancel(claim);
      }
      const code = failureCode(error);
      const retryAfterMs =
        error instanceof AgentKernelError ? error.retryAfterMs : undefined;
      try {
        await this.#retry(claim, code, retryAfterMs);
      } catch (retryError) {
        if (isLeaseLoss(retryError)) {
          return { kind: "leaseLost", runId: claim.workItem.runId };
        }
        throw retryError;
      }
      return { kind: "retried", runId: claim.workItem.runId, code };
    }
  }

  async #resolveAgentVersionRuntime(
    run: RunState,
    purpose: "submit" | "observe",
  ): Promise<WorkerAgentRuntime | null> {
    try {
      return await this.#resolveRunAgentRuntime(run, purpose);
    } catch (error) {
      if (error instanceof InstalledPluginRuntimeError)
        throw new PermanentWorkerError(error.code);
      throw error;
    }
  }

  async #resolveRunAgentRuntime(
    run: RunState,
    purpose: "submit" | "observe",
  ): Promise<WorkerAgentRuntime | null> {
    const resources = this.#runtimeResourceScope!;
    const admission = await readInstalledPluginTaskAdmission({
      run,
      admissions: this.#pluginTaskAdmissions,
      scope: resources,
      preflight: this.#preflight,
    });
    if (
      admission !== null &&
      this.#installedPluginRuntimeResolver === undefined
    )
      throw new InstalledPluginRuntimeError(
        "installed_plugin_runtime_owner_unavailable",
      );
    if (this.#agentVersionRuntimeResolver === undefined) {
      if (admission !== null)
        throw new InstalledPluginRuntimeError(
          "installed_plugin_materialization_unavailable",
        );
      return {
        executionAuthority: "crewonKernel",
        kernel: this.#kernel,
        policy: this.#policy,
        toolRuntime: this.#toolRuntime,
        toolDefinitions: this.#toolDefinitions,
        contextCompactor: this.#contextCompactor,
        governedContextItems: this.#governedContextItems,
        governedContextBytes: this.#governedContextBytes,
        autoCompactAtTokens: this.#autoCompactAtTokens,
        modelContextWindowTokens: this.#modelContextWindowTokens,
        maxToolRounds: this.#maxToolRounds,
      };
    }
    const resolver = this.#agentVersionRuntimeResolver;
    const resolved = await acquireRuntimeResource({
      locator: { tenantId: run.tenantId, agentVersionId: run.agentVersionId },
      resolver,
      scope: resources,
      preflight: this.#preflight,
    });
    if (resolved === null) {
      return null;
    }
    if (resolved.version.agentVersionId !== run.agentVersionId) {
      throw new PermanentWorkerError("agent_version_runtime_identity_mismatch");
    }
    const runtime = this.#projectAgentVersionRuntime(resolved);
    if (admission === null) return runtime;
    const toolRuntime = await this.#preflight.run({
      identity: {
        tenantId: run.tenantId,
        kind: "runtime",
        resourceId: JSON.stringify([
          "installed-runtime",
          run.spaceId,
          run.runId,
          purpose,
        ]),
      },
      operation: () =>
        resources.run(async () => {
          const controller = this.#executionController();
          try {
            return await acquireInstalledPluginRunToolRuntime({
              run,
              base: resolved,
              admission,
              resolver: this.#installedPluginRuntimeResolver,
              purpose,
              signal: controller.signal,
              scope: resources,
            });
          } finally {
            // This tracks the physical acquire, even if preflight has already timed out.
            this.#executionControllers.delete(controller);
          }
        }),
    });
    return { ...runtime, toolRuntime };
  }

  #projectAgentVersionRuntime(
    runtime: AgentVersionRuntime,
  ): WorkerAgentRuntime {
    if (
      runtime.executionAuthority === "providerAgent" &&
      (runtime.version.instructions !== null ||
        runtime.version.tools.length !== 0 ||
        runtime.version.resources.governedContextDigest !== null ||
        runtime.version.resources.workspaceRequired ||
        runtime.governedContext !== undefined)
    ) {
      throw new PermanentWorkerError(
        "agent_version_provider_authority_mismatch",
      );
    }
    const governedContextItems = runtime.governedContext?.modelItems() ?? [];
    const governedContextBytes = governedContextItems.reduce(
      (total, item) =>
        total + (item.type === "message" ? utf8ByteLength(item.content) : 0),
      0,
    );
    if (
      governedContextItems.length > this.#maxContextItems - 2 ||
      governedContextBytes >=
        this.#maxContextBytes - utf8ByteLength(CONTEXT_COMPACTION_PROMPT)
    ) {
      throw new PermanentWorkerError("worker_governed_context_limit_exceeded");
    }
    return {
      executionAuthority: runtime.executionAuthority,
      kernel: runtime.kernel,
      policy: runtime.policy,
      toolRuntime: runtime.toolRuntime,
      toolDefinitions: runtime.version.tools,
      contextCompactor: runtime.contextCompactor,
      governedContextItems,
      governedContextBytes,
      autoCompactAtTokens: runtime.version.model.autoCompactAtTokens,
      modelContextWindowTokens: runtime.version.model.contextWindowTokens,
      maxToolRounds: runtime.version.execution.maxToolRounds,
    };
  }

  #executeClaim(claim: WorkItemClaim): Promise<RuntimeWorkerOutcome> {
    return runWithExecutionBudget({
      claim,
      store: this.#store,
      budget: this.#executionBudget,
      shouldYield: () => this.#closed || this.#queries.pending,
      execute: () => this.#executeClaimStep(claim),
    });
  }

  async #executeClaimStep(
    claim: WorkItemClaim,
  ): Promise<RuntimeWorkerStepOutcome> {
    let run = await this.#execution.loadRun(claim);
    if (run.purpose === "workflow") {
      // A root belongs to the workflow scheduler even when canceled/terminal:
      // children may still own unknown effects. Never use ordinary Agent settlement.
      try {
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs: this.#retryAfterMs,
          reasonCode: "workflow_scheduler_unavailable",
        });
      } catch (error) {
        if (isLeaseLoss(error)) return { kind: "leaseLost", runId: run.runId };
        // A failed or unacknowledged queue write must not enter ordinary
        // failure/cancellation settlement. The queue lease remains the recovery fence.
        return {
          kind: "retried",
          runId: run.runId,
          code: "workflow_scheduler_requeue_failed",
        };
      }
      return {
        kind: "retried",
        runId: run.runId,
        code: "workflow_scheduler_unavailable",
      };
    }
    if (isTerminal(run)) {
      await this.#completeWorkItem(claim);
      return terminalOutcome(run);
    }
    if (run.cancelRequested && run.status !== "reconciling") {
      return run.status === "waitingApproval"
        ? this.#cancelWaitingApproval(claim, run)
        : this.#cancel(claim);
    }
    if (run.status === "waitingApproval") {
      const approval = run.waitingApproval;
      if (approval === null) {
        throw new PermanentWorkerError("tool_approval_state_missing");
      }
      const storedApproval = await this.#store.loadToolApproval({
        tenantId: run.tenantId,
        approvalId: approval.approvalId,
      });
      if (storedApproval === null) {
        throw new PermanentWorkerError("tool_approval_state_missing");
      }
      if (
        (await this.#execution.expireToolApproval(claim, storedApproval)) !==
        null
      ) {
        return CONTINUE_RUN;
      }
      if (
        storedApproval.status === "required" &&
        (run.toolPermissionMode === "approveForMe" ||
          run.toolPermissionMode === "fullAccess")
      ) {
        const receipt = await this.#store.loadToolExecutionReceipt({
          tenantId: run.tenantId,
          runId: run.runId,
          receiptId: storedApproval.receiptId,
        });
        if (receipt === null) {
          throw new PermanentWorkerError("tool_receipt_not_found");
        }
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs: 0,
          reasonCode: "tool_approval_auto_decision",
        });
        await this.#execution.approveToolForRun(receipt, storedApproval);
        return {
          kind: "retried",
          runId: run.runId,
          code: "tool_approval_auto_approved",
        };
      }
      const runtime = await this.#resolveAgentVersionRuntime(run, "observe");
      if (runtime !== null) {
        const loaded = await this.#pendingToolEvents(claim, run);
        if (loaded.kind === "deferred") {
          await this.#store.retryWorkItem({
            ...leaseInput(claim),
            retryAfterMs: 0,
            reasonCode: "run_execution_progress_loading",
          });
          return {
            kind: "waitingApproval",
            runId: run.runId,
            approvalId: storedApproval.approvalId,
          };
        }
        const pending = loaded.progress;
        const replacement = await replaceChangedToolApproval({
          execution: this.#execution,
          claim,
          current: storedApproval,
          calls: pending.events,
          toolRuntime: runtime.toolRuntime,
          expiresAfterMs: this.#approvalTtlMs,
          retryAfterMs: this.#approvalRecheckMs,
        });
        if (replacement !== null) {
          return {
            kind: "waitingApproval",
            runId: run.runId,
            approvalId: replacement.approvalId,
          };
        }
      }
      await this.#store.retryWorkItem({
        ...leaseInput(claim),
        retryAfterMs: this.#approvalRecheckMs,
        reasonCode: "tool_approval_required",
      });
      return {
        kind: "waitingApproval",
        runId: run.runId,
        approvalId: approval.approvalId,
      };
    }

    const goalContinuationError = await this.#goalContinuationError(claim, run);
    if (goalContinuationError !== null) {
      await this.#execution.failRun(
        claim,
        { code: goalContinuationError, retryable: false },
        null,
      );
      return {
        kind: "failed",
        runId: run.runId,
        code: goalContinuationError,
      };
    }
    const manualCompaction = manualCompactionRequest(claim, run);

    const runtime = await this.#resolveAgentVersionRuntime(
      run,
      // Running may still contain a dispatched receipt after a crash. Acquisition must allow
      // passive recovery; the trusted ToolRuntime rechecks submit before every new effect.
      run.status === "queued" ? "submit" : "observe",
    );
    if (runtime === null) {
      await this.#store.retryWorkItem({
        ...leaseInput(claim),
        retryAfterMs: this.#retryAfterMs,
        reasonCode: "agent_version_runtime_unavailable",
      });
      return {
        kind: "retried",
        runId: run.runId,
        code: "agent_version_runtime_unavailable",
      };
    }
    await reconcileCommittedToolResults({
      runtime: runtime.toolRuntime,
      store: this.#store,
      tenantId: run.tenantId,
      runId: run.runId,
    });
    if (
      runtime.executionAuthority === "providerAgent" &&
      run.collaborationMode !== "default"
    ) {
      throw new PermanentWorkerError(
        "provider_agent_collaboration_mode_unsupported",
      );
    }
    if (
      runtime.executionAuthority === "providerAgent" &&
      (run.goalBinding !== null || run.goalAccounting !== null)
    ) {
      throw new PermanentWorkerError("provider_agent_goal_unsupported");
    }
    if (run.status === "reconciling") {
      return this.#reconcileToolClaim(claim, run, runtime);
    }

    const resources = this.#runtimeResourceScope!;
    const decision = await this.#preflight.run({
      identity: {
        tenantId: run.tenantId,
        kind: "policy",
        resourceId: run.runId,
      },
      operation: () =>
        resources.run(() =>
          runtime.policy.evaluate({ run, workItem: claim.workItem }),
        ),
    });
    if (decision.outcome !== "allow") {
      const attempt =
        run.status === "running"
          ? attemptIdentity(await this.#execution.beginModelAttempt(claim))
          : null;
      await this.#execution.failRun(
        claim,
        {
          code: "execution_policy_denied",
          retryable: false,
        },
        attempt,
      );
      return {
        kind: "failed",
        runId: run.runId,
        code: "execution_policy_denied",
      };
    }

    if (run.status === "queued") {
      await this.#renew(claim);
      await this.#execution.startRun(claim);
      await this.#afterRunStarted?.();
      run = await this.#execution.loadRun(claim);
    }
    if (run.status !== "running") {
      throw new Error("run_not_executable");
    }

    if (manualCompaction !== null) {
      const context = await this.#loadContext(claim, run, {
        allowAssistantBoundary: true,
      });
      if (
        context.throughHistorySequence !==
        manualCompaction.expectedHistorySequence
      ) {
        throw new PermanentWorkerError("model_history_sequence_conflict");
      }
      return this.#compactContext(claim, run, context, runtime, {
        mode: "manual",
        completion: "completeRun",
        replacesThroughSequence: manualCompaction.expectedHistorySequence,
      });
    }

    const loadedProgress = await this.#pendingToolEvents(claim, run);
    if (loadedProgress.kind === "deferred") {
      const current = await this.#execution.loadRun(claim);
      if (current.cancelRequested) return this.#cancel(claim);
      await this.#store.retryWorkItem({
        ...leaseInput(claim),
        retryAfterMs: 0,
        reasonCode: "run_execution_progress_loading",
      });
      return {
        kind: "retried",
        runId: run.runId,
        code: "run_execution_progress_loading",
      };
    }
    const pendingTools = loadedProgress.progress;
    if (pendingTools.events.length > 0) {
      const renewedClaim = await this.#renewClaim(claim);
      const controller = this.#executionController();
      const heartbeat = new LeaseHeartbeat(
        Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
        () => this.#renew(claim),
        controller,
        this.#queries.confirmation(claim),
      );
      const cancellationWatcher = new CancellationWatcher(
        this.#cancellationPollIntervalMs,
        () =>
          this.#queries.readCancellation(claim, () =>
            this.#execution.loadRun(claim),
          ),
        controller,
        this.#cancellationScheduler,
      );
      heartbeat.start();
      cancellationWatcher.start();
      try {
        const outcome = await this.#executeToolCalls(
          renewedClaim,
          run,
          pendingTools.events,
          pendingTools.lastSegmentSequence,
          controller.signal,
          runtime,
        );
        return outcome ?? CONTINUE_RUN;
      } catch (error) {
        if (cancellationWatcher.failure() !== null)
          throw cancellationWatcher.failure();
        if (heartbeat.failure() !== null) throw heartbeat.failure();
        throw error;
      } finally {
        this.#executionControllers.delete(controller);
        await cancellationWatcher.close();
        await heartbeat.close();
      }
    }
    const completedToolRounds = pendingTools.completedToolRounds;
    const completedAssistantSamples = pendingTools.providerContinuationSamples;
    if (
      pendingTools.emptyProviderContinuationSamples >
      MAX_EMPTY_PROVIDER_CONTINUATIONS
    ) {
      throw new PermanentWorkerError("model_empty_continuation_limit_exceeded");
    }
    if (
      pendingTools.assistantContinuationSamples >
      MAX_ASSISTANT_PROVIDER_CONTINUATIONS
    ) {
      throw new PermanentWorkerError(
        "model_provider_continuation_limit_exceeded",
      );
    }
    if (completedToolRounds >= runtime.maxToolRounds) {
      throw new PermanentWorkerError("model_tool_round_limit_exceeded");
    }
    if ((await this.#execution.consumeGoalSteering(claim)) !== null) {
      run = await this.#execution.loadRun(claim);
    }
    const context = await this.#loadContext(claim, run);
    const priorModelState = await this.#execution.loadThreadModelState(claim);
    const modelSwitch = decideModelSwitchCompaction(
      priorModelState,
      {
        agentVersionId: run.agentVersionId,
        ...runtime.kernel.modelIdentity,
        contextWindowTokens: runtime.modelContextWindowTokens,
        autoCompactAtTokens: runtime.autoCompactAtTokens,
      },
      context,
    );
    if (modelSwitch.required) {
      if (priorModelState === null) {
        throw new PermanentWorkerError("thread_model_state_missing");
      }
      const priorResolver = this.#modelSwitchCompactionResolver;
      const priorRuntime =
        priorResolver === undefined
          ? null
          : await acquirePriorCompactorResource({
              prior: priorModelState,
              resolver: priorResolver,
              scope: this.#runtimeResourceScope!,
              preflight: this.#preflight,
            });
      if (priorRuntime === null || priorRuntime === undefined) {
        throw new PermanentWorkerError("model_switch_compactor_unavailable");
      }
      return this.#compactContext(claim, run, context, runtime, {
        compactor: priorRuntime.compactor,
        executionAuthority: priorRuntime.executionAuthority,
        governedContext: priorRuntime.governedContext,
        agentVersionId: priorModelState.agentVersionId,
        replacesThroughSequence: modelSwitch.replacesThroughSequence,
      });
    }
    const visibleContextItems =
      context.items.length + runtime.governedContextItems.length;
    const visibleContextBytes =
      context.byteLength + runtime.governedContextBytes;
    const shouldCompactByItems =
      this.#autoCompactAtContextItems !== null &&
      visibleContextItems >= this.#autoCompactAtContextItems;
    const shouldCompactByBytes =
      this.#autoCompactAtContextBytes !== null &&
      visibleContextBytes >= this.#autoCompactAtContextBytes;
    const shouldCompactByTokens =
      completedToolRounds > 0 &&
      runtime.autoCompactAtTokens !== null &&
      pendingTools.latestUsageTotalTokens !== null &&
      pendingTools.latestUsageTotalTokens >= runtime.autoCompactAtTokens;
    if (shouldCompactByItems || shouldCompactByBytes || shouldCompactByTokens) {
      return this.#compactContext(claim, run, context, runtime);
    }
    if (
      visibleContextItems > this.#maxContextItems ||
      visibleContextBytes > this.#maxContextBytes
    ) {
      throw new PermanentWorkerError("context_history_limit_exceeded");
    }
    const attemptResult = await this.#execution.beginModelAttempt(
      claim,
      completedToolRounds === 0 && completedAssistantSamples === 0
        ? undefined
        : {
            stepId: `model:${claim.workItem.workItemId}:${completedToolRounds + completedAssistantSamples + 1}`,
          },
    );
    const attempt = attemptIdentity(attemptResult);
    if (
      runtime.executionAuthority === "providerAgent" &&
      attemptResult.attempt.retryOfAttemptId !== null
    ) {
      const code = "provider_agent_recovery_unsupported";
      await this.#execution.failRun(claim, { code, retryable: false }, attempt);
      return { kind: "failed", runId: run.runId, code };
    }
    await this.#afterAttemptStarted?.();

    const modelIdentity = {
      agentVersionId: run.agentVersionId,
      ...runtime.kernel.modelIdentity,
    };
    const recoveryCheckpoint =
      await this.#execution.loadPredecessorProviderCheckpoint(
        claim,
        attemptResult,
        modelIdentity,
      );
    const storedContinuation =
      pendingTools.emptyContinuation === null
        ? await this.#execution.loadThreadContinuation(claim, modelIdentity)
        : await loadEmptyContinuation({
            store: this.#store,
            run,
            event: pendingTools.emptyContinuation,
            identity: modelIdentity,
            onInvalid: (code) => {
              throw new PermanentWorkerError(code);
            },
          });
    const continuation =
      pendingTools.emptyContinuation === null
        ? selectContinuation(context, storedContinuation)
        : selectEmptyContinuation(context, storedContinuation);
    let providerTurnState =
      await this.#execution.loadRunProviderTurnState(claim);
    const segmentId = `segment:${attempt.attemptId}`;
    await this.#renew(claim);
    const controller = this.#executionController();
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
      this.#queries.confirmation(claim),
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () =>
        this.#queries.readCancellation(claim, () =>
          this.#execution.loadRun(claim),
        ),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    let output = "";
    let completed = false;
    let providerCheckpoint: ProviderCheckpoint | null = null;
    let checkpointSequence: number | null = null;
    let completedSequence: number | null = null;
    let latestUsage:
      | Extract<KernelAgentEvent, { type: "usage.recorded" }>["data"]
      | null = null;
    let lastAgentSequence = 0;
    let checkpointEvent: Extract<
      KernelAgentEvent,
      { type: "segment.checkpointed" }
    > | null = null;
    const requestedTools: Extract<
      KernelAgentEvent,
      { type: "tool.requested" }
    >[] = [];
    let toolBoundaryCompleted = false;
    let toolBoundaryOutcome: RuntimeWorkerOutcome | null = null;
    const bufferedEvents: Exclude<
      KernelAgentEvent,
      { type: "segment.continuation_requested" }
    >[] = [];
    let assistantContinuation: Extract<
      KernelAgentEvent,
      { type: "segment.continuation_requested" }
    > | null = null;
    try {
      this.#queries.confirmedClaim(claim);
      for await (const batch of batchModelOutputEvents(
        runtime.kernel.runSegment(
          {
            schemaVersion: "crewon.agent-segment.v0",
            purpose: "agent",
            runId: run.runId,
            segmentId,
            attempt: attemptResult.attempt.attemptNumber,
            agentVersionId: run.agentVersionId,
            policySnapshotId: run.policySnapshotId,
            collaborationMode: run.collaborationMode,
            allowedTools:
              run.collaborationMode === "plan"
                ? planAllowedTools(runtime)
                : null,
            runtimeTools:
              runtime.executionAuthority === "providerAgent"
                ? []
                : [...goalToolsForRun(run), ...runPlanToolsForRun(run)],
            history: [...runtime.governedContextItems, ...context.items],
            continuation:
              continuation.kind === "providerCheckpoint"
                ? {
                    ...continuation,
                    newHistoryStartIndex:
                      runtime.governedContextItems.length +
                      continuation.newHistoryStartIndex,
                  }
                : continuation,
            ...(recoveryCheckpoint === null
              ? {}
              : {
                  reconcileCheckpoint: recoveryCheckpoint,
                }),
            ...(providerTurnState === null ? {} : { providerTurnState }),
            budget: { maxOutputBytes: 32 * 1024 },
          },
          controller.signal,
          {
            emptyResponseContinuation: "durableBoundary",
            controlSink: {
              providerTurnStateObserved: async (observedProviderTurnState) => {
                await this.#execution.recordProviderTurnState(
                  claim,
                  attempt,
                  observedProviderTurnState,
                );
                providerTurnState = observedProviderTurnState;
              },
            },
            usageSink: durableModelUsageSink(this.#store, claim, attempt),
            callSink: durableModelCallSink(this.#store, claim, attempt),
          },
        ),
      )) {
        await this.#renew(claim);
        run = await this.#execution.loadRun(claim);
        if (run.cancelRequested) {
          controller.abort("user_requested");
          // Close the iterator and its accounting before settling the attempt.
          break;
        }
        if (batch.kind === "output") {
          const persisted = await this.#execution.recordOutputEvents(
            claim,
            batch.events,
          );
          run = persisted.state;
          for (const event of batch.events) output += event.data.delta;
          lastAgentSequence = batch.events.at(-1)!.sequence;
          continue;
        }
        const event = batch.event;
        lastAgentSequence = event.sequence;
        if (event.type === "segment.provider_response_created") {
          providerCheckpoint = event.data.checkpoint;
          await this.#execution.checkpointModelAttempt(
            claim,
            attempt,
            event.data.checkpoint,
          );
          await this.#afterProviderResponseCheckpointed?.();
          continue;
        }
        if (event.type === "segment.checkpointed") {
          if (checkpointSequence !== null) {
            throw new AgentKernelError("segment_checkpoint_duplicate", false);
          }
          providerCheckpoint = event.data.checkpoint;
          checkpointSequence = event.sequence;
          checkpointEvent = event;
          continue;
        }
        if (event.type === "segment.completed") {
          if (event.data.output !== output) {
            throw new AgentKernelError("segment_output_mismatch", false);
          }
          completed = true;
          providerTurnState = event.data.providerTurnState ?? providerTurnState;
          completedSequence = event.sequence;
          continue;
        }
        if (event.type === "segment.continuation_requested") {
          providerTurnState = event.data.providerTurnState ?? providerTurnState;
          assistantContinuation = event;
          continue;
        }
        if (
          event.type === "segment.started" ||
          event.type === "rate_limit.updated"
        ) {
          const persisted = await recordWorkerAgentEvent(
            this.#execution,
            claim,
            event,
          );
          run = persisted.state;
          continue;
        }
        if (
          event.type === "model.sampling.retry" ||
          event.type === "model.transport.fallback"
        ) {
          const persisted = await recordWorkerAgentEvent(
            this.#execution,
            claim,
            event,
          );
          run = persisted.state;
        } else {
          bufferedEvents.push(event);
        }
        if (event.type === "tool.requested") {
          providerTurnState = event.data.providerTurnState ?? providerTurnState;
          requestedTools.push(event);
        }
        if (
          (event.type === "model.sampling.retry" ||
            event.type === "model.transport.fallback") &&
          event.data.discardedOutput
        ) {
          output = "";
        } else if (event.type === "usage.recorded") {
          latestUsage = event.data;
        } else if (event.type === "segment.failed") {
          break;
        }
      }
      if (run.cancelRequested) return this.#cancel(claim, attempt);
      const atomicToolSample =
        assistantContinuation === null &&
        !completed &&
        requestedTools.length > 0 &&
        checkpointEvent !== null &&
        bufferedEvents.length <= 254 &&
        !bufferedEvents.some((event) => event.type === "segment.failed") &&
        this.#execution.supportsToolSampleCommit();
      if (assistantContinuation !== null) {
        if (
          assistantContinuation.data.completedAssistantItems.join("") !==
          assistantContinuation.data.output
        ) {
          throw new AgentKernelError("segment_output_mismatch", false);
        }
        await this.#beforeAssistantSampleCommitted?.();
        await this.#execution.commitAssistantSampleContinuation(
          claim,
          attempt,
          {
            sampleIndex: completedAssistantSamples + 1,
            segmentId,
            continuationSequence: assistantContinuation.sequence,
            output: assistantContinuation.data.output,
            completedAssistantItems:
              assistantContinuation.data.completedAssistantItems,
            events: bufferedEvents,
            identity: modelIdentity,
            contextRevision: context.revision,
            modelPolicy: {
              contextWindowTokens: runtime.modelContextWindowTokens,
              autoCompactAtTokens: runtime.autoCompactAtTokens,
            },
            latestUsage,
            checkpoint: assistantContinuation.data.checkpoint,
            providerTurnState,
          },
        );
        await this.#afterAssistantSampleCommitted?.();
        if (requestedTools.length > 0) {
          toolBoundaryOutcome = await this.#executeToolCalls(
            claim,
            run,
            requestedTools,
            lastAgentSequence,
            controller.signal,
            runtime,
          );
          toolBoundaryCompleted = toolBoundaryOutcome === null;
        } else {
          toolBoundaryCompleted = true;
        }
      } else if (!atomicToolSample) {
        for (const event of bufferedEvents) {
          const persisted = await recordWorkerAgentEvent(
            this.#execution,
            claim,
            event,
          );
          run = persisted.state;
          if (event.type !== "segment.failed") continue;
          if (event.data.retryable) {
            await this.#retry(claim, event.data.code);
            return { kind: "retried", runId: run.runId, code: event.data.code };
          }
          await this.#execution.failRun(claim, event.data, attempt);
          return { kind: "failed", runId: run.runId, code: event.data.code };
        }
      }
      if (
        assistantContinuation === null &&
        !completed &&
        requestedTools.length > 0
      ) {
        const completedAssistantOutput = requestedTools
          .flatMap((event) => event.data.completedAssistantItems ?? [])
          .join("");
        if (output.length > 0 && completedAssistantOutput !== output) {
          throw new AgentKernelError(
            "model_tool_call_with_text_unsupported",
            false,
          );
        }
        lastAgentSequence += 1;
        const toolSampleCompleted: CanonicalAgentEvent = {
          schemaVersion: "crewon.agent-event.v0",
          runId: run.runId,
          segmentId,
          sequence: lastAgentSequence,
          type: "segment.completed",
          data: { output: "" },
        };
        if (atomicToolSample && checkpointEvent !== null) {
          await this.#execution.commitToolSample(claim, attempt, {
            segmentId,
            events: [...bufferedEvents, checkpointEvent, toolSampleCompleted],
            identity: modelIdentity,
            contextRevision: context.revision,
            modelPolicy: {
              contextWindowTokens: runtime.modelContextWindowTokens,
              autoCompactAtTokens: runtime.autoCompactAtTokens,
            },
            latestUsage,
            checkpoint: checkpointEvent.data.checkpoint,
            providerTurnState,
          });
        } else {
          if (checkpointEvent !== null) {
            await this.#execution.recordAgentEvent(claim, checkpointEvent);
          }
          await this.#execution.recordAgentEvent(claim, toolSampleCompleted);
          await this.#execution.completeAttempt(claim, attempt, null, {
            providerTurnState,
          });
        }
        toolBoundaryOutcome = await this.#executeToolCalls(
          claim,
          run,
          requestedTools,
          lastAgentSequence,
          controller.signal,
          runtime,
        );
        toolBoundaryCompleted = toolBoundaryOutcome === null;
      }
    } catch (error) {
      if (cancellationWatcher.failure() !== null) {
        throw cancellationWatcher.failure();
      }
      if (heartbeat.failure() !== null) {
        throw heartbeat.failure();
      }
      if (isLeaseLoss(error)) throw error;
      if (
        error instanceof RunStoreBusyError ||
        error instanceof StorageAdmissionError ||
        error instanceof ToolResultCapacityError ||
        error instanceof ToolExecutionPendingError
      )
        throw error;
      if (error instanceof AgentKernelError && !error.retryable) {
        run = await this.#execution.loadRun(claim);
        if (!(await this.#attemptIsRunning(run, attempt))) {
          throw error;
        }
        if (run.cancelRequested) {
          return this.#cancel(claim, attempt);
        }
        const failedEvent: CanonicalAgentEvent = {
          schemaVersion: "crewon.agent-event.v0",
          runId: run.runId,
          segmentId,
          sequence: lastAgentSequence + 1,
          type: "segment.failed",
          data: { code: error.code, retryable: false },
        };
        await this.#execution.recordAgentEvent(claim, failedEvent);
        await this.#execution.failRun(
          claim,
          {
            code: error.code,
            retryable: false,
          },
          attempt,
        );
        return { kind: "failed", runId: run.runId, code: error.code };
      }
      run = await this.#execution.loadRun(claim);
      if (!(await this.#attemptIsRunning(run, attempt))) {
        throw error;
      }
      return this.#retryActiveAttempt(
        claim,
        attempt,
        error,
        providerCheckpoint,
      );
    } finally {
      this.#executionControllers.delete(controller);
      await cancellationWatcher.close();
      await heartbeat.close();
    }
    if (cancellationWatcher.failure() !== null) {
      throw cancellationWatcher.failure();
    }
    if (heartbeat.failure() !== null) {
      throw heartbeat.failure();
    }
    if (toolBoundaryOutcome !== null) {
      return toolBoundaryOutcome;
    }
    if (toolBoundaryCompleted) {
      return CONTINUE_RUN;
    }
    if (!completed || completedSequence === null) {
      throw new PermanentWorkerError("segment_completion_missing");
    }

    let completionOutput = output;
    let proposedPlan: string | null = null;
    if (run.collaborationMode === "plan") {
      try {
        completionOutput = parseProposedPlan(output);
        proposedPlan = completionOutput;
      } catch (error) {
        if (!(error instanceof PlanOutputError)) throw error;
        await this.#execution.failRun(
          claim,
          { code: error.code, retryable: false },
          attempt,
        );
        return { kind: "failed", runId: run.runId, code: error.code };
      }
    }

    await this.#renew(claim);
    try {
      const completion = await this.#execution.completeTextRun(
        claim,
        attempt,
        completionOutput,
        {
          identity: modelIdentity,
          contextRevision: context.revision,
          checkpoint: providerCheckpoint,
          providerTurnState,
          segment: {
            segmentId,
            checkpointSequence,
            completedSequence,
          },
          modelPolicy: {
            contextWindowTokens: runtime.modelContextWindowTokens,
            autoCompactAtTokens: runtime.autoCompactAtTokens,
          },
          latestUsage,
          proposedPlan,
        },
      );
      return { kind: "completed", runId: completion.runState.runId };
    } catch (error) {
      if (isExecutionCancelPending(error)) {
        return this.#cancel(claim, attempt);
      }
      return this.#retryActiveAttempt(
        claim,
        attempt,
        error,
        providerCheckpoint,
      );
    }
  }

  async #goalContinuationError(
    claim: WorkItemClaim,
    run: RunState,
  ): Promise<string | null> {
    const payload = claim.workItem.payload;
    if (payload.trigger === undefined) return null;
    if (payload.trigger === "manualCompaction") return null;
    if (payload.trigger === "automationInvocation") {
      try {
        const binding = parseAutomationInvocationBinding(payload.binding);
        const origin = run.origin;
        if (
          payload.schemaVersion !==
            "crewon.automation-invocation-work-item.v0" ||
          payload.throughSequence !== 1 ||
          Object.keys(payload).sort().join(",") !==
            "binding,schemaVersion,throughSequence,trigger" ||
          run.purpose !== "turn" ||
          origin === null ||
          origin === undefined ||
          !sameAutomationInvocationBinding(binding, origin.binding) ||
          binding.routeDigest !== automationRunRouteDigest(run)
        ) {
          return "automation_invocation_payload_invalid";
        }
      } catch {
        return "automation_invocation_payload_invalid";
      }
      return null;
    }
    if (
      payload.trigger !== "goalContinuation" &&
      payload.trigger !== "goalActivation"
    ) {
      return "goal_continuation_payload_invalid";
    }
    if (run.status !== "queued") {
      return null;
    }
    const binding = run.goalBinding;
    const goal = await this.#store.loadThreadGoal({
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    if (
      binding === null ||
      goal?.status !== "active" ||
      (payload.trigger === "goalContinuation" &&
        payload.previousRunId === run.runId) ||
      payload.goalId !== binding.goalId ||
      payload.goalRevision !== binding.revision ||
      goal.goalId !== binding.goalId ||
      goal.revision !== binding.revision ||
      `sha256:${createHash("sha256").update(goal.objective).digest("hex")}` !==
        binding.objectiveDigest
    ) {
      return "goal_continuation_stale";
    }
    return null;
  }

  async #compactContext(
    claim: WorkItemClaim,
    run: RunState,
    context: ModelContextProjection,
    runtime: WorkerAgentRuntime,
    options?: Readonly<{
      compactor?: ContextCompactorPort;
      executionAuthority?: AgentExecutionAuthority;
      governedContext?: GovernedContextBundle;
      agentVersionId?: string;
      replacesThroughSequence: number;
      mode?: "auto" | "manual";
      completion?: "continueRun" | "completeRun";
    }>,
  ): Promise<RuntimeWorkerStepOutcome> {
    const compactorAuthority =
      options?.compactor === undefined
        ? runtime.executionAuthority
        : options.executionAuthority;
    if (compactorAuthority !== "crewonKernel") {
      throw new PermanentWorkerError(
        "provider_agent_context_compaction_unsupported",
      );
    }
    const replacesThroughSequence =
      options?.replacesThroughSequence ?? context.throughHistorySequence;
    const governedContextItems =
      options?.governedContext?.modelItems() ?? runtime.governedContextItems;
    const governedContextBytes = governedContextItems.reduce(
      (total, item) =>
        total + (item.type === "message" ? utf8ByteLength(item.content) : 0),
      0,
    );
    if (
      governedContextItems.length > this.#maxContextItems - 2 ||
      governedContextBytes >=
        this.#maxContextBytes - utf8ByteLength(CONTEXT_COMPACTION_PROMPT)
    ) {
      throw new PermanentWorkerError("worker_governed_context_limit_exceeded");
    }
    const sourceItems = context.items.filter(
      (_item, index) =>
        context.sourceSequences[index]! <= replacesThroughSequence,
    );
    const attemptResult = await this.#execution.beginContextCompaction(
      claim,
      replacesThroughSequence,
    );
    const attempt = attemptIdentity(attemptResult);
    const segmentId = `segment:${attempt.attemptId}`;
    await this.#renew(claim);
    const controller = this.#executionController();
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
      this.#queries.confirmation(claim),
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () =>
        this.#queries.readCancellation(claim, () =>
          this.#execution.loadRun(claim),
        ),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    let committed = false;
    try {
      this.#queries.confirmedClaim(claim);
      const result = await (
        options?.compactor ?? runtime.contextCompactor
      ).compact(
        {
          runId: run.runId,
          segmentId,
          attempt: attemptResult.attempt.attemptNumber,
          agentVersionId: options?.agentVersionId ?? run.agentVersionId,
          policySnapshotId: run.policySnapshotId,
          history: [...governedContextItems, ...sourceItems],
          protectedPrefixLength: governedContextItems.length,
          inputLimits: {
            maxItems: this.#maxContextItems,
            maxBytes: this.#maxContextBytes,
          },
          maxOutputBytes: 32 * 1024,
        },
        controller.signal,
        {
          checkpoint: durableCompactionCheckpoint(
            this.#store.compactionCheckpoints,
            claim,
            attempt,
          ),
          usageSink: durableModelUsageSink(this.#store, claim, attempt),
          callSink: durableModelCallSink(this.#store, claim, attempt),
        },
      );
      await this.#renew(claim);
      run = await this.#execution.loadRun(claim);
      if (run.cancelRequested) {
        return this.#cancel(claim, attempt);
      }
      await this.#execution.commitContextCompaction(claim, attempt, {
        mode: options?.mode ?? "auto",
        completion: options?.completion ?? "continueRun",
        expectedHistorySequence: context.throughHistorySequence,
        replacesThroughSequence,
        retainedUserMessageLimit: Math.max(
          1,
          Math.min(128, Math.floor((this.#autoCompactAtContextItems ?? 4) / 2)),
        ),
        segmentId,
        summary: result.summary,
        usage: result.usage,
      });
      committed = true;
    } catch (error) {
      if (cancellationWatcher.failure() !== null) {
        throw cancellationWatcher.failure();
      }
      if (heartbeat.failure() !== null) {
        throw heartbeat.failure();
      }
      if (isLeaseLoss(error)) throw error;
      run = await this.#execution.loadRun(claim);
      if (!(await this.#attemptIsRunning(run, attempt))) {
        throw error;
      }
      if (run.cancelRequested) {
        return this.#cancel(claim, attempt);
      }
      if (error instanceof AgentKernelError && !error.retryable) {
        const code = safeCode(error.code);
        await this.#execution.failRun(
          claim,
          { code, retryable: false },
          attempt,
        );
        return { kind: "failed", runId: run.runId, code };
      }
      return this.#retryActiveAttempt(claim, attempt, error, null);
    } finally {
      this.#executionControllers.delete(controller);
      await cancellationWatcher.close();
      await heartbeat.close();
    }
    if (!committed) {
      throw new PermanentWorkerError("context_compaction_not_committed");
    }
    if (options?.completion === "completeRun") {
      run = await this.#execution.loadRun(claim);
      if (run.status !== "completed" || run.outputRef !== null) {
        throw new PermanentWorkerError("manual_compaction_terminal_invalid");
      }
      return { kind: "completed", runId: run.runId };
    }
    return CONTINUE_RUN;
  }

  async #reconcileToolClaim(
    claim: WorkItemClaim,
    run: RunState,
    runtime: WorkerAgentRuntime,
  ): Promise<RuntimeWorkerStepOutcome> {
    const receiptId = run.reconciliationReceiptId;
    if (receiptId === null) {
      throw new PermanentWorkerError("reconciliation_receipt_missing");
    }
    let receipt = await this.#store.loadToolExecutionReceipt({
      tenantId: run.tenantId,
      runId: run.runId,
      receiptId,
    });
    if (receipt === null) {
      throw new PermanentWorkerError("reconciliation_receipt_not_found");
    }
    const request = await this.#loadToolRequest(run, receipt.call.callId);
    this.#execution.validateToolExecutionInput(
      receipt,
      request.event.data.input,
    );
    const recovery = await this.#execution.beginToolReconciliation(
      claim,
      receipt,
    );
    const attempt = attemptIdentity(recovery);
    const renewedClaim = await this.#renewClaim(claim);
    const controller = this.#executionController();
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
      this.#queries.confirmation(claim),
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () =>
        this.#queries.readCancellation(claim, () =>
          this.#execution.loadRun(claim),
        ),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    if (!run.cancelRequested) cancellationWatcher.start();
    try {
      const approval = await this.#approvedToolApproval(receipt);
      let resolution: ToolExecutionResolution;
      if (receipt.status === "completed") {
        resolution = completedResolution(receipt);
      } else if (receipt.status === "canceled") {
        resolution = {
          status: "canceled",
          executionId: receipt.executionId,
          providerReceiptId: receipt.providerReceiptId,
        };
      } else {
        const command = toolExecutionCommand(
          receipt,
          request.event.data.input,
          approval,
          this.#queries.confirmedClaim(renewedClaim),
        );
        const method = run.cancelRequested ? "cancel" : "reconcile";
        resolution = await withWorkerToolDispatch(
          {
            command,
            receipt,
            method,
            signal: controller.signal,
            assertCurrent: () => this.#queries.confirmedClaim(claim),
          },
          () => runtime.toolRuntime[method](command, controller.signal),
        );
      }
      this.#queries.confirmedClaim(claim);
      if (resolution.status === "unknownOutcome") {
        if (receipt.status === "dispatched") {
          receipt = await this.#execution.markToolExecutionUnknown(
            claim,
            receipt,
            resolution.providerReceiptId,
          );
        }
        await this.#execution.retryToolReconciliation(
          claim,
          attempt,
          toolReconciliationDelay(
            this.#retryAfterMs,
            recovery.attempt.attemptNumber,
          ),
        );
        try {
          acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        } catch {
          // The transaction already released this lease. Repair the ACK on the next claim.
          return {
            kind: "retried",
            runId: run.runId,
            code: "tool_result_acknowledgement_pending",
          };
        }
        return {
          kind: "retried",
          runId: run.runId,
          code: "tool_outcome_unknown",
        };
      }
      if (resolution.status === "canceled") {
        if (receipt.status !== "canceled") {
          receipt = await this.#execution.cancelToolExecutionReceipt(
            claim,
            receipt,
            resolution.providerReceiptId,
          );
        }
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        await this.#execution.resumeToolReconciliation(claim, receipt);
        const resumed = await this.#execution.loadRun(claim);
        if (resumed.cancelRequested) {
          return this.#cancel(claim, attempt);
        }
        await this.#execution.failRun(
          claim,
          { code: "tool_execution_canceled", retryable: false },
          attempt,
        );
        return {
          kind: "failed",
          runId: run.runId,
          code: "tool_execution_canceled",
        };
      }

      if ((await this.#execution.loadRun(claim)).cancelRequested) {
        if (receipt.status !== "completed") {
          receipt =
            await this.#execution.completeToolExecutionAfterCancellation(
              claim,
              receipt,
              resolution.providerReceiptId,
              resolution.result,
            );
        }
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        await this.#execution.resumeToolReconciliation(claim, receipt);
        return this.#cancel(claim, attempt);
      }
      const projected = await this.#projectToolOutput(
        run,
        receipt,
        resolution.result,
      );
      const completedEvent = {
        schemaVersion: "crewon.agent-event.v0" as const,
        runId: run.runId,
        segmentId: request.event.data.segmentId,
        sequence: request.lastSegmentSequence + 1,
        type: "tool.completed" as const,
        data: {
          callId: request.event.data.callId,
          kind: request.event.data.kind,
          name: request.event.data.name,
          output: projected.output,
          isError: resolution.result.isError,
          artifactRef: projected.artifactRef,
          outputTruncated: projected.truncated,
          ...(resolution.result.workspaceChanges === undefined
            ? {}
            : { workspaceChanges: resolution.result.workspaceChanges }),
        },
      };
      if (receipt.status !== "completed") {
        const completion = await this.#execution.commitToolExecutionCompletion(
          claim,
          receipt,
          attempt,
          completedEvent,
          resolution.providerReceiptId,
        );
        receipt = completion.receipt;
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        if (completion.run.state.cancelRequested) {
          return this.#cancel(claim);
        }
      } else {
        await this.#execution.resumeToolReconciliation(claim, receipt);
        const resumed = await this.#execution.loadRun(claim);
        await this.#execution.recordAgentEvent(claim, completedEvent);
        await this.#execution.completeAttempt(claim, attempt);
        if (resumed.cancelRequested) {
          return this.#cancel(claim);
        }
      }
      return CONTINUE_RUN;
    } catch (error) {
      if (cancellationWatcher.failure() !== null)
        throw cancellationWatcher.failure();
      if (heartbeat.failure() !== null) throw heartbeat.failure();
      throw error;
    } finally {
      this.#executionControllers.delete(controller);
      await cancellationWatcher.close();
      await heartbeat.close();
    }
  }

  async #loadToolRequest(
    run: RunState,
    callId: string,
  ): Promise<
    Readonly<{
      event: Extract<RunLifecycleEvent, { type: "tool.requested" }>;
      lastSegmentSequence: number;
    }>
  > {
    let cursor = 0;
    let requested: Extract<
      RunLifecycleEvent,
      { type: "tool.requested" }
    > | null = null;
    let lastSegmentSequence = 0;
    while (cursor < run.lastSequence) {
      const page = await this.#store.listRunEvents(
        { tenantId: run.tenantId, runId: run.runId },
        cursor,
        Math.min(HISTORY_PAGE_SIZE, run.lastSequence - cursor),
      );
      if (page.length === 0) {
        throw new PermanentWorkerError("run_event_history_incomplete");
      }
      for (const event of page) {
        cursor = event.sequence;
        if (
          "segmentId" in event.data &&
          event.data.segmentId === requested?.data.segmentId &&
          "segmentSequence" in event.data
        ) {
          lastSegmentSequence = Math.max(
            lastSegmentSequence,
            event.data.segmentSequence,
          );
        }
        if (event.type === "tool.requested" && event.data.callId === callId) {
          requested = event;
          lastSegmentSequence = event.data.segmentSequence;
        }
      }
    }
    if (requested === null) {
      throw new PermanentWorkerError("tool_request_not_found");
    }
    return { event: requested, lastSegmentSequence };
  }

  async #approvedToolApproval(
    receipt: ToolExecutionReceiptState,
  ): Promise<ToolApprovalState | null> {
    const intent = receipt.actionIntent;
    if (intent === null) {
      throw new PermanentWorkerError("tool_action_intent_missing");
    }
    if (intent.approvalRequirement === "none") {
      return null;
    }
    const approval = await this.#store.loadToolApprovalByAction({
      tenantId: receipt.tenantId,
      runId: receipt.runId,
      actionDigest: receipt.actionDigest,
    });
    if (
      approval?.status !== "approved" ||
      approval.receiptId !== receipt.receiptId ||
      approval.policySnapshotId !== intent.policySnapshotId ||
      approval.decision === null
    ) {
      throw new PermanentWorkerError("tool_approval_proof_invalid");
    }
    return approval;
  }

  async #pendingToolEvents(claim: WorkItemClaim, run: RunState) {
    return loadRuntimeRunProgress({
      store: this.#store,
      claim,
      run,
      ...this.#runProgressControl(claim, "execute"),
      onInvalid: (code) => {
        throw new PermanentWorkerError(code);
      },
    });
  }

  #runProgressControl(
    claim: WorkItemClaim,
    purpose: "execute" | "cancel",
  ): import("@crewon/application").RunProgressLoadControl {
    let lastLeaseCheck = -Infinity;
    return {
      query: (key, operation) =>
        this.#queries.executionProgress(claim, key, operation),
      onProgress: async () => {
        await yieldToEventLoop();
        if (this.#closed)
          throw new RuntimeAuthorityError("runtime_worker_closing");
        const now = performance.now();
        if (now - lastLeaseCheck < Math.min(1000, this.#leaseDurationMs / 3))
          return;
        await this.#renew(claim);
        const current = await this.#queries.readCancellation(claim, () =>
          this.#execution.loadRun(claim),
        );
        if (purpose === "execute" && current.cancelRequested)
          throw new PermanentWorkerError("worker_cancel_requested");
        if (purpose === "cancel" && !current.cancelRequested)
          throw new PermanentWorkerError("cancel_not_requested");
        lastLeaseCheck = performance.now();
      },
    };
  }

  async #executeToolCalls(
    claim: WorkItemClaim,
    run: RunState,
    calls: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[],
    startingSequence: number,
    signal: AbortSignal,
    runtime: WorkerAgentRuntime,
  ): Promise<RuntimeWorkerOutcome | null> {
    this.#queries.confirmedClaim(claim);
    const serverOwnedDefinitions = [
      ...goalToolsForRun(run),
      ...runPlanToolsForRun(run),
    ];
    const serverOwnedCalls = calls.filter((event) =>
      serverOwnedDefinitions.some(
        (definition) =>
          definition.kind === event.data.kind &&
          definition.name === event.data.name,
      ),
    );
    if (serverOwnedCalls.length > 0) {
      if (
        serverOwnedCalls.some((event) =>
          runtime.toolDefinitions.some(
            (definition) =>
              definition.kind === event.data.kind &&
              definition.name === event.data.name,
          ),
        )
      ) {
        throw new PermanentWorkerError("runtime_tool_identity_conflict");
      }
      if (serverOwnedCalls.length !== calls.length) {
        throw new PermanentWorkerError(
          "server_owned_tool_mixed_batch_unsupported",
        );
      }
      return this.#executeServerOwnedToolCalls(
        claim,
        serverOwnedCalls,
        startingSequence,
      );
    }
    let sequence = startingSequence;
    const definitions = runtime.toolDefinitions;
    const preparedCalls: Array<{
      event: Extract<KernelAgentEvent, { type: "tool.requested" }>;
      receipt: ToolExecutionReceiptState;
      attempt: RunAttemptIdentity | null;
      preflight?: () => void;
      resolve: () => Promise<ToolExecutionResolution>;
    }> = [];
    for (const event of calls) {
      const call = event.data;
      const defined = definitions.some(
        (definition) =>
          definition.kind === call.kind && definition.name === call.name,
      );
      const configuredPolicy = runtime.toolRuntime.executionPolicy(
        call.kind,
        call.name,
        {
          sandboxMode:
            run.toolPermissionMode === "fullAccess"
              ? "danger-full-access"
              : "workspace-write",
        },
      );
      if (defined && configuredPolicy === null) {
        throw new PermanentWorkerError("tool_execution_policy_missing");
      }
      const policy = configuredPolicy ?? UNSUPPORTED_TOOL_POLICY;
      if (run.collaborationMode === "plan" && policy.effect !== "readOnly") {
        throw new PermanentWorkerError("plan_mutation_forbidden");
      }
      const prepared = await this.#execution.beginToolExecution(
        claim,
        {
          segmentId: event.segmentId,
          callId: call.callId,
          kind: call.kind,
          name: call.name,
          input: call.input,
        },
        policy,
      );
      const getToolAttempt = async () =>
        attemptIdentity(
          prepared.attempt ??
            (await this.#execution.beginToolRecovery(claim, prepared.receipt)),
        );
      let receipt = prepared.receipt;
      let toolApproval: ToolApprovalState | null = null;
      if (policy.approvalRequirement === "perAction") {
        const approval = await this.#execution.requireToolApproval(
          claim,
          receipt,
          {
            expiresAfterMs: this.#approvalTtlMs,
            retryAfterMs: this.#approvalRecheckMs,
          },
        );
        if (approval.approval.status === "required") {
          if (
            run.toolPermissionMode === "approveForMe" ||
            run.toolPermissionMode === "fullAccess"
          ) {
            await this.#execution.approveToolForRun(receipt, approval.approval);
            return {
              kind: "retried",
              runId: receipt.runId,
              code: "tool_approval_auto_approved",
            };
          }
          return {
            kind: "waitingApproval",
            runId: receipt.runId,
            approvalId: approval.approval.approvalId,
          };
        }
        if (approval.approval.status !== "approved") {
          const code = `tool_approval_${approval.approval.status}`;
          await this.#execution.failRun(
            claim,
            { code, retryable: false },
            await getToolAttempt(),
          );
          return { kind: "failed", runId: receipt.runId, code };
        }
        toolApproval = approval.approval;
      }
      if (receipt.status === "completed") {
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        const preparedCall: (typeof preparedCalls)[number] = {
          event,
          receipt,
          attempt: null,
          resolve: async () => {
            preparedCall.attempt = await getToolAttempt();
            return completedResolution(receipt);
          },
        };
        preparedCalls.push(preparedCall);
        continue;
      }
      if (receipt.status === "canceled") {
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        const preparedCall: (typeof preparedCalls)[number] = {
          event,
          receipt,
          attempt: null,
          resolve: async () => {
            preparedCall.attempt = await getToolAttempt();
            return {
              status: "canceled" as const,
              executionId: receipt.executionId,
              providerReceiptId: receipt.providerReceiptId,
            };
          },
        };
        preparedCalls.push(preparedCall);
        continue;
      }
      const shouldExecute = receipt.status === "prepared";
      let capturedCapacity:
        | Parameters<typeof withToolExecutionCapacity>[0]
        | undefined;
      const capacityInput = () =>
        (capturedCapacity ??= {
          tenantId: claim.workItem.tenantId,
          runtime: runtime.toolRuntime,
          command: toolExecutionCommand(
            receipt,
            call.input,
            toolApproval,
            this.#queries.confirmedClaim(claim),
          ),
          signal,
          operation: shouldExecute
            ? ("execute" as const)
            : ("reconcile" as const),
        });
      const preparedCall: (typeof preparedCalls)[number] = {
        event,
        receipt,
        attempt:
          prepared.attempt === null ? null : attemptIdentity(prepared.attempt),
        preflight: () => {
          if (!shouldExecute) preflightToolExecutionCapacity(capacityInput());
        },
        resolve: () =>
          withToolExecutionCapacity(capacityInput(), async (execute) => {
            preparedCall.attempt ??= await getToolAttempt();
            if (shouldExecute) {
              receipt = await this.#execution.dispatchToolExecution(
                claim,
                receipt,
              );
              preparedCall.receipt = receipt;
              await this.#afterToolDispatched?.(receipt);
            }
            const { command, operation } = capacityInput();
            const resolution = await withWorkerToolDispatch(
              {
                command,
                receipt,
                method: operation,
                signal,
                assertCurrent: () => this.#queries.confirmedClaim(claim),
              },
              execute,
            );
            await this.#afterToolProviderResolved?.(resolution);
            return resolution;
          }),
      };
      preparedCalls.push(preparedCall);
    }

    const canRunInParallel = calls.every((event) =>
      definitions.some(
        (definition) =>
          definition.kind === event.data.kind &&
          definition.name === event.data.name &&
          definition.execution === "parallel",
      ),
    );
    if (canRunInParallel)
      for (const prepared of preparedCalls) prepared.preflight?.();
    const resolved = await resolveToolBatch({
      mode: canRunInParallel ? "parallel" : "sequential",
      shouldContinue: ({ resolution }) => resolution.status === "completed",
      calls: preparedCalls.map((prepared) => async () => {
        this.#queries.confirmedClaim(claim);
        return { prepared, resolution: await prepared.resolve() };
      }),
    });

    this.#queries.confirmedClaim(claim);
    for (const result of resolved) {
      this.#queries.confirmedClaim(claim);
      // Commit the successful prefix before surfacing a later failure. This
      // avoids reconciling finished calls on every pressure retry.
      if (result.status === "rejected") throw result.reason;
      const { prepared, resolution } = result.value;
      const { event, attempt: toolAttempt } = prepared;
      if (toolAttempt === null)
        throw new PermanentWorkerError("tool_attempt_missing");
      const call = event.data;
      let receipt = prepared.receipt;
      if (resolution.status === "unknownOutcome") {
        const committed =
          await this.#execution.commitToolExecutionUnknownOutcome(
            claim,
            receipt,
            toolAttempt,
            resolution.providerReceiptId,
            this.#retryAfterMs,
          );
        try {
          acknowledgeCommittedToolResult(
            runtime.toolRuntime,
            committed.receipt,
          );
        } catch {
          return {
            kind: "retried",
            runId: claim.workItem.runId,
            code: "tool_result_acknowledgement_pending",
          };
        }
        return {
          kind: "retried",
          runId: claim.workItem.runId,
          code: "tool_outcome_unknown",
        };
      }
      if (resolution.status === "canceled") {
        if (receipt.status !== "canceled") {
          receipt = await this.#execution.cancelToolExecutionReceipt(
            claim,
            receipt,
            resolution.providerReceiptId,
          );
        }
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        const run = await this.#execution.loadRun(claim);
        if (run.cancelRequested) {
          return this.#cancel(claim, toolAttempt);
        }
        throw new PermanentWorkerError("tool_execution_canceled");
      }

      const projected = await this.#projectToolOutput(
        run,
        receipt,
        resolution.result,
      );
      sequence += 1;
      const completedEvent = {
        schemaVersion: "crewon.agent-event.v0" as const,
        runId: claim.workItem.runId,
        segmentId: event.segmentId,
        sequence,
        type: "tool.completed" as const,
        data: {
          callId: call.callId,
          kind: call.kind,
          name: call.name,
          output: projected.output,
          isError: resolution.result.isError,
          artifactRef: projected.artifactRef,
          outputTruncated: projected.truncated,
          ...(resolution.result.workspaceChanges === undefined
            ? {}
            : { workspaceChanges: resolution.result.workspaceChanges }),
        },
      };
      if (receipt.status !== "completed") {
        const completion = await this.#execution.commitToolExecutionCompletion(
          claim,
          receipt,
          toolAttempt,
          completedEvent,
          resolution.providerReceiptId,
        );
        receipt = completion.receipt;
        acknowledgeCommittedToolResult(runtime.toolRuntime, receipt);
        await this.#afterToolReceiptCommitted?.(receipt);
        if (completion.run.state.cancelRequested) {
          return this.#cancel(claim);
        }
      } else {
        const run = await this.#execution.loadRun(claim);
        if (run.cancelRequested) {
          return this.#cancel(claim, toolAttempt);
        }
        await this.#execution.recordAgentEvent(claim, completedEvent);
        await this.#execution.completeAttempt(claim, toolAttempt);
      }
    }
    return null;
  }

  async #executeServerOwnedToolCalls(
    claim: WorkItemClaim,
    calls: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[],
    startingSequence: number,
  ): Promise<RuntimeWorkerOutcome | null> {
    let sequence = startingSequence;
    for (const event of calls) {
      this.#queries.confirmedClaim(claim);
      let result: Readonly<{ output: string; isError: boolean }>;
      if (isRunPlanToolCall(event.data)) {
        result = await this.#execution.executeRunPlanTool(claim, {
          ...event,
          data: event.data,
        });
        await this.#afterRunPlanToolExecuted?.();
      } else if (isGoalToolCall(event.data)) {
        const goalResult = await this.#execution.executeGoalTool(claim, event);
        await this.#afterGoalToolExecuted?.(goalResult);
        result = goalResult;
      } else {
        throw new PermanentWorkerError("server_owned_tool_request_invalid");
      }
      const run = await this.#execution.loadRun(claim);
      if (run.cancelRequested) {
        return this.#cancel(claim);
      }
      sequence += 1;
      await this.#execution.recordAgentEvent(claim, {
        schemaVersion: "crewon.agent-event.v0",
        runId: event.runId,
        segmentId: event.segmentId,
        sequence,
        type: "tool.completed",
        data: {
          callId: event.data.callId,
          kind: "function",
          name: event.data.name,
          output: result.output,
          isError: result.isError,
          artifactRef: null,
          outputTruncated: false,
        },
      });
    }
    return null;
  }

  async #projectToolOutput(
    run: RunState,
    receipt: ToolExecutionReceiptState,
    result: Extract<ToolExecutionResolution, { status: "completed" }>["result"],
  ): Promise<
    Readonly<{ output: string; truncated: boolean; artifactRef: string | null }>
  > {
    const modelVisible = modelVisibleToolOutput(result.output);
    const fitted = fitToolCompletionOutputToEvent({
      output: modelVisible.output,
      runId: run.runId,
      segmentId: receipt.call.segmentId,
      callId: receipt.call.callId,
      kind: receipt.call.kind,
      name: receipt.call.name,
      isError: result.isError,
      workspaceChanges: result.workspaceChanges,
    });
    const visible = {
      output: fitted.output,
      truncated: modelVisible.truncated || fitted.truncated,
    };
    if (result.artifactRef !== null) {
      if (this.#artifacts === undefined) {
        throw new PermanentWorkerError("artifact_authority_required");
      }
      try {
        const artifact = await this.#artifacts.requireToolOutputReference({
          tenantId: run.tenantId,
          spaceId: run.spaceId,
          ownerActorId: run.createdByActorId,
          artifactId: result.artifactRef,
          runId: run.runId,
          stepId: receipt.stepId,
          attemptId: receipt.attemptId,
          callId: receipt.call.callId,
          ...(receipt.status === "completed"
            ? { verification: "provenance" as const }
            : { verification: "content" as const, output: result.output }),
        });
        return { ...visible, artifactRef: artifact.artifactId };
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          (error.category === "notFound" || error.category === "validation")
        ) {
          throw new PermanentWorkerError("tool_artifact_reference_invalid");
        }
        throw error;
      }
    }
    if (!visible.truncated) {
      return { ...visible, artifactRef: null };
    }
    if (this.#artifacts === undefined) {
      throw new PermanentWorkerError("artifact_authority_required");
    }
    const limits = receipt.actionIntent?.limits;
    if (limits === undefined) {
      throw new PermanentWorkerError("tool_action_intent_missing");
    }
    try {
      const artifact = await this.#artifacts.persistToolOutput({
        tenantId: run.tenantId,
        spaceId: run.spaceId,
        ownerActorId: run.createdByActorId,
        runId: run.runId,
        stepId: receipt.stepId,
        attemptId: receipt.attemptId,
        callId: receipt.call.callId,
        output: result.output,
        idempotencyKey: receipt.idempotencyKey,
        maxArtifactBytes: limits.maxArtifactBytes,
      });
      return { ...visible, artifactRef: artifact.artifactId };
    } catch (error) {
      if (
        error instanceof ApplicationError &&
        error.category === "validation"
      ) {
        throw new PermanentWorkerError(error.code);
      }
      throw error;
    }
  }

  async #loadContext(
    claim: WorkItemClaim,
    run: RunState,
    options: Readonly<{ allowAssistantBoundary?: boolean }> = {},
  ): Promise<ModelContextProjection> {
    const thread = await this.#store.loadThread({
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    if (
      thread === null ||
      thread.spaceId !== run.spaceId ||
      thread.status !== "active"
    ) {
      throw new PermanentWorkerError("thread_not_executable");
    }
    let lastLeaseCheck = -Infinity;
    try {
      return await loadRuntimeModelContext(this.#store, run, {
        ...options,
        onProgress: async () => {
          await yieldToEventLoop();
          if (this.#closed) throw new Error("worker_closed");
          const now = performance.now();
          if (
            now - lastLeaseCheck <
            Math.min(1000, this.#leaseDurationMs / 3)
          ) {
            return;
          }
          await this.#renew(claim);
          const current = await this.#execution.loadRun(claim);
          if (current.cancelRequested) {
            throw new PermanentWorkerError("worker_cancel_requested");
          }
          lastLeaseCheck = now;
        },
      });
    } catch (error) {
      if (error instanceof ContextHistoryError) {
        throw new PermanentWorkerError(error.code);
      }
      throw error;
    }
  }

  async #cancelWaitingApproval(
    claim: WorkItemClaim,
    run: RunState,
  ): Promise<RuntimeWorkerOutcome> {
    const waiting = run.waitingApproval;
    if (waiting === null) {
      throw new PermanentWorkerError("tool_approval_state_missing");
    }
    const approval = await this.#store.loadToolApproval({
      tenantId: run.tenantId,
      approvalId: waiting.approvalId,
    });
    if (approval === null) {
      throw new PermanentWorkerError("tool_approval_state_missing");
    }
    await this.#execution.supersedeToolApprovalForCancellation(claim, approval);
    let receipt = await this.#store.loadToolExecutionReceipt({
      tenantId: run.tenantId,
      runId: run.runId,
      receiptId: approval.receiptId,
    });
    if (receipt === null) {
      throw new PermanentWorkerError("tool_receipt_not_found");
    }
    const recovery = await this.#execution.beginToolRecovery(claim, receipt);
    if (receipt.status === "prepared") {
      receipt = await this.#execution.cancelToolExecutionReceipt(
        claim,
        receipt,
        null,
      );
    }
    if (receipt.status !== "canceled") {
      throw new PermanentWorkerError(
        "tool_approval_cancel_receipt_not_prepared",
      );
    }
    return this.#cancel(claim, attemptIdentity(recovery));
  }

  async #cancel(
    claim: WorkItemClaim,
    currentAttempt: RunAttemptIdentity | null = null,
  ): Promise<RuntimeWorkerOutcome> {
    const run = await this.#execution.loadRun(claim);
    if (run.status !== "canceled") {
      await this.#renew(claim);
      try {
        // Queued is the initial lifecycle state; no model or tool dispatch has
        // begun. Canceling that work must not need a new runtime capacity slot.
        const runtime =
          run.status === "queued"
            ? null
            : await this.#resolveAgentVersionRuntime(run, "observe");
        if (runtime !== null) {
          const drain = await settleCanceledToolResults({
            runtime: runtime.toolRuntime,
            store: this.#store,
            execution: this.#execution,
            claim,
          });
          if (
            drain.kind === "more" ||
            (drain.kind === "unknown" && run.status === "reconciling")
          ) {
            await this.#store.retryWorkItem({
              ...leaseInput(claim),
              retryAfterMs: this.#retryAfterMs,
              reasonCode: "tool_cancellation_settlement_pending",
            });
            return {
              kind: "retried",
              runId: run.runId,
              code: "tool_cancellation_settlement_pending",
            };
          }
          if (drain.kind === "unknown") {
            const recovery = await this.#execution.beginToolRecovery(
              claim,
              drain.receipt,
            );
            const committed =
              await this.#execution.commitToolExecutionUnknownOutcome(
                claim,
                drain.receipt,
                attemptIdentity(recovery),
                drain.providerReceiptId,
                this.#retryAfterMs,
              );
            try {
              acknowledgeCommittedToolResult(
                runtime.toolRuntime,
                committed.receipt,
              );
            } catch {
              // The compound commit already rescheduled this claim. Repair ACK on its next wake.
              return {
                kind: "retried",
                runId: run.runId,
                code: "tool_result_acknowledgement_pending",
              };
            }
            return {
              kind: "retried",
              runId: run.runId,
              code: "tool_outcome_unknown",
            };
          }
        }
      } catch (error) {
        if (isLeaseLoss(error)) return { kind: "leaseLost", runId: run.runId };
        const code =
          error instanceof AgentRuntimeCapacityError
            ? error.code
            : "tool_cancellation_settlement_failed";
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs:
            error instanceof AgentRuntimeCapacityError
              ? error.retryAfterMs
              : this.#retryAfterMs,
          reasonCode: code,
        });
        return {
          kind: "retried",
          runId: run.runId,
          code,
        };
      }
      const approvalAttempt =
        currentAttempt === null && run.status === "running"
          ? await this.#cancelPreparedApprovedTool(claim, run)
          : null;
      const initialStep = await this.#store.loadRunStep({
        tenantId: run.tenantId,
        runId: run.runId,
        stepId: claim.workItem.workItemId,
      });
      const attempt =
        currentAttempt ??
        approvalAttempt ??
        (await this.#currentAttempt(claim)) ??
        (run.status === "running" && initialStep === null
          ? attemptIdentity(
              await this.#execution.beginModelAttempt(claim, {
                allowCancelPending: true,
              }),
            )
          : null);
      let cancellation: import("@crewon/application").RunCancellationResult;
      try {
        cancellation = await this.#execution.confirmCanceled(
          claim,
          attempt,
          "user_requested",
          this.#runProgressControl(claim, "cancel"),
        );
      } catch (error) {
        if (isLeaseLoss(error)) throw error;
        const current = await this.#queries.readCancellation(claim, () =>
          this.#execution.loadRun(claim),
        );
        if (current.status === "canceled")
          return { kind: "canceled", runId: run.runId };
        const code = failureCode(error);
        // A failed preparation gets a new wake budget; do not re-enter cancellation in this wake's outer catch.
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs:
            error instanceof RunStoreBusyError
              ? Math.max(this.#retryAfterMs, error.retryAfterMs)
              : this.#retryAfterMs,
          reasonCode: code,
        });
        return { kind: "retried", runId: run.runId, code };
      }
      if (cancellation.kind === "deferred") {
        await this.#store.retryWorkItem({
          ...leaseInput(claim),
          retryAfterMs: 0,
          reasonCode: "run_cancellation_progress_loading",
        });
        return {
          kind: "retried",
          runId: run.runId,
          code: "run_cancellation_progress_loading",
        };
      }
    } else {
      await this.#completeWorkItem(claim);
    }
    return { kind: "canceled", runId: run.runId };
  }

  async #cancelPreparedApprovedTool(
    claim: WorkItemClaim,
    run: RunState,
  ): Promise<RunAttemptIdentity | null> {
    const approval = await this.#store.loadLatestToolApprovalForRun({
      tenantId: run.tenantId,
      runId: run.runId,
    });
    if (
      approval === null ||
      approval.workItemId !== claim.workItem.workItemId ||
      approval.status === "required"
    ) {
      return null;
    }
    const receipt = await this.#store.loadToolExecutionReceipt({
      tenantId: run.tenantId,
      runId: run.runId,
      receiptId: approval.receiptId,
    });
    if (receipt?.status !== "prepared") {
      return null;
    }
    const recovery = await this.#execution.beginToolRecovery(claim, receipt);
    await this.#execution.cancelToolExecutionReceipt(claim, receipt, null);
    return attemptIdentity(recovery);
  }

  async #renew(claim: WorkItemClaim): Promise<void> {
    await this.#renewClaim(claim);
  }

  async #renewClaim(claim: WorkItemClaim): Promise<WorkItemClaim> {
    const lease = await this.#queries.renew(claim, () =>
      this.#store.renewWorkItemLease({
        ...leaseInput(claim),
        leaseDurationMs: this.#leaseDurationMs,
      }),
    );
    return { workItem: claim.workItem, lease };
  }

  async #completeWorkItem(claim: WorkItemClaim): Promise<void> {
    await this.#store.completeWorkItem(leaseInput(claim));
  }

  async #retry(
    claim: WorkItemClaim,
    reasonCode: string,
    retryAfterMs = this.#retryAfterMs,
  ): Promise<void> {
    const attempt = await this.#currentAttempt(claim);
    if (attempt !== null) {
      await this.#execution.retryAttempt(claim, attempt, {
        code: reasonCode,
        retryAfterMs,
        checkpoint: null,
      });
      return;
    }
    await this.#store.retryWorkItem({
      ...leaseInput(claim),
      retryAfterMs,
      reasonCode,
    });
  }

  async #retryActiveAttempt(
    claim: WorkItemClaim,
    attempt: RunAttemptIdentity,
    error: unknown,
    checkpoint: ProviderCheckpoint | null,
  ): Promise<RuntimeWorkerOutcome> {
    const code = failureCode(error);
    await this.#execution.retryAttempt(claim, attempt, {
      code,
      retryAfterMs:
        error instanceof AgentKernelError && error.retryAfterMs !== undefined
          ? error.retryAfterMs
          : this.#retryAfterMs,
      checkpoint,
    });
    return { kind: "retried", runId: claim.workItem.runId, code };
  }

  async #currentAttempt(
    claim: WorkItemClaim,
  ): Promise<RunAttemptIdentity | null> {
    const locator = {
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      stepId: claim.workItem.workItemId,
    } as const;
    const step = await this.#store.loadRunStep(locator);
    if (step?.status !== "running" || step.currentAttemptId === null) {
      return null;
    }
    const attempt = await this.#store.loadRunAttempt({
      ...locator,
      attemptId: step.currentAttemptId,
    });
    return attempt?.status === "running" &&
      attempt.leaseEpoch === claim.lease.epoch
      ? { stepId: step.stepId, attemptId: attempt.attemptId }
      : null;
  }

  async #attemptIsRunning(
    run: RunState,
    attempt: RunAttemptIdentity,
  ): Promise<boolean> {
    const stored = await this.#store.loadRunAttempt({
      tenantId: run.tenantId,
      runId: run.runId,
      stepId: attempt.stepId,
      attemptId: attempt.attemptId,
    });
    return stored?.status === "running";
  }
}

function selectContinuation(
  projection: ModelContextProjection,
  stored: ThreadContinuationCheckpoint | null,
): AgentContinuation {
  if (stored === null) {
    return { kind: "manual" };
  }
  const newHistoryStartIndex = projectedContinuationStart(projection, stored);
  if (newHistoryStartIndex === null) {
    return { kind: "manual" };
  }
  const newItems = projection.items.slice(newHistoryStartIndex);
  if (
    newItems.some(
      (item) => item.type === "message" && item.role === "assistant",
    )
  ) {
    return { kind: "manual" };
  }
  return {
    kind: "providerCheckpoint",
    checkpoint: stored.checkpoint,
    newHistoryStartIndex,
  };
}

function sameAutomationInvocationBinding(
  left: ReturnType<typeof parseAutomationInvocationBinding>,
  right: ReturnType<typeof parseAutomationInvocationBinding>,
): boolean {
  return (
    left.automationId === right.automationId &&
    left.automationRevision === right.automationRevision &&
    left.definitionDigest === right.definitionDigest &&
    left.instructionDigest === right.instructionDigest &&
    left.invocationId === right.invocationId &&
    left.runId === right.runId &&
    left.routeDigest === right.routeDigest
  );
}

function automationRunRouteDigest(run: RunState): string {
  const canonicalRoute = JSON.stringify({
    agentVersionId: run.agentVersionId,
    authorityId: run.authorityId,
    policySnapshotId: run.policySnapshotId,
    runtimeGeneration: run.runtimeGeneration,
    workspaceBindingId: run.workspaceBindingId,
  });
  return `sha256:${createHash("sha256").update(canonicalRoute).digest("hex")}`;
}

function manualCompactionRequest(
  claim: WorkItemClaim,
  run: RunState,
): Readonly<{ expectedHistorySequence: number }> | null {
  const payload = claim.workItem.payload;
  const isManual = payload.trigger === "manualCompaction";
  if (!isManual && run.purpose !== "manualCompaction") return null;
  if (
    !isManual ||
    run.purpose !== "manualCompaction" ||
    payload.schemaVersion !== "crewon.manual-compaction-work-item.v0" ||
    payload.throughSequence !== 1 ||
    !Number.isSafeInteger(payload.expectedHistorySequence) ||
    Number(payload.expectedHistorySequence) < 1 ||
    Object.keys(payload).sort().join(",") !==
      "expectedHistorySequence,schemaVersion,throughSequence,trigger"
  ) {
    throw new PermanentWorkerError("manual_compaction_payload_invalid");
  }
  return {
    expectedHistorySequence: Number(payload.expectedHistorySequence),
  };
}

class PermanentWorkerError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "PermanentWorkerError";
    this.code = code;
  }
}

export function fitToolCompletionOutputToEvent(
  input: Readonly<{
    output: string;
    runId: string;
    segmentId: string;
    callId: string;
    kind: "function" | "custom";
    name: string;
    isError: boolean;
    workspaceChanges?: WorkspaceChangeSummary;
  }>,
): Readonly<{ output: string; truncated: boolean }> {
  const fits = (output: string): boolean =>
    utf8ByteLength(
      JSON.stringify({
        schemaVersion: "crewon.agent-event.v0",
        runId: input.runId,
        segmentId: input.segmentId,
        sequence: Number.MAX_SAFE_INTEGER,
        type: "tool.completed",
        data: {
          callId: input.callId,
          kind: input.kind,
          name: input.name,
          output,
          isError: input.isError,
          artifactRef: "x".repeat(MAX_TOOL_ARTIFACT_REF_BYTES),
          outputTruncated: true,
          ...(input.workspaceChanges === undefined
            ? {}
            : { workspaceChanges: input.workspaceChanges }),
        },
      }),
    ) <= MAX_CANONICAL_AGENT_EVENT_BYTES;

  if (fits(input.output)) {
    return { output: input.output, truncated: false };
  }
  const entries = [...input.output].map((value) => ({
    value,
    bytes: utf8ByteLength(value),
  }));
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const candidate = (retained: number): string => {
    const headLength = Math.ceil(retained / 2);
    const tailLength = Math.floor(retained / 2);
    const head = entries.slice(0, headLength);
    const tail = tailLength === 0 ? [] : entries.slice(-tailLength);
    const retainedBytes = [...head, ...tail].reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    return `${head.map((entry) => entry.value).join("")}\n…${totalBytes - retainedBytes} bytes truncated for durable event…\n${tail.map((entry) => entry.value).join("")}`;
  };
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  const output = candidate(low);
  if (!fits(output)) {
    throw new PermanentWorkerError("tool_completed_event_budget_exhausted");
  }
  return { output, truncated: true };
}

function leaseInput(claim: WorkItemClaim) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  } as const;
}

function attemptIdentity(
  result: Awaited<ReturnType<RunExecutionService["beginModelAttempt"]>>,
): RunAttemptIdentity {
  return {
    stepId: result.step.stepId,
    attemptId: result.attempt.attemptId,
  };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function toolExecutionCommand(
  receipt: ToolExecutionReceiptState,
  input: string,
  approval: ToolApprovalState | null,
  claim: WorkItemClaim,
): ToolExecutionCommand {
  if (receipt.actionIntent === null) {
    throw new PermanentWorkerError("tool_action_intent_missing");
  }
  const approvalDecision = approval?.decision ?? null;
  if (
    approval !== null &&
    (approval.status !== "approved" || approvalDecision === null)
  ) {
    throw new PermanentWorkerError("tool_approval_proof_invalid");
  }
  return {
    schemaVersion: "crewon.tool-invocation.v0",
    executionId: receipt.executionId,
    executionLease: {
      workItemId: claim.workItem.workItemId,
      stepId: receipt.stepId,
      attemptId: receipt.attemptId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
      expiresAt: claim.lease.expiresAt,
    },
    actionDigest: receipt.actionDigest,
    actionIntent: receipt.actionIntent,
    approvalProof:
      approval === null
        ? null
        : {
            schemaVersion: "crewon.tool-approval-proof.v0",
            approvalId: approval.approvalId,
            actionDigest: approval.actionDigest,
            policySnapshotId: approval.policySnapshotId,
            approvalRevision: approval.revision,
            decidedAt: approvalDecision!.decidedAt,
          },
    idempotencyKey: receipt.idempotencyKey,
    runId: receipt.runId,
    segmentId: receipt.call.segmentId,
    callId: receipt.call.callId,
    kind: receipt.call.kind,
    name: receipt.call.name,
    input,
  };
}

function completedResolution(receipt: ToolExecutionReceiptState) {
  if (receipt.result === null || receipt.providerReceiptId === null) {
    throw new PermanentWorkerError("tool_receipt_result_missing");
  }
  return {
    status: "completed" as const,
    executionId: receipt.executionId,
    providerReceiptId: receipt.providerReceiptId,
    result: {
      schemaVersion: "crewon.tool-result.v0" as const,
      callId: receipt.call.callId,
      output: receipt.result.output,
      isError: receipt.result.isError,
      artifactRef: receipt.result.artifactRef,
      ...(receipt.result.workspaceChanges === undefined
        ? {}
        : { workspaceChanges: receipt.result.workspaceChanges }),
    },
  };
}

function planAllowedTools(
  runtime: WorkerAgentRuntime,
): AgentSegmentContract["allowedTools"] {
  return runtime.toolDefinitions.flatMap((definition) => {
    const policy = runtime.toolRuntime.executionPolicy(
      definition.kind,
      definition.name,
    );
    return policy?.effect === "readOnly"
      ? [{ kind: definition.kind, name: definition.name }]
      : [];
  });
}

function isTerminal(run: RunState): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "canceled"
  );
}

function terminalOutcome(run: RunState): RuntimeWorkerOutcome {
  if (run.status === "completed") {
    return { kind: "completed", runId: run.runId };
  }
  if (run.status === "canceled") {
    return { kind: "canceled", runId: run.runId };
  }
  return {
    kind: "failed",
    runId: run.runId,
    code: run.failure?.code ?? "run_failed",
  };
}

function isLeaseLoss(error: unknown): boolean {
  return (
    error instanceof RuntimeAuthorityError ||
    ((error instanceof ApplicationError || error instanceof RunStoreError) &&
      (error.code === "stale_lease" || error.code === "lease_expired"))
  );
}

function isExecutionCancelPending(error: unknown): boolean {
  return (
    error instanceof ApplicationError &&
    error.code === "execution_cancel_pending"
  );
}

function failureCode(error: unknown): string {
  if (error instanceof AgentKernelError) {
    return safeCode(error.code);
  }
  if (error instanceof ApplicationError) {
    return safeCode(error.code);
  }
  if (error instanceof Error) {
    return safeCode(error.message);
  }
  return "runtime_worker_failed";
}

function safeCode(value: string): string {
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : "runtime_worker_failed";
}

function requireBoundedString(
  value: string,
  maxLength: number,
  code: string,
): string {
  if (value.trim().length === 0 || value.length > maxLength) {
    throw new Error(code);
  }
  return value;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(code);
  }
  return value;
}

function positiveIntegerAtMost(
  value: number,
  max: number,
  code: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(code);
  }
  return value;
}

function nonNegativeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(code);
  }
  return value;
}

function optionalPositiveInteger(
  value: number | null,
  code: string,
): number | null {
  return value === null ? null : positiveInteger(value, code);
}
