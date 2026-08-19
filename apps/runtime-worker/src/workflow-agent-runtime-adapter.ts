import { AgentKernelError } from "@crewon/agent-kernel/runtime";
import type {
  DomainStore,
  DurableQueueStore,
  RunExecutionService,
  WorkflowAtomicNodeOutcome,
  WorkflowNodeResponseRecovery,
  WorkflowRuntimeStore,
} from "@crewon/application";
import { canonicalJson } from "@crewon/application";
import type { ModelDispatchReceipt, WorkflowSchemaValue } from "@crewon/domain";
import { AgentSegmentExecutionEngine } from "./agent-segment-execution-engine.ts";
import {
  CancellationWatcher,
  LeaseHeartbeat,
  systemRuntimeWorkerScheduler,
} from "./runtime-worker-watchers.ts";
import type {
  AgentVersionRuntime,
  AgentVersionRuntimeResolverPort,
} from "./agent-version-runtime.ts";
import type {
  WorkflowAgentNodePort,
  WorkflowNodeOutcome,
} from "./workflow-runtime-dispatcher.ts";
import {
  WorkflowNodeDurabilityUncertainError,
  WorkflowNodeSideEffectUncertainError,
} from "./workflow-runtime-dispatcher.ts";
import {
  loadPendingToolEventsForSegment,
  workflowContinuationHistoryStart,
} from "./pending-tool-events.ts";
import {
  executeWorkflowTools,
  WorkflowToolApprovalWaitingError,
} from "./workflow-agent-tool-execution.ts";
import {
  workflowAttemptAuthority,
  workflowContinuationCheckpoint,
  type WorkflowDurableExecutionAuthority,
} from "./workflow-agent-durable-continuation.ts";
import {
  prepareWorkflowAgentContinuationResume,
  type WorkflowAgentResumeExecutionInput,
} from "./workflow-agent-continuation-resume.ts";
import {
  decideWorkflowNodeExecutionError,
  decideWorkflowNodeSegment,
  prepareWorkflowNodeExecution,
  type WorkflowNodeEffectCertainty,
} from "./workflow-node-execution-policy.ts";
import {
  projectWorkflowModelVisibleText,
  validateWorkflowModelHistory,
} from "./workflow-agent-value-projection.ts";

export interface WorkflowAdmittedAgentExecutionEngine {
  readonly workflowStore: import("@crewon/application").WorkflowRuntimeStore;
  execute(input: {
    runtime: AgentVersionRuntime;
    authority: {
      tenantId: string;
      runId: string;
      nodeId: string;
      agentVersionId: string;
      claimId: string;
      claimEpoch: number;
      stepId: string;
      attemptId: string;
      workItemClaim: Parameters<
        WorkflowAgentNodePort["execute"]
      >[0]["workItemClaim"];
      binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
    };
    inputValue: Parameters<WorkflowAgentNodePort["execute"]>[0]["inputValue"];
    node: Parameters<WorkflowAgentNodePort["execute"]>[0]["node"];
  }): Promise<
    | Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
    | Exclude<
        WorkflowNodeOutcome,
        Readonly<{ status: "completed"; value: WorkflowSchemaValue }>
      >
  >;
  reconcile(input: {
    runtime: AgentVersionRuntime;
    claim: Parameters<WorkflowAgentNodePort["reconcile"]>[0]["claim"];
    binding: Parameters<WorkflowAgentNodePort["reconcile"]>[0]["binding"];
    recovery: WorkflowNodeResponseRecovery;
  }): Promise<WorkflowAtomicNodeOutcome>;
  resume(input: {
    runtime: AgentVersionRuntime;
    claim: Parameters<WorkflowAgentNodePort["resume"]>[0]["claim"];
    binding: Parameters<WorkflowAgentNodePort["resume"]>[0]["binding"];
    node: Parameters<WorkflowAgentNodePort["resume"]>[0]["node"];
    resume: Parameters<WorkflowAgentNodePort["resume"]>[0]["resume"];
  }): Promise<WorkflowNodeOutcome>;
  resumeToolApproval(input: {
    runtime: AgentVersionRuntime;
    claim: Parameters<WorkflowAgentNodePort["execute"]>[0]["workItemClaim"];
    binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
    node: Parameters<WorkflowAgentNodePort["execute"]>[0]["node"];
    payload: Extract<
      import("./workflow-work-item-payload.ts").WorkflowWorkItemPayload,
      { trigger: "workflowToolApprovalResume" }
    >;
  }): Promise<WorkflowNodeOutcome>;
}

type WorkflowAgentExecutionInput = Parameters<
  WorkflowAdmittedAgentExecutionEngine["execute"]
>[0];
type WorkflowAgentExecutionBase = Omit<
  WorkflowAgentExecutionInput,
  "inputValue"
>;
type WorkflowAgentContinuationExecutionInput = WorkflowAgentExecutionBase &
  Readonly<{
    continuationState: WorkflowAgentContinuationState;
    adopted?: WorkflowAgentResumeExecutionInput["adopted"];
  }>;
type WorkflowAgentEngineInput =
  | WorkflowAgentExecutionInput
  | WorkflowAgentContinuationExecutionInput;

type RuntimeWorkerStore = DomainStore &
  DurableQueueStore &
  WorkflowRuntimeStore;

/** Executes one already-admitted Workflow Agent attempt without owning root Run settlement. */
export class SharedWorkflowAdmittedAgentExecutionEngine
  implements WorkflowAdmittedAgentExecutionEngine
{
  readonly #execution: RunExecutionService;
  readonly #store: RuntimeWorkerStore;
  readonly #leaseDurationMs: number;
  readonly #segments = new AgentSegmentExecutionEngine();
  readonly #afterTerminalCandidateCommitted?: () => Promise<void>;
  readonly #approvalTtlMs: number | null;
  readonly #approvalRecheckMs: number;

  get workflowStore(): WorkflowRuntimeStore {
    return this.#store;
  }

  constructor(dependencies: {
    execution: RunExecutionService;
    store: RuntimeWorkerStore;
    leaseDurationMs: number;
    afterTerminalCandidateCommitted?: () => Promise<void>;
    approvalTtlMs?: number | null;
    approvalRecheckMs?: number;
  }) {
    this.#execution = dependencies.execution;
    this.#store = dependencies.store;
    this.#leaseDurationMs = dependencies.leaseDurationMs;
    this.#afterTerminalCandidateCommitted =
      dependencies.afterTerminalCandidateCommitted;
    this.#approvalTtlMs = dependencies.approvalTtlMs ?? 15 * 60_000;
    this.#approvalRecheckMs = dependencies.approvalRecheckMs ?? 1_000;
  }

  async execute(
    input: Parameters<WorkflowAdmittedAgentExecutionEngine["execute"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    return this.#execute(input);
  }

  async resume(
    input: Parameters<WorkflowAdmittedAgentExecutionEngine["resume"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const prepared = await prepareWorkflowAgentContinuationResume(
      {
        execution: this.#execution,
        store: this.#store,
        approvalTtlMs: this.#approvalTtlMs,
        approvalRecheckMs: this.#approvalRecheckMs,
      },
      input,
    );
    return prepared.kind === "outcome"
      ? prepared.outcome
      : this.#execute(prepared.input);
  }

  async reconcile(
    input: Parameters<WorkflowAdmittedAgentExecutionEngine["reconcile"]>[0],
  ): Promise<WorkflowAtomicNodeOutcome> {
    const { claim, recovery, runtime } = input;
    const node = recovery.claim.node;
    const attempt = recovery.attempt;
    const storedAttempt = await this.#store.loadRunAttempt({
      tenantId: attempt.tenantId,
      runId: attempt.runId,
      stepId: attempt.stepId,
      attemptId: attempt.attemptId,
    });
    const storedStep = await this.#store.loadRunStep({
      tenantId: recovery.step.tenantId,
      runId: recovery.step.runId,
      stepId: recovery.step.stepId,
    });
    const storedDispatch = await this.#store.loadModelDispatchReceipt({
      tenantId: recovery.dispatch.tenantId,
      runId: recovery.dispatch.runId,
      stepId: recovery.dispatch.stepId,
      attemptId: recovery.dispatch.attemptId,
      operationId: recovery.dispatch.operationId,
    });
    if (
      canonicalJson(storedAttempt) !== canonicalJson(attempt) ||
      canonicalJson(storedStep) !== canonicalJson(recovery.step) ||
      canonicalJson(storedDispatch) !== canonicalJson(recovery.dispatch) ||
      attempt.status !== "running" ||
      attempt.providerCheckpoint === null ||
      attempt.checkpointDigest !== recovery.dispatch.responseCheckpointDigest ||
      recovery.dispatch.operation !== "dispatch" ||
      recovery.dispatch.status !== "responseObserved" ||
      recovery.dispatch.provider.agentVersionId !==
        runtime.version.agentVersionId ||
      recovery.dispatch.provider.adapterName !==
        runtime.kernel.modelIdentity.adapterName ||
      recovery.dispatch.provider.adapterVersion !==
        runtime.kernel.modelIdentity.adapterVersion ||
      recovery.dispatch.provider.modelId !==
        runtime.kernel.modelIdentity.modelId ||
      attempt.tenantId !== claim.workItem.tenantId ||
      attempt.runId !== claim.workItem.runId
    )
      throw new Error("workflow_response_retrieve_authority_mismatch");
    const prepared = prepareWorkflowNodeExecution({
      node,
      inputValue: recovery.inputValue,
    });
    if (prepared.kind !== "executeSegment")
      return prepared.kind === "settle"
        ? (prepared.outcome as WorkflowAtomicNodeOutcome)
        : { status: "unknown" };
    await this.#execution.loadRun(claim);
    const controller = new AbortController();
    const renewLease = async () => {
      await this.#store.renewWorkItemLease({
        ...leaseInput(claim),
        leaseDurationMs: this.#leaseDurationMs,
      });
    };
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      renewLease,
      controller,
    );
    const cancellationWatcher = new CancellationWatcher(
      Math.max(1, Math.floor(this.#leaseDurationMs / 6)),
      () => this.#execution.loadRun(claim),
      controller,
      systemRuntimeWorkerScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    try {
      const executed = await this.#segments.execute({
        kernel: runtime.kernel,
        contract: {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: attempt.runId,
          segmentId: `reconcile:${attempt.attemptId}`,
          attempt: attempt.attemptNumber,
          agentVersionId: runtime.version.agentVersionId,
          policySnapshotId: runtime.version.policySnapshotId,
          collaborationMode: "default",
          allowedTools: runtime.version.tools.map(({ kind, name }) => ({
            kind,
            name,
          })),
          history: validateWorkflowModelHistory([
            ...(runtime.governedContext?.modelItems() ?? []),
            ...prepared.history,
          ]),
          continuation: { kind: "manual" },
          reconcileCheckpoint: attempt.providerCheckpoint,
          ...(attempt.providerTurnState === null
            ? {}
            : { providerTurnState: attempt.providerTurnState }),
          budget: { maxOutputBytes: 32 * 1024 },
        },
        signal: controller.signal,
        providerTurnState: attempt.providerTurnState,
        authority: {
          renewLease,
          cancellationRequested: async () =>
            (await this.#execution.loadRun(claim)).cancelRequested,
          checkpointProviderResponse: async (checkpoint) => {
            if (
              canonicalJson(checkpoint) !==
              canonicalJson(attempt.providerCheckpoint)
            )
              throw new Error("workflow_response_retrieve_checkpoint_mismatch");
          },
          persistImmediateEvent: async () => undefined,
          recordProviderTurnState: async (providerTurnState) => {
            if (providerTurnState !== attempt.providerTurnState)
              throw new Error("workflow_response_retrieve_turn_state_mismatch");
          },
        },
      });
      if (heartbeat.failure() !== null) throw heartbeat.failure();
      if (cancellationWatcher.failure() !== null)
        throw cancellationWatcher.failure();
      if (executed.canceled || cancellationWatcher.cancellationRequested())
        return { status: "canceled" };
      if (
        executed.segment.requestedTools.length !== 0 ||
        executed.segment.assistantContinuation !== null
      )
        throw new Error("workflow_response_retrieve_nonterminal");
      const failure = executed.segment.bufferedEvents.find(
        (event) => event.type === "segment.failed",
      );
      const decision = decideWorkflowNodeSegment(node, {
        output: executed.segment.output,
        completed: executed.segment.completed,
        providerCheckpoint: executed.segment.providerCheckpoint,
        bufferedEvents: [],
        requestedTools: [],
        assistantContinuation: null,
        failure: failure?.type === "segment.failed" ? failure.data : null,
        canceled: executed.canceled,
        effectCertainty: "responseObserved",
      });
      if (decision.kind !== "settle")
        throw new Error("workflow_response_retrieve_nonterminal");
      return decision.outcome as WorkflowAtomicNodeOutcome;
    } finally {
      await cancellationWatcher.close();
      await heartbeat.close();
    }
  }

  async #execute(
    input: WorkflowAgentEngineInput,
  ): Promise<WorkflowNodeOutcome> {
    const isContinuation = "continuationState" in input;
    const continuationState = isContinuation
      ? input.continuationState
      : undefined;
    const prepared = isContinuation
      ? { kind: "executeSegment" as const, history: [] }
      : prepareWorkflowNodeExecution({
          node: input.node,
          inputValue: input.inputValue,
        });
    if (prepared.kind === "settle") return prepared.outcome;
    if (prepared.kind !== "executeSegment") {
      throw new Error("workflow_node_initial_execution_invalid");
    }
    const { authority, runtime } = input;
    const attempt = {
      stepId: authority.stepId,
      attemptId: authority.attemptId,
    };
    const storedAttempt =
      (isContinuation ? input.adopted?.attempt : undefined) ??
      (await this.#store.loadRunAttempt({
        tenantId: authority.tenantId,
        runId: authority.runId,
        ...attempt,
      }));
    const storedStep =
      (isContinuation ? input.adopted?.step : undefined) ??
      (await this.#store.loadRunStep({
        tenantId: authority.tenantId,
        runId: authority.runId,
        stepId: authority.stepId,
      }));
    if (
      storedAttempt?.status !== "running" ||
      storedAttempt.tenantId !== authority.tenantId ||
      storedAttempt.runId !== authority.runId ||
      storedAttempt.stepId !== authority.stepId ||
      storedAttempt.workItemId !==
        authority.workItemClaim.workItem.workItemId ||
      storedAttempt.leaseEpoch !== authority.workItemClaim.lease.epoch ||
      storedStep?.status !== "running" ||
      storedStep.currentAttemptId !== authority.attemptId
    ) {
      throw new Error("workflow_node_attempt_not_running");
    }
    await this.#execution.loadRun(authority.workItemClaim);
    const modelSampleIndex = continuationState?.modelSampleIndex ?? 0;
    const toolRoundsConsumed = continuationState?.toolRoundsConsumed ?? 0;
    const segmentId =
      modelSampleIndex === 0
        ? `segment:${authority.attemptId}`
        : `segment:${authority.attemptId}:round:${modelSampleIndex + 1}`;
    if (runtime.kernel.supportsModelDispatchEvidence !== true) {
      throw new Error("model_dispatch_evidence_unsupported");
    }
    const dispatchStore = this.#store;
    let dispatch: ModelDispatchReceipt | null = null;
    let effectCertainty: WorkflowNodeEffectCertainty = "notSent";
    const controller = new AbortController();
    const renewLease = async () => {
      await this.#store.renewWorkItemLease({
        ...leaseInput(authority.workItemClaim),
        leaseDurationMs: this.#leaseDurationMs,
      });
    };
    const heartbeat = new LeaseHeartbeat(
      Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
      renewLease,
      controller,
    );
    const cancellationWatcher = new CancellationWatcher(
      Math.max(1, Math.floor(this.#leaseDurationMs / 6)),
      () => this.#execution.loadRun(authority.workItemClaim),
      controller,
      systemRuntimeWorkerScheduler,
    );
    heartbeat.start();
    cancellationWatcher.start();
    try {
      const executed = await this.#segments.execute({
        kernel: runtime.kernel,
        contract: {
          schemaVersion: "crewon.agent-segment.v0",
          purpose: "agent",
          runId: authority.runId,
          segmentId,
          attempt: storedAttempt.attemptNumber,
          agentVersionId: authority.agentVersionId,
          policySnapshotId: runtime.version.policySnapshotId,
          collaborationMode: "default",
          allowedTools: runtime.version.tools.map(({ kind, name }) => ({
            kind,
            name,
          })),
          history: validateWorkflowModelHistory(
            continuationState?.history ?? [
              ...(runtime.governedContext?.modelItems() ?? []),
              ...prepared.history,
            ],
          ),
          continuation: continuationState?.continuation ?? {
            kind: "manual",
          },
          ...(storedAttempt.providerTurnState === null
            ? {}
            : { providerTurnState: storedAttempt.providerTurnState }),
          budget: { maxOutputBytes: 32 * 1024 },
        },
        signal: controller.signal,
        providerTurnState: storedAttempt.providerTurnState,
        authority: {
          renewLease,
          cancellationRequested: async () =>
            (await this.#execution.loadRun(authority.workItemClaim))
              .cancelRequested,
          checkpointProviderResponse: async (checkpoint) => {
            if (dispatch === null) {
              throw new AgentKernelError(
                "model_dispatch_preparation_missing",
                false,
              );
            }
            await this.#execution.checkpointModelAttempt(
              authority.workItemClaim,
              attempt,
              checkpoint,
              dispatch === null
                ? undefined
                : {
                    operationId: dispatch.operationId,
                    requestSequence: dispatch.requestSequence,
                    expectedRevision: dispatch.revision,
                  },
            );
            effectCertainty = "responseObserved";
            if (dispatch !== null) {
              dispatch = await dispatchStore.loadModelDispatchReceipt({
                tenantId: authority.tenantId,
                runId: authority.runId,
                ...attempt,
                operationId: dispatch.operationId,
              });
            }
          },
          persistImmediateEvent: async (event) => {
            await this.#execution.recordAgentEvent(
              authority.workItemClaim,
              event,
            );
          },
          recordProviderTurnState: (providerTurnState) =>
            this.#execution
              .recordProviderTurnState(
                authority.workItemClaim,
                attempt,
                providerTurnState,
              )
              .then(() => undefined),
        },
        controlSink: {
          modelRequestPrepared: async (evidence) => {
            dispatch = await dispatchStore.prepareModelDispatch({
              tenantId: authority.tenantId,
              runId: authority.runId,
              lease: leaseInput(authority.workItemClaim),
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
            if (
              dispatch === null ||
              dispatch.operationId !== evidence.operationId ||
              dispatch.requestDigest !== evidence.requestDigest
            ) {
              throw new AgentKernelError(
                "model_dispatch_preparation_missing",
                false,
              );
            }
            dispatch = await dispatchStore.markModelDispatchPossiblySent({
              tenantId: authority.tenantId,
              runId: authority.runId,
              lease: leaseInput(authority.workItemClaim),
              attempt,
              operationId: evidence.operationId,
              requestSequence: evidence.requestSequence,
              expectedRevision: dispatch.revision,
              transitionedAt: new Date().toISOString(),
            });
            effectCertainty = "possiblySentWithoutResponse";
          },
        },
      });
      if (heartbeat.failure() !== null) throw heartbeat.failure();
      if (cancellationWatcher.failure() !== null) {
        throw cancellationWatcher.failure();
      }
      if (executed.canceled || cancellationWatcher.cancellationRequested()) {
        return { status: "canceled" };
      }
      for (const event of executed.segment.bufferedEvents) {
        await this.#execution.recordAgentEvent(authority.workItemClaim, event);
      }
      const failure = executed.segment.bufferedEvents.find(
        (event) => event.type === "segment.failed",
      );
      const decision = decideWorkflowNodeSegment(input.node, {
        output: executed.segment.output,
        completed: executed.segment.completed,
        providerCheckpoint: executed.segment.providerCheckpoint,
        bufferedEvents: [],
        requestedTools: executed.segment.requestedTools,
        assistantContinuation: executed.segment.assistantContinuation,
        failure: failure?.type === "segment.failed" ? failure.data : null,
        canceled: executed.canceled,
        effectCertainty,
      });
      const priorHistory = continuationState?.history ?? [
        ...(runtime.governedContext?.modelItems() ?? []),
        ...prepared.history,
      ];
      const assistantHistory = validateWorkflowModelHistory([
        ...priorHistory,
        ...(executed.segment.assistantContinuation === null
          ? []
          : [
              {
                type: "message" as const,
                role: "assistant" as const,
                content: projectWorkflowModelVisibleText(
                  executed.segment.assistantContinuation.data.output,
                ).content,
              },
            ]),
        ...executed.segment.requestedTools.map((event) => ({
          type: "tool_call" as const,
          kind: event.data.kind,
          callId: event.data.callId,
          name: event.data.name,
          input: event.data.input,
        })),
      ]);
      let continuationRevision = continuationState?.revision ?? null;
      let terminalCandidateId: string | null = null;
      const currentDispatch = dispatch as ModelDispatchReceipt | null;
      if (currentDispatch?.status === "responseObserved") {
        let committed;
        try {
          committed = await this.#store.commitWorkflowAssistantContinuation({
            lease: leaseInput(authority.workItemClaim),
            authority: workflowAttemptAuthority(durableAuthority(input)),
            expectedContinuationRevision: continuationRevision,
            next: workflowContinuationCheckpoint({
              authority: durableAuthority(input),
              segmentId,
              modelSampleIndex,
              toolRoundsConsumed,
              history: assistantHistory,
              dispatch: currentDispatch,
              providerCheckpoint: executed.segment.providerCheckpoint,
              providerTurnState: executed.segment.providerTurnState,
            }),
            committedAt: new Date().toISOString(),
            terminalResult:
              decision.kind === "settle" &&
              decision.outcome.status === "completed"
                ? { status: "completed", output: executed.segment.output! }
                : decision.kind === "settle" &&
                    decision.outcome.status === "failed"
                  ? {
                      status: "failed",
                      failureCode: decision.outcome.failureCode,
                    }
                  : decision.kind === "settle" &&
                      decision.outcome.status === "canceled"
                    ? { status: "canceled" }
                    : null,
          });
        } catch (error) {
          throw new WorkflowNodeDurabilityUncertainError(error);
        }
        continuationRevision = committed.revision;
        terminalCandidateId = committed.terminalCandidate?.candidateId ?? null;
        if (terminalCandidateId !== null)
          await this.#afterTerminalCandidateCommitted?.();
      }
      if (decision.kind === "settle") {
        if (
          decision.outcome.status === "unknown" ||
          decision.outcome.status === "waitingApproval" ||
          decision.outcome.status === "terminalCandidate"
        ) {
          return decision.outcome;
        }
        return terminalCandidateId === null
          ? { status: "unknown" }
          : {
              status: "terminalCandidate",
              terminalStatus: decision.outcome.status,
              modelTerminal: { candidateId: terminalCandidateId },
            };
      }
      if (
        executed.segment.requestedTools.length === 0 &&
        executed.segment.assistantContinuation === null
      ) {
        throw new Error("workflow_node_continuation_not_settled");
      }
      if (
        executed.segment.requestedTools.length > 0 &&
        toolRoundsConsumed >= runtime.version.execution.maxToolRounds
      ) {
        return {
          status: "failed",
          failureCode: "model_tool_round_limit_exceeded",
        };
      }
      const toolContinuation =
        executed.segment.requestedTools.length === 0
          ? {
              history: assistantHistory,
              revision: continuationRevision,
              toolRoundsConsumed,
            }
          : await executeWorkflowTools(
              {
                execution: this.#execution,
                store: this.#store,
                approvalTtlMs: this.#approvalTtlMs,
                approvalRecheckMs: this.#approvalRecheckMs,
              },
              input,
              executed.segment.requestedTools,
              executed.segment.lastAgentSequence,
              controller.signal,
              {
                segmentId,
                modelSampleIndex,
                toolRoundsConsumed,
                history: assistantHistory,
                revision: continuationRevision,
                dispatch: currentDispatch,
                providerCheckpoint: executed.segment.providerCheckpoint,
                providerTurnState: executed.segment.providerTurnState,
                nextToolRoundsConsumed: toolRoundsConsumed + 1,
              },
            );
      const checkpoint =
        executed.segment.assistantContinuation?.data.checkpoint ??
        executed.segment.providerCheckpoint;
      const continuation =
        checkpoint === null
          ? ({ kind: "manual" } as const)
          : ({
              kind: "providerCheckpoint" as const,
              checkpoint,
              newHistoryStartIndex: priorHistory.length,
            } as const);
      await cancellationWatcher.close();
      await heartbeat.close();
      return this.#execute({
        runtime: input.runtime,
        authority: input.authority,
        node: input.node,
        continuationState: {
          modelSampleIndex: modelSampleIndex + 1,
          toolRoundsConsumed: toolContinuation.toolRoundsConsumed,
          history: [...toolContinuation.history],
          continuation,
          revision: toolContinuation.revision,
        },
      });
    } catch (error) {
      if (heartbeat.failure() !== null) throw heartbeat.failure();
      if (cancellationWatcher.failure() !== null) {
        throw cancellationWatcher.failure();
      }
      if (cancellationWatcher.cancellationRequested()) {
        return { status: "canceled" };
      }
      if (error instanceof WorkflowNodeSideEffectUncertainError) {
        return { status: "unknown" };
      }
      if (error instanceof WorkflowNodeDurabilityUncertainError) {
        return { status: "unknown" };
      }
      if (error instanceof WorkflowToolApprovalWaitingError) {
        return { status: "waitingApproval", approvalId: error.approvalId };
      }
      return decideWorkflowNodeExecutionError({
        error,
        effectCertainty,
      }).outcome;
    } finally {
      await cancellationWatcher.close();
      await heartbeat.close();
    }
  }

  async resumeToolApproval(
    input: Parameters<
      WorkflowAdmittedAgentExecutionEngine["resumeToolApproval"]
    >[0],
  ): Promise<WorkflowNodeOutcome> {
    const { claim, payload } = input;
    const source = {
      tenantId: claim.workItem.tenantId,
      runId: claim.workItem.runId,
      workItemId: payload.agentWorkItemId,
      leaseEpoch: payload.agentLeaseEpoch,
      nodeId: payload.nodeId,
      nodeKind: input.node.kind as "agent" | "verification",
      claimId: payload.claimId,
      claimEpoch: payload.claimEpoch,
      agentVersionId: payload.agentVersionId,
      attempt: { stepId: payload.stepId, attemptId: payload.attemptId },
    };
    let approval = await this.#store.loadToolApproval({
      tenantId: source.tenantId,
      approvalId: payload.approvalId,
    });
    if (approval === null) throw new Error("workflow_tool_approval_missing");
    const run = await this.#execution.loadRun(claim);
    if (approval.status === "required") {
      if (run.cancelRequested)
        approval = await this.#execution.supersedeToolApprovalForCancellation(
          claim,
          approval,
        );
      else {
        const expired = await this.#execution.expireToolApproval(
          claim,
          approval,
        );
        if (expired === null) {
          await this.#store.retryWorkItem({
            ...leaseInput(claim),
            retryAfterMs: this.#approvalRecheckMs,
            reasonCode: "tool_approval_required",
          });
          return { status: "waitingApproval", approvalId: approval.approvalId };
        }
        approval = expired;
      }
    }
    const consumed = await this.#store.consumeWorkflowToolApproval({
      lease: leaseInput(claim),
      binding: input.binding,
      authority: source,
      operationId: `workflow-tool-approval-consume:${payload.approvalId}`,
      approvalId: payload.approvalId,
      actionDigest: payload.actionDigest,
    });
    const outcome = consumed.outcome;
    if (outcome === null)
      throw new Error("workflow_tool_approval_outcome_missing");
    if (outcome.kind === "failed")
      return { status: "failed", failureCode: outcome.failureCode };
    if (outcome.kind === "canceled") return { status: "canceled" };
    const currentReceipt = await this.#store.loadToolExecutionReceipt({
      tenantId: outcome.receipt.tenantId,
      runId: outcome.receipt.runId,
      receiptId: outcome.receipt.receiptId,
    });
    if (
      currentReceipt === null ||
      currentReceipt.actionDigest !== outcome.receipt.actionDigest ||
      currentReceipt.workItemId !== outcome.authority.workItemId ||
      currentReceipt.revision < outcome.receipt.revision
    )
      throw new Error("workflow_tool_approval_receipt_corrupt");
    const adopted = { ...outcome, receipt: currentReceipt };
    const checkpoint = await this.#store.loadWorkflowNodeContinuation(
      outcome.authority,
    );
    if (checkpoint === null)
      throw new Error("workflow_tool_approval_continuation_missing");
    const pending = await loadPendingToolEventsForSegment({
      store: this.#store,
      run: await this.#execution.loadRun(claim),
      segmentId: checkpoint.segmentId,
    });
    const index = pending.events.findIndex(
      (event) => event.data.callId === currentReceipt.call.callId,
    );
    if (currentReceipt.status !== "completed" && index < 0)
      throw new Error("workflow_tool_approval_pending_call_missing");
    const base = {
      runtime: input.runtime,
      authority: {
        tenantId: source.tenantId,
        runId: source.runId,
        nodeId: source.nodeId,
        agentVersionId: source.agentVersionId,
        claimId: source.claimId,
        claimEpoch: source.claimEpoch,
        stepId: source.attempt.stepId,
        attemptId: source.attempt.attemptId,
        workItemClaim: claim,
        binding: input.binding,
      },
      node: input.node,
    };
    const continuationState = {
      modelSampleIndex: checkpoint.modelSampleIndex + 1,
      toolRoundsConsumed: checkpoint.toolRoundsConsumed,
      history: checkpoint.history,
      continuation:
        checkpoint.providerCheckpoint === null
          ? ({ kind: "manual" } as const)
          : ({
              kind: "providerCheckpoint" as const,
              checkpoint: checkpoint.providerCheckpoint,
              newHistoryStartIndex: workflowContinuationHistoryStart(
                checkpoint.history,
                pending.requestedCallIds,
              ),
            } as const),
      revision: checkpoint.revision,
    };
    if (currentReceipt.status === "completed") {
      if (!pending.completedCallIds.includes(currentReceipt.call.callId))
        throw new Error("workflow_tool_approval_completed_event_missing");
      return this.#execute({ ...base, continuationState });
    }
    try {
      const tool = await executeWorkflowTools(
        {
          execution: this.#execution,
          store: this.#store,
          approvalTtlMs: this.#approvalTtlMs,
          approvalRecheckMs: this.#approvalRecheckMs,
        },
        base,
        pending.events.slice(index),
        pending.lastSegmentSequence,
        new AbortController().signal,
        {
          segmentId: checkpoint.segmentId,
          modelSampleIndex: checkpoint.modelSampleIndex,
          toolRoundsConsumed: checkpoint.toolRoundsConsumed,
          history: checkpoint.history,
          revision: checkpoint.revision,
          dispatch: null,
          providerCheckpoint: checkpoint.providerCheckpoint,
          providerTurnState: checkpoint.providerTurnState,
          nextToolRoundsConsumed:
            checkpoint.toolRoundsConsumed +
            (pending.completedCallIds.length === 0 ? 1 : 0),
        },
        adopted,
      );
      return this.#execute({
        ...base,
        continuationState: {
          ...continuationState,
          toolRoundsConsumed: tool.toolRoundsConsumed,
          history: tool.history,
          revision: tool.revision,
        },
      });
    } catch (error) {
      if (error instanceof WorkflowToolApprovalWaitingError)
        return { status: "waitingApproval", approvalId: error.approvalId };
      if (error instanceof WorkflowNodeSideEffectUncertainError)
        return { status: "unknown" };
      throw error;
    }
  }
}

type WorkflowAgentContinuationState = Readonly<{
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  history: readonly import("@crewon/agent-kernel").AgentHistoryItem[];
  continuation: import("@crewon/agent-kernel").AgentContinuation;
  revision: number | null;
}>;

function durableAuthority(
  input: WorkflowAgentExecutionBase,
): WorkflowDurableExecutionAuthority {
  return {
    tenantId: input.authority.tenantId,
    runId: input.authority.runId,
    workItemId: input.authority.workItemClaim.workItem.workItemId,
    leaseEpoch: input.authority.workItemClaim.lease.epoch,
    nodeId: input.authority.nodeId,
    nodeKind: input.node.kind as "agent" | "verification",
    claimId: input.authority.claimId,
    claimEpoch: input.authority.claimEpoch,
    agentVersionId: input.authority.agentVersionId,
    stepId: input.authority.stepId,
    attemptId: input.authority.attemptId,
  };
}

/** Resolves the frozen node AgentVersion and delegates only to an admitted execution engine. */
export class WorkflowAgentRuntimeAdapter implements WorkflowAgentNodePort {
  readonly #runtimes: AgentVersionRuntimeResolverPort;
  readonly #engine: WorkflowAdmittedAgentExecutionEngine;

  constructor(dependencies: {
    runtimes: AgentVersionRuntimeResolverPort;
    engine: WorkflowAdmittedAgentExecutionEngine;
  }) {
    this.#runtimes = dependencies.runtimes;
    this.#engine = dependencies.engine;
  }

  get workflowStore(): WorkflowRuntimeStore {
    return this.#engine.workflowStore;
  }

  async execute(
    input: Parameters<WorkflowAgentNodePort["execute"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const runtime = await this.#runtimes.resolve({
      tenantId: input.tenantId,
      agentVersionId: input.agentVersionId,
    });
    if (
      runtime === null ||
      runtime.version.agentVersionId !== input.agentVersionId
    ) {
      throw new Error("workflow_node_agent_runtime_unavailable");
    }
    return this.#engine.execute({
      runtime,
      authority: {
        tenantId: input.tenantId,
        runId: input.runId,
        nodeId: input.nodeId,
        agentVersionId: input.agentVersionId,
        claimId: input.claimId,
        claimEpoch: input.claimEpoch,
        stepId: input.stepId,
        attemptId: input.attemptId,
        workItemClaim: input.workItemClaim,
        binding: input.binding,
      },
      inputValue: input.inputValue,
      node: input.node,
    });
  }

  async reconcile(
    input: Parameters<WorkflowAgentNodePort["reconcile"]>[0],
  ): Promise<WorkflowAtomicNodeOutcome> {
    const node = input.recovery.claim.node;
    const agentVersionId =
      node.kind === "agent"
        ? node.agentVersionId
        : node.kind === "verification"
          ? node.verifierAgentVersionId
          : null;
    if (
      agentVersionId === null ||
      input.recovery.dispatch.provider.agentVersionId !== agentVersionId
    )
      throw new Error("workflow_response_retrieve_route_mismatch");
    const runtime = await this.#runtimes.resolve({
      tenantId: input.claim.workItem.tenantId,
      agentVersionId,
    });
    if (
      runtime === null ||
      runtime.version.agentVersionId !== agentVersionId ||
      runtime.kernel.modelIdentity.adapterName !==
        input.recovery.dispatch.provider.adapterName ||
      runtime.kernel.modelIdentity.adapterVersion !==
        input.recovery.dispatch.provider.adapterVersion ||
      runtime.kernel.modelIdentity.modelId !==
        input.recovery.dispatch.provider.modelId
    )
      throw new Error("workflow_response_retrieve_route_mismatch");
    return this.#engine.reconcile({ ...input, runtime });
  }

  async resume(
    input: Parameters<WorkflowAgentNodePort["resume"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const agentVersionId = input.resume.continuation.authority.agentVersionId;
    const runtime = await this.#runtimes.resolve({
      tenantId: input.claim.workItem.tenantId,
      agentVersionId,
    });
    if (runtime === null || runtime.version.agentVersionId !== agentVersionId)
      throw new Error("workflow_node_agent_runtime_unavailable");
    return this.#engine.resume({ ...input, runtime });
  }

  async resumeToolApproval(
    input: Parameters<WorkflowAgentNodePort["resumeToolApproval"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const runtime = await this.#runtimes.resolve({
      tenantId: input.claim.workItem.tenantId,
      agentVersionId: input.payload.agentVersionId,
    });
    if (
      runtime === null ||
      runtime.version.agentVersionId !== input.payload.agentVersionId
    )
      throw new Error("workflow_node_agent_runtime_unavailable");
    return this.#engine.resumeToolApproval({ ...input, runtime });
  }
}

function leaseInput(
  claim: Parameters<WorkflowAgentNodePort["execute"]>[0]["workItemClaim"],
) {
  return {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
}
