import { createHash } from "node:crypto";

import {
  AgentKernelError,
  type AgentContinuation,
  type AgentKernelPort,
  type AgentSegmentContract,
  type KernelAgentEvent,
} from "@crewon/agent-kernel";
import {
  ApplicationError,
  type DomainStore,
  type ModelDispatchEvidenceStore,
  type RunExecutionPolicyPort,
  type RunExecutionService,
  type RunAttemptIdentity,
  type ThreadContinuationCheckpoint,
  type ToolOutputArtifactPort,
  type WorkItemClaim,
  type GoalToolExecutionResult,
} from "@crewon/application";
import type {
  CanonicalAgentEvent,
  ProviderCheckpoint,
} from "@crewon/contracts";
import {
  ContextHistoryError,
  CONTEXT_COMPACTION_PROMPT,
  boundedContextTail,
  projectModelHistory,
  projectedContinuationStart,
  type ContextCompactorPort,
  type ContextHistoryItem,
  type GovernedContextBundle,
  type ModelContextProjection,
} from "@crewon/context";
import type {
  ModelHistoryItem,
  ModelDispatchReceipt,
  RunLifecycleEvent,
  RunState,
  ToolApprovalState,
  ToolExecutionReceiptState,
} from "@crewon/domain";
import {
  InMemoryToolBroker,
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
  AgentVersionRuntime,
  AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import { PlanOutputError, parseProposedPlan } from "./plan-output.ts";
import { goalToolsForRun, isGoalToolCall } from "./goal-tools.ts";
import { replaceChangedToolApproval } from "./tool-approval-replacement.ts";
import { AgentSegmentExecutionEngine } from "./agent-segment-execution-engine.ts";
import { AgentSegmentStateMachine } from "./agent-segment-state-machine.ts";
import type { WorkflowRuntimeDispatcherPort } from "./workflow-runtime-dispatcher.ts";

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
const MAX_DURABLE_HISTORY_ITEMS = 10_000;
const MAX_DURABLE_HISTORY_BYTES = 64 * 1024 * 1024;
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
}>;

export type RuntimeWorkerOutcome =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "completed"; runId: string }>
  | Readonly<{ kind: "canceled"; runId: string }>
  | Readonly<{ kind: "failed"; runId: string; code: string }>
  | Readonly<{ kind: "retried"; runId: string; code: string }>
  | Readonly<{ kind: "workflowRecovery"; runId: string; code: string }>
  | Readonly<{
      kind: "waitingApproval";
      runId: string;
      approvalId: string;
    }>
  | Readonly<{ kind: "leaseLost"; runId: string }>;

type WorkerAgentRuntime = Readonly<{
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
  readonly #store: DomainStore;
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
  readonly #workflowDispatcher: WorkflowRuntimeDispatcherPort | undefined;
  readonly #governedContextItems: readonly ContextHistoryItem[];
  readonly #governedContextBytes: number;
  readonly #ownerId: string;
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
  #timer: ReturnType<typeof setInterval> | null = null;
  #drain: Promise<RuntimeWorkerOutcome> | null = null;
  #closed = false;
  #lastOutcome: RuntimeWorkerOutcome | null = null;

  constructor(
    dependencies: {
      store: DomainStore;
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
      workflowDispatcher?: WorkflowRuntimeDispatcherPort;
    },
    config: RuntimeWorkerConfig,
  ) {
    this.#store = dependencies.store;
    this.#execution = dependencies.execution;
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
    this.#workflowDispatcher = dependencies.workflowDispatcher;
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
    this.#leaseDurationMs = positiveInteger(
      config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "worker_lease_duration_invalid",
    );
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

  async wake(): Promise<RuntimeWorkerOutcome> {
    if (this.#closed) {
      return { kind: "idle" };
    }
    if (this.#drain !== null) {
      return this.#drain;
    }
    const drain = this.#runOnce();
    this.#drain = drain;
    try {
      const outcome = await drain;
      this.#lastOutcome = outcome;
      return outcome;
    } finally {
      if (this.#drain === drain) {
        this.#drain = null;
      }
    }
  }

  lastOutcome(): RuntimeWorkerOutcome | null {
    return this.#lastOutcome;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#drain;
  }

  async #runOnce(): Promise<RuntimeWorkerOutcome> {
    const claim = await this.#store.claimNextWorkItem({
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
    try {
      return await this.#executeClaim(claim);
    } catch (error) {
      if (isLeaseLoss(error)) {
        return { kind: "leaseLost", runId: claim.workItem.runId };
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
          retryAfterMs: this.#retryAfterMs,
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
    tenantId: string,
    agentVersionId: string,
  ): Promise<WorkerAgentRuntime | null> {
    if (this.#agentVersionRuntimeResolver === undefined) {
      return {
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
    const resolved = await this.#agentVersionRuntimeResolver.resolve({
      tenantId,
      agentVersionId,
    });
    if (resolved === null) {
      return null;
    }
    if (resolved.version.agentVersionId !== agentVersionId) {
      throw new PermanentWorkerError("agent_version_runtime_identity_mismatch");
    }
    return this.#projectAgentVersionRuntime(resolved);
  }

  #projectAgentVersionRuntime(
    runtime: AgentVersionRuntime,
  ): WorkerAgentRuntime {
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

  async #executeClaim(claim: WorkItemClaim): Promise<RuntimeWorkerOutcome> {
    let run = await this.#execution.loadRun(claim);
    if (run.purpose === "workflow") {
      if (
        run.workflowVersionBinding === undefined ||
        this.#workflowDispatcher === undefined
      ) {
        throw new PermanentWorkerError("workflow_runtime_not_configured");
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
      const outcome = run.cancelRequested
        ? await this.#workflowDispatcher.cancel({ claim, run })
        : await this.#workflowDispatcher.dispatch({ claim, run });
      if (outcome.kind === "retry")
        await this.#store.retryWorkItem({ ...leaseInput(claim),
          retryAfterMs: this.#retryAfterMs, reasonCode: outcome.code });
      return outcome.kind === "recovery" || outcome.kind === "retry"
        ? {
            kind: "workflowRecovery",
            runId: outcome.runId,
            code: outcome.code,
          }
        : outcome;
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
        return this.#executeClaim(claim);
      }
      const runtime = await this.#resolveAgentVersionRuntime(
        run.tenantId,
        run.agentVersionId,
      );
      if (runtime !== null) {
        const pending = await this.#pendingToolEvents(run);
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
      run.tenantId,
      run.agentVersionId,
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
    if (run.status === "reconciling") {
      return this.#reconcileToolClaim(claim, run, runtime);
    }

    const decision = await runtime.policy.evaluate({
      run,
      workItem: claim.workItem,
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
      const context = await this.#loadContext(run, {
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

    const pendingTools = await this.#pendingToolEvents(run);
    if (pendingTools.events.length > 0) {
      const controller = new AbortController();
      const renewedClaim = await this.#renewClaim(claim);
      const heartbeat = new LeaseHeartbeat(
        Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
        () => this.#renew(claim),
        controller,
      );
      const cancellationWatcher = new CancellationWatcher(
        this.#cancellationPollIntervalMs,
        () => this.#execution.loadRun(claim),
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
        return outcome ?? this.#executeClaim(claim);
      } finally {
        await cancellationWatcher.close();
        await heartbeat.close();
      }
    }
    const completedToolRounds = pendingTools.completedToolRounds;
    const completedAssistantSamples = pendingTools.providerContinuationSamples;
    if ((await this.#execution.consumeGoalSteering(claim)) !== null) {
      run = await this.#execution.loadRun(claim);
    }
    const context = await this.#loadContext(run);
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
      const priorRuntime =
        await this.#modelSwitchCompactionResolver?.resolve(priorModelState);
      if (priorRuntime === null || priorRuntime === undefined) {
        throw new PermanentWorkerError("model_switch_compactor_unavailable");
      }
      return this.#compactContext(claim, run, context, runtime, {
        compactor: priorRuntime.compactor,
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
    await this.#afterAttemptStarted?.();
    const dispatchEvidenceStore =
      runtime.kernel.supportsModelDispatchEvidence === true
        ? modelDispatchEvidenceStore(this.#store)
        : null;

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
    const storedContinuation = await this.#execution.loadThreadContinuation(
      claim,
      modelIdentity,
    );
    const continuation = selectContinuation(context, storedContinuation);
    let providerTurnState =
      await this.#execution.loadRunProviderTurnState(claim);
    const segmentId = `segment:${attempt.attemptId}`;
    const controller = new AbortController();
    await this.#renew(claim);
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () => this.#execution.loadRun(claim),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    const segmentEngine = new AgentSegmentExecutionEngine();
    const segment = new AgentSegmentStateMachine(providerTurnState);
    let activeDispatchReceipt: ModelDispatchReceipt | null = null;
    let toolBoundaryCompleted = false;
    let toolBoundaryOutcome: RuntimeWorkerOutcome | null = null;
    try {
      const executed = await segmentEngine.execute({
        kernel: runtime.kernel,
        contract: {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: run.runId,
          segmentId,
          attempt: attemptResult.attempt.attemptNumber,
          agentVersionId: run.agentVersionId,
          policySnapshotId: run.policySnapshotId,
          collaborationMode: run.collaborationMode,
          allowedTools:
            run.collaborationMode === "plan" ? planAllowedTools(runtime) : null,
          runtimeTools: goalToolsForRun(run),
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
        signal: controller.signal,
        providerTurnState,
        state: segment,
        authority: {
          renewLease: () => this.#renew(claim),
          cancellationRequested: async () => {
            run = await this.#execution.loadRun(claim);
            return run.cancelRequested;
          },
          checkpointProviderResponse: async (checkpoint) => {
            if (
              dispatchEvidenceStore !== null &&
              activeDispatchReceipt === null
            ) {
              throw new AgentKernelError(
                "model_dispatch_preparation_missing",
                false,
              );
            }
            await this.#execution.checkpointModelAttempt(
              claim,
              attempt,
              checkpoint,
              activeDispatchReceipt === null
                ? undefined
                : {
                    requestSequence: activeDispatchReceipt.requestSequence,
                    operationId: activeDispatchReceipt.operationId,
                    expectedRevision: activeDispatchReceipt.revision,
                  },
            );
            if (activeDispatchReceipt !== null) {
              activeDispatchReceipt =
                await dispatchEvidenceStore!.loadModelDispatchReceipt({
                  tenantId: run.tenantId,
                  runId: run.runId,
                  ...attempt,
                  operationId: activeDispatchReceipt.operationId,
                });
            }
            await this.#afterProviderResponseCheckpointed?.();
          },
          persistImmediateEvent: async (event) => {
            const persisted = await this.#execution.recordAgentEvent(
              claim,
              event,
            );
            run = persisted.state;
          },
          recordProviderTurnState: async (observedProviderTurnState) => {
            await this.#execution.recordProviderTurnState(
              claim,
              attempt,
              observedProviderTurnState,
            );
            providerTurnState = observedProviderTurnState;
          },
        },
        controlSink: {
          modelRequestPrepared: async (evidence) => {
            if (dispatchEvidenceStore === null) return;
            activeDispatchReceipt =
              await dispatchEvidenceStore.prepareModelDispatch({
                tenantId: run.tenantId,
                runId: run.runId,
                lease: leaseInput(claim),
                attempt,
                operationId: evidence.operationId,
                requestSequence: evidence.requestSequence,
                operation: evidence.operation,
                requestDigest: evidence.requestDigest,
                provider: evidence.provider,
                preparedAt: new Date().toISOString(),
              });
          },
          dispatchBoundaryCrossed: async (evidence) => {
            if (dispatchEvidenceStore === null) return;
            if (
              activeDispatchReceipt === null ||
              activeDispatchReceipt.requestSequence !==
                evidence.requestSequence ||
              activeDispatchReceipt.operationId !== evidence.operationId ||
              activeDispatchReceipt.requestDigest !== evidence.requestDigest
            ) {
              throw new AgentKernelError(
                "model_dispatch_preparation_missing",
                false,
              );
            }
            activeDispatchReceipt =
              await dispatchEvidenceStore.markModelDispatchPossiblySent({
                tenantId: run.tenantId,
                runId: run.runId,
                lease: leaseInput(claim),
                attempt,
                operationId: evidence.operationId,
                requestSequence: evidence.requestSequence,
                expectedRevision: activeDispatchReceipt.revision,
                transitionedAt: new Date().toISOString(),
              });
          },
        },
      });
      providerTurnState = segment.providerTurnState;
      if (executed.canceled) {
        controller.abort("user_requested");
        return this.#cancel(claim, attempt);
      }
      if (segment.assistantContinuation !== null) {
        segment.validateContinuation();
        const assistantContinuation = segment.assistantContinuation;
        await this.#beforeAssistantSampleCommitted?.();
        await this.#execution.commitAssistantSampleContinuation(
          claim,
          attempt,
          {
            sampleIndex: completedAssistantSamples + 1,
            segmentId,
            output: assistantContinuation.data.output,
            completedAssistantItems:
              assistantContinuation.data.completedAssistantItems,
            events: segment.bufferedEvents,
            identity: modelIdentity,
            contextRevision: context.revision,
            modelPolicy: {
              contextWindowTokens: runtime.modelContextWindowTokens,
              autoCompactAtTokens: runtime.autoCompactAtTokens,
            },
            latestUsage: segment.latestUsage,
            checkpoint: assistantContinuation.data.checkpoint,
            providerTurnState,
          },
        );
        await this.#afterAssistantSampleCommitted?.();
        if (segment.requestedTools.length > 0) {
          if (completedToolRounds >= runtime.maxToolRounds) {
            throw new PermanentWorkerError(
              "model_tool_round_limit_exceeded",
            );
          }
          toolBoundaryOutcome = await this.#executeToolCalls(
            claim,
            run,
            segment.requestedTools,
            segment.lastAgentSequence,
            controller.signal,
            runtime,
          );
          toolBoundaryCompleted = toolBoundaryOutcome === null;
        } else {
          toolBoundaryCompleted = true;
        }
      } else {
        for (const event of segment.bufferedEvents) {
          const persisted = await this.#execution.recordAgentEvent(
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
        segment.assistantContinuation === null &&
        !segment.completed &&
        segment.requestedTools.length > 0
      ) {
        const completedAssistantOutput = segment.requestedTools
          .flatMap((event) => event.data.completedAssistantItems ?? [])
          .join("");
        if (
          segment.output.length > 0 &&
          completedAssistantOutput !== segment.output
        ) {
          throw new AgentKernelError(
            "model_tool_call_with_text_unsupported",
            false,
          );
        }
        if (segment.checkpointEvent !== null) {
          await this.#execution.recordAgentEvent(claim, segment.checkpointEvent);
        }
        if (completedToolRounds >= runtime.maxToolRounds) {
          throw new PermanentWorkerError("model_tool_round_limit_exceeded");
        }
        segment.lastAgentSequence += 1;
        await this.#execution.recordAgentEvent(claim, {
          schemaVersion: "crewon.agent-event.v0",
          runId: run.runId,
          segmentId,
          sequence: segment.lastAgentSequence,
          type: "segment.completed",
          data: { output: "" },
        });
        await this.#execution.completeAttempt(claim, attempt, null, {
          providerTurnState,
        });
        toolBoundaryOutcome = await this.#executeToolCalls(
          claim,
          run,
          segment.requestedTools,
          segment.lastAgentSequence,
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
          sequence: segment.lastAgentSequence + 1,
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
        segment.providerCheckpoint,
      );
    } finally {
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
      return this.#executeClaim(claim);
    }
    if (!segment.completed || segment.completedSequence === null) {
      throw new PermanentWorkerError("segment_completion_missing");
    }

    let completionOutput = segment.output;
    let proposedPlan: string | null = null;
    if (run.collaborationMode === "plan") {
      try {
        completionOutput = parseProposedPlan(segment.output);
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
          checkpoint: segment.providerCheckpoint,
          providerTurnState,
          segment: {
            segmentId,
            checkpointSequence: segment.checkpointSequence,
            completedSequence: segment.completedSequence,
          },
          modelPolicy: {
            contextWindowTokens: runtime.modelContextWindowTokens,
            autoCompactAtTokens: runtime.autoCompactAtTokens,
          },
          latestUsage: segment.latestUsage,
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
        segment.providerCheckpoint,
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
      governedContext?: GovernedContextBundle;
      agentVersionId?: string;
      replacesThroughSequence: number;
      mode?: "auto" | "manual";
      completion?: "continueRun" | "completeRun";
    }>,
  ): Promise<RuntimeWorkerOutcome> {
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
    const controller = new AbortController();
    await this.#renew(claim);
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () => this.#execution.loadRun(claim),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    let committed = false;
    try {
      const compactedInput = boundedContextTail(
        sourceItems,
        this.#maxContextItems - governedContextItems.length - 1,
        this.#maxContextBytes -
          governedContextBytes -
          utf8ByteLength(CONTEXT_COMPACTION_PROMPT),
      );
      const result = await (
        options?.compactor ?? runtime.contextCompactor
      ).compact(
        {
          runId: run.runId,
          segmentId,
          attempt: attemptResult.attempt.attemptNumber,
          agentVersionId: options?.agentVersionId ?? run.agentVersionId,
          policySnapshotId: run.policySnapshotId,
          history: [...governedContextItems, ...compactedInput.items],
          maxOutputBytes: 32 * 1024,
        },
        controller.signal,
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
    return this.#executeClaim(claim);
  }

  async #reconcileToolClaim(
    claim: WorkItemClaim,
    run: RunState,
    runtime: WorkerAgentRuntime,
  ): Promise<RuntimeWorkerOutcome> {
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
    const controller = new AbortController();
    const renewedClaim = await this.#renewClaim(claim);
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      () => this.#renew(claim),
      controller,
    );
    const cancellationWatcher = new CancellationWatcher(
      this.#cancellationPollIntervalMs,
      () => this.#execution.loadRun(claim),
      controller,
      this.#cancellationScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
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
          renewedClaim,
        );
        resolution = run.cancelRequested
          ? await runtime.toolRuntime.cancel(command, controller.signal)
          : await runtime.toolRuntime.reconcile(command, controller.signal);
      }
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
          this.#retryAfterMs,
        );
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
      return this.#executeClaim(claim);
    } finally {
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

  async #pendingToolEvents(run: RunState): Promise<
    Readonly<{
      events: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[];
      lastSegmentSequence: number;
      completedToolRounds: number;
      providerContinuationSamples: number;
      latestUsageTotalTokens: number | null;
    }>
  > {
    const all: RunLifecycleEvent[] = [];
    let cursor = 0;
    while (cursor < run.lastSequence) {
      const page = await this.#store.listRunEvents(
        { tenantId: run.tenantId, runId: run.runId },
        cursor,
        Math.min(HISTORY_PAGE_SIZE, run.lastSequence - cursor),
      );
      if (page.length === 0) {
        throw new PermanentWorkerError("run_event_history_incomplete");
      }
      all.push(...page);
      cursor = page.at(-1)!.sequence;
    }
    const pending = new Map<
      string,
      Extract<RunLifecycleEvent, { type: "tool.requested" }>
    >();
    const completedToolSegments = new Set<string>();
    let providerContinuationSamples = 0;
    let latestUsageTotalTokens: number | null = null;
    for (const event of all) {
      if (event.type === "context.compacted") {
        latestUsageTotalTokens = null;
      } else if (event.type === "usage.recorded") {
        latestUsageTotalTokens = event.data.totalTokens;
      } else if (event.type === "tool.requested") {
        pending.set(event.data.callId, event);
      } else if (event.type === "tool.completed") {
        pending.delete(event.data.callId);
        completedToolSegments.add(event.data.segmentId);
      } else if (event.type === "segment.provider_continuation") {
        if (event.data.sampleIndex !== providerContinuationSamples + 1) {
          throw new PermanentWorkerError(
            "provider_continuation_sequence_invalid",
          );
        }
        providerContinuationSamples = event.data.sampleIndex;
      }
    }
    const segmentIds = new Set(
      [...pending.values()].map((event) => event.data.segmentId),
    );
    let lastSegmentSequence = 0;
    for (const event of all) {
      if (
        "segmentId" in event.data &&
        segmentIds.has(event.data.segmentId) &&
        "segmentSequence" in event.data
      ) {
        lastSegmentSequence = Math.max(
          lastSegmentSequence,
          event.data.segmentSequence,
        );
      }
    }
    return {
      events: [...pending.values()].map((event) => ({
        schemaVersion: "crewon.agent-event.v0",
        runId: run.runId,
        segmentId: event.data.segmentId,
        sequence: event.data.segmentSequence,
        type: "tool.requested",
        data: {
          callId: event.data.callId,
          kind: event.data.kind,
          name: event.data.name,
          input: event.data.input,
        },
      })),
      lastSegmentSequence,
      completedToolRounds: completedToolSegments.size,
      providerContinuationSamples,
      latestUsageTotalTokens,
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
    const goalCalls =
      goalToolsForRun(run).length === 0
        ? []
        : calls.filter((event) => isGoalToolCall(event.data));
    if (goalCalls.length > 0) {
      if (
        goalCalls.some((event) =>
          runtime.toolDefinitions.some(
            (definition) =>
              definition.kind === event.data.kind &&
              definition.name === event.data.name,
          ),
        )
      ) {
        throw new PermanentWorkerError("runtime_tool_identity_conflict");
      }
      if (goalCalls.length !== calls.length) {
        throw new PermanentWorkerError("goal_tool_mixed_batch_unsupported");
      }
      return this.#executeGoalToolCalls(claim, goalCalls, startingSequence);
    }
    let sequence = startingSequence;
    const definitions = runtime.toolDefinitions;
    const preparedCalls: Array<{
      event: Extract<KernelAgentEvent, { type: "tool.requested" }>;
      receipt: ToolExecutionReceiptState;
      attempt: RunAttemptIdentity;
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
      const toolAttemptResult =
        prepared.attempt ??
        (await this.#execution.beginToolRecovery(claim, prepared.receipt));
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
            attemptIdentity(toolAttemptResult),
          );
          return { kind: "failed", runId: receipt.runId, code };
        }
        toolApproval = approval.approval;
      }
      if (receipt.status === "completed") {
        preparedCalls.push({
          event,
          receipt,
          attempt: attemptIdentity(toolAttemptResult),
          resolve: () => Promise.resolve(completedResolution(receipt)),
        });
        continue;
      }
      if (receipt.status === "canceled") {
        preparedCalls.push({
          event,
          receipt,
          attempt: attemptIdentity(toolAttemptResult),
          resolve: () =>
            Promise.resolve({
              status: "canceled" as const,
              executionId: receipt.executionId,
              providerReceiptId: receipt.providerReceiptId,
            }),
        });
        continue;
      }
      const shouldExecute = receipt.status === "prepared";
      if (shouldExecute) {
        receipt = await this.#execution.dispatchToolExecution(claim, receipt);
        await this.#afterToolDispatched?.(receipt);
      }
      const command = toolExecutionCommand(
        receipt,
        call.input,
        toolApproval,
        claim,
      );
      preparedCalls.push({
        event,
        receipt,
        attempt: attemptIdentity(toolAttemptResult),
        resolve: async () => {
          const resolution = shouldExecute
            ? await runtime.toolRuntime.execute(command, signal)
            : await runtime.toolRuntime.reconcile(command, signal);
          await this.#afterToolProviderResolved?.(resolution);
          return resolution;
        },
      });
    }

    const canRunInParallel = calls.every((event) =>
      definitions.some(
        (definition) =>
          definition.kind === event.data.kind &&
          definition.name === event.data.name &&
          definition.execution === "parallel",
      ),
    );
    const resolved: Array<{
      prepared: (typeof preparedCalls)[number];
      resolution: ToolExecutionResolution;
    }> = [];
    if (canRunInParallel) {
      resolved.push(
        ...(await Promise.all(
          preparedCalls.map(async (prepared) => ({
            prepared,
            resolution: await prepared.resolve(),
          })),
        )),
      );
    } else {
      for (const prepared of preparedCalls) {
        resolved.push({
          prepared,
          resolution: await prepared.resolve(),
        });
      }
    }

    for (const { prepared, resolution } of resolved) {
      const { event, attempt: toolAttempt } = prepared;
      const call = event.data;
      let receipt = prepared.receipt;
      if (resolution.status === "unknownOutcome") {
        await this.#execution.commitToolExecutionUnknownOutcome(
          claim,
          receipt,
          toolAttempt,
          resolution.providerReceiptId,
          this.#retryAfterMs,
        );
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

  async #executeGoalToolCalls(
    claim: WorkItemClaim,
    calls: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[],
    startingSequence: number,
  ): Promise<RuntimeWorkerOutcome | null> {
    let sequence = startingSequence;
    for (const event of calls) {
      const result = await this.#execution.executeGoalTool(claim, event);
      await this.#afterGoalToolExecuted?.(result);
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
    const visible = modelVisibleToolOutput(result.output);
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
    const head = await this.#store.loadModelHistoryHead({
      tenantId: run.tenantId,
      threadId: run.threadId,
    });
    if (head === null) {
      throw new PermanentWorkerError("model_history_not_found");
    }
    const items: ModelHistoryItem[] = [];
    let cursor = 0;
    while (items.length < MAX_DURABLE_HISTORY_ITEMS) {
      const page = await this.#store.listModelHistoryItems(
        { tenantId: run.tenantId, threadId: run.threadId },
        cursor,
        Math.min(HISTORY_PAGE_SIZE, MAX_DURABLE_HISTORY_ITEMS - items.length),
      );
      if (page.length === 0) {
        break;
      }
      for (const item of page) {
        items.push(item);
        cursor = item.sequence;
      }
      if (page.length < HISTORY_PAGE_SIZE) {
        break;
      }
    }
    if (cursor !== head.lastSequence || items.length !== head.lastSequence) {
      throw new PermanentWorkerError("context_history_limit_exceeded");
    }
    const last = items.at(-1);
    if (
      last === undefined ||
      !(
        (last.type === "message" &&
          (last.role === "user" || options.allowAssistantBoundary === true)) ||
        last.runId === run.runId
      )
    ) {
      throw new PermanentWorkerError("context_last_turn_boundary_invalid");
    }
    try {
      return projectModelHistory(items, {
        maxItems: MAX_DURABLE_HISTORY_ITEMS,
        maxBytes: MAX_DURABLE_HISTORY_BYTES,
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
      await this.#execution.confirmCanceled(claim, attempt);
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
    const lease = await this.#store.renewWorkItemLease({
      ...leaseInput(claim),
      leaseDurationMs: this.#leaseDurationMs,
    });
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

function modelDispatchEvidenceStore(
  store: DomainStore,
): ModelDispatchEvidenceStore | null {
  const candidate = store as DomainStore & Partial<ModelDispatchEvidenceStore>;
  return typeof candidate.prepareModelDispatch === "function" &&
    typeof candidate.markModelDispatchPossiblySent === "function" &&
    typeof candidate.loadModelDispatchReceipt === "function"
    ? (candidate as ModelDispatchEvidenceStore)
    : null;
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
    error instanceof ApplicationError &&
    (error.code === "stale_lease" || error.code === "lease_expired")
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
