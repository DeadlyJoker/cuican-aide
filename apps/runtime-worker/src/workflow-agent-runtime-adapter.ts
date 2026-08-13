import { AgentKernelError } from "@crewon/agent-kernel";
import type {
  DomainStore,
  DurableQueueStore,
  RunExecutionService,
  WorkflowRuntimeStore,
} from "@crewon/application";
import type {
  ModelDispatchReceipt,
  ToolExecutionReceiptState,
  WorkflowSchemaValue,
} from "@crewon/domain";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";
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
import { WorkflowNodeSideEffectUncertainError } from "./workflow-runtime-dispatcher.ts";
import { loadPendingToolEventsForSegment } from "./pending-tool-events.ts";
import {
  workflowAttemptAuthority,
  workflowContinuationCheckpoint,
  type WorkflowDurableExecutionAuthority,
} from "./workflow-agent-durable-continuation.ts";
import {
  decideWorkflowNodeExecutionError,
  decideWorkflowNodeSegment,
  prepareWorkflowNodeExecution,
  type WorkflowNodeEffectCertainty,
} from "./workflow-node-execution-policy.ts";

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
  Readonly<{ continuationState: WorkflowAgentContinuationState }>;
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

  async #execute(input: WorkflowAgentEngineInput): Promise<WorkflowNodeOutcome> {
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
    const storedAttempt = await this.#store.loadRunAttempt({
      tenantId: authority.tenantId,
      runId: authority.runId,
      ...attempt,
    });
    const storedStep = await this.#store.loadRunStep({
      tenantId: authority.tenantId,
      runId: authority.runId,
      stepId: authority.stepId,
    });
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
    const toolRoundsConsumed =
      continuationState?.toolRoundsConsumed ?? 0;
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
          runtimeTools: runtime.version.tools,
          history: continuationState?.history ?? [
            ...(runtime.governedContext?.modelItems() ?? []),
            ...prepared.history,
          ],
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
      const assistantHistory = [
        ...priorHistory,
        ...(executed.segment.assistantContinuation === null
          ? []
          : [
              {
                type: "message" as const,
                role: "assistant" as const,
                content: executed.segment.assistantContinuation.data.output,
              },
            ]),
        ...executed.segment.requestedTools.map((event) => ({
          type: "tool_call" as const,
          kind: event.data.kind,
          callId: event.data.callId,
          name: event.data.name,
          input: event.data.input,
        })),
      ];
      let continuationRevision = continuationState?.revision ?? null;
      let terminalCandidateId: string | null = null;
      const currentDispatch = dispatch as ModelDispatchReceipt | null;
      if (currentDispatch?.status === "responseObserved") {
        const committed = await this.#store.commitWorkflowAssistantContinuation(
          {
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
          },
        );
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
          : await this.#executeTools(
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
        ...input,
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
    if (index < 0)
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
    try {
      const tool = await this.#executeTools(
        base as never,
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
          modelSampleIndex: checkpoint.modelSampleIndex + 1,
          toolRoundsConsumed: tool.toolRoundsConsumed,
          history: tool.history,
          continuation:
            checkpoint.providerCheckpoint === null
              ? { kind: "manual" }
              : {
                  kind: "providerCheckpoint",
                  checkpoint: checkpoint.providerCheckpoint,
                  newHistoryStartIndex: continuationHistoryStart(
                    checkpoint.history,
                    pending.requestedCallIds,
                  ),
                },
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

  async #executeTools(
    input: WorkflowAgentExecutionBase,
    requests: readonly Extract<
      import("@crewon/agent-kernel").KernelAgentEvent,
      { type: "tool.requested" }
    >[],
    startingSequence: number,
    signal: AbortSignal,
    continuation: Readonly<{
      segmentId: string;
      modelSampleIndex: number;
      toolRoundsConsumed: number;
      history: readonly import("@crewon/agent-kernel").AgentHistoryItem[];
      revision: number | null;
      dispatch: ModelDispatchReceipt | null;
      providerCheckpoint: import("@crewon/contracts").ProviderCheckpoint | null;
      providerTurnState: string | null;
      nextToolRoundsConsumed: number;
    }>,
    adopted?: Extract<
      import("@crewon/application").WorkflowToolApprovalOutcome,
      { kind: "approved" }
    >,
  ): Promise<
    Readonly<{
      history: readonly import("@crewon/agent-kernel").AgentHistoryItem[];
      revision: number | null;
      toolRoundsConsumed: number;
    }>
  > {
    let currentHistory = continuation.history;
    let sequence = startingSequence;
    let revision = continuation.revision;
    for (const event of requests) {
      const call = event.data;
      const defined = input.runtime.version.tools.some(
        (candidate) =>
          candidate.kind === call.kind && candidate.name === call.name,
      );
      const policy = input.runtime.toolRuntime.executionPolicy(
        call.kind,
        call.name,
      );
      if (!defined || policy === null) {
        throw new Error("tool_execution_policy_missing");
      }
      if (input.node.kind === "humanGate") {
        throw new Error("workflow_human_gate_model_execution_forbidden");
      }
      const prepared =
        adopted?.receipt.call.callId === call.callId
          ? {
              disposition: "existing" as const,
              receipt: adopted.receipt,
              attempt: null,
            }
          : await this.#execution.beginToolExecution(
              input.authority.workItemClaim,
              {
                segmentId: event.segmentId,
                callId: call.callId,
                kind: call.kind,
                name: call.name,
                input: call.input,
              },
              policy,
              {
                kind: "workflowAgentAttempt",
                attempt: {
                  stepId: input.authority.stepId,
                  attemptId: input.authority.attemptId,
                },
                nodeId: input.authority.nodeId,
                nodeKind: input.node.kind,
                claimId: input.authority.claimId,
                claimEpoch: input.authority.claimEpoch,
                agentVersionId: input.authority.agentVersionId,
              },
            );
      let receipt = prepared.receipt;
      let approval: import("@crewon/domain").ToolApprovalState | null =
        adopted?.receipt.call.callId === call.callId ? adopted.approval : null;
      if (policy.approvalRequirement === "perAction" && approval === null) {
        const artifacts = await this.#execution.prepareWorkflowToolApproval(
          input.authority.workItemClaim,
          receipt,
          { expiresAfterMs: this.#approvalTtlMs },
        );
        const published =
          await this.#store.publishWorkflowToolApproval({
            lease: leaseInput(input.authority.workItemClaim),
            binding: input.authority.binding,
            authority: workflowAttemptAuthority(durableAuthority(input)),
            operationId: `workflow-tool-approval:${receipt.actionDigest}`,
            expectedContinuationRevision: revision!,
            receipt,
            ...artifacts,
            approvalRecheckMs: this.#approvalRecheckMs,
          });
        throw new WorkflowToolApprovalWaitingError(
          published.approval.approvalId,
        );
      }
      let toolAttempt =
        adopted?.receipt.call.callId === call.callId
          ? { stepId: receipt.stepId, attemptId: receipt.attemptId }
          : null;
      let resolution: ToolExecutionResolution;
      if (receipt.status === "completed") {
        resolution = completedToolResolution(receipt);
      } else {
        if (toolAttempt === null) {
          const active =
            prepared.attempt ??
            (await this.#execution.beginToolRecovery(
              input.authority.workItemClaim,
              prepared.receipt,
            ));
          toolAttempt = active.attempt;
        }
        const shouldExecute = receipt.status === "prepared";
        if (shouldExecute) {
          receipt = await this.#execution.dispatchToolExecution(
            input.authority.workItemClaim,
            receipt,
          );
        }
        const command = workflowToolCommand(
          receipt,
          call.input,
          input.authority.workItemClaim,
          approval,
        );
        resolution = shouldExecute
          ? await input.runtime.toolRuntime.execute(command, signal)
          : await input.runtime.toolRuntime.reconcile(command, signal);
      }
      if (resolution.status === "unknownOutcome") {
        if (receipt.status !== "unknownOutcome")
          await this.#execution.transitionToolExecution(
            input.authority.workItemClaim,
            receipt,
            {
              kind: "unknownOutcome",
              occurredAt: new Date().toISOString(),
              providerReceiptId: resolution.providerReceiptId,
            },
          );
        throw new WorkflowNodeSideEffectUncertainError();
      }
      if (resolution.status === "canceled") {
        throw new Error("workflow_tool_execution_canceled");
      }
      sequence += 1;
      const completedEvent = {
        schemaVersion: "crewon.agent-event.v0" as const,
        runId: input.authority.runId,
        segmentId: event.segmentId,
        sequence,
        type: "tool.completed" as const,
        data: {
          callId: call.callId,
          kind: call.kind,
          name: call.name,
          output: resolution.result.output,
          isError: resolution.result.isError,
          artifactRef: resolution.result.artifactRef,
          outputTruncated: false,
        },
      };
      if (receipt.status !== "completed") {
        if (toolAttempt === null) {
          throw new Error("workflow_tool_attempt_missing");
        }
        const nextHistory = [
          ...currentHistory,
          {
            type: "tool_result" as const,
            kind: call.kind,
            callId: call.callId,
            output: resolution.result.output,
          },
        ];
        const committed = await this.#store.commitWorkflowToolContinuation({
          lease: leaseInput(input.authority.workItemClaim),
          authority: workflowAttemptAuthority(durableAuthority(input)),
          receipt,
          toolAttempt: {
            stepId: toolAttempt.stepId,
            attemptId: toolAttempt.attemptId,
          },
          completedEvent,
          providerReceiptId: resolution.providerReceiptId,
          expectedContinuationRevision: revision,
          next: workflowContinuationCheckpoint({
            authority: durableAuthority(input),
            segmentId: continuation.segmentId,
            modelSampleIndex: continuation.modelSampleIndex,
            toolRoundsConsumed: continuation.nextToolRoundsConsumed,
            history: nextHistory,
            dispatch: continuation.dispatch,
            providerCheckpoint: continuation.providerCheckpoint,
            providerTurnState: continuation.providerTurnState,
          }),
          committedAt: new Date().toISOString(),
        });
        receipt = committed.receipt;
        revision = committed.continuation.revision;
        currentHistory = committed.continuation.history;
      }
    }
    return {
      history: currentHistory,
      revision,
      toolRoundsConsumed: continuation.nextToolRoundsConsumed,
    };
  }
}

type WorkflowAgentContinuationState = Readonly<{
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  history: readonly import("@crewon/agent-kernel").AgentHistoryItem[];
  continuation: import("@crewon/agent-kernel").AgentContinuation;
  revision: number | null;
}>;

function continuationHistoryStart(
  history: readonly import("@crewon/agent-kernel").AgentHistoryItem[],
  requestedCallIds: readonly string[],
): number {
  const callIds = new Set(requestedCallIds);
  const firstToolCall = history.findIndex(
    (item) => item.type === "tool_call" && callIds.has(item.callId),
  );
  if (firstToolCall < 0)
    throw new Error("workflow_tool_approval_pending_call_missing");
  const prior = history[firstToolCall - 1];
  return prior?.type === "message" && prior.role === "assistant"
    ? firstToolCall - 1
    : firstToolCall;
}

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

class WorkflowToolApprovalWaitingError extends Error {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super("workflow_tool_approval_waiting");
    this.approvalId = approvalId;
  }
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

function workflowToolCommand(
  receipt: ToolExecutionReceiptState,
  input: string,
  claim: Parameters<WorkflowAgentNodePort["execute"]>[0]["workItemClaim"],
  approval: import("@crewon/domain").ToolApprovalState | null,
): ToolExecutionCommand {
  if (receipt.actionIntent === null) {
    throw new Error("tool_action_intent_missing");
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
            decidedAt: approval.decision!.decidedAt,
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

function completedToolResolution(
  receipt: ToolExecutionReceiptState,
): Extract<ToolExecutionResolution, { status: "completed" }> {
  if (receipt.result === null || receipt.providerReceiptId === null) {
    throw new Error("tool_receipt_result_missing");
  }
  return {
    status: "completed",
    executionId: receipt.executionId,
    providerReceiptId: receipt.providerReceiptId,
    result: {
      schemaVersion: "crewon.tool-result.v0",
      callId: receipt.call.callId,
      output: receipt.result.output,
      isError: receipt.result.isError,
      artifactRef: receipt.result.artifactRef,
    },
  };
}
