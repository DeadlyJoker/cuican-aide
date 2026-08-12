import { AgentKernelError } from "@crewon/agent-kernel";
import type {
  DomainStore,
  DurableQueueStore,
  ModelDispatchEvidenceStore,
  RunExecutionService,
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
import {
  decideWorkflowNodeExecutionError,
  decideWorkflowNodeSegment,
  prepareWorkflowNodeExecution,
  type WorkflowNodeEffectCertainty,
} from "./workflow-node-execution-policy.ts";

export interface WorkflowAdmittedAgentExecutionEngine {
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
}

type WorkflowExecutionStore = DomainStore &
  DurableQueueStore &
  Partial<ModelDispatchEvidenceStore>;

/** Executes one already-admitted Workflow Agent attempt without owning root Run settlement. */
export class SharedWorkflowAdmittedAgentExecutionEngine
  implements WorkflowAdmittedAgentExecutionEngine
{
  readonly #execution: RunExecutionService;
  readonly #store: WorkflowExecutionStore;
  readonly #leaseDurationMs: number;
  readonly #segments = new AgentSegmentExecutionEngine();

  constructor(dependencies: {
    execution: RunExecutionService;
    store: WorkflowExecutionStore;
    leaseDurationMs: number;
  }) {
    this.#execution = dependencies.execution;
    this.#store = dependencies.store;
    this.#leaseDurationMs = dependencies.leaseDurationMs;
  }

  async execute(
    input: Parameters<WorkflowAdmittedAgentExecutionEngine["execute"]>[0],
  ): Promise<WorkflowNodeOutcome> {
    const prepared = prepareWorkflowNodeExecution({
      node: input.node,
      inputValue: input.inputValue,
    });
    if (prepared.kind === "settle") return prepared.outcome;
    if (prepared.kind !== "executeSegment") {
      throw new Error("workflow_node_initial_execution_invalid");
    }
    const { authority, runtime } = input;
    const internal = input as typeof input & {
      continuationState?: WorkflowAgentContinuationState;
    };
    const attempt = { stepId: authority.stepId, attemptId: authority.attemptId };
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
      storedAttempt.workItemId !== authority.workItemClaim.workItem.workItemId ||
      storedAttempt.leaseEpoch !== authority.workItemClaim.lease.epoch ||
      storedStep?.status !== "running" ||
      storedStep.currentAttemptId !== authority.attemptId
    ) {
      throw new Error("workflow_node_attempt_not_running");
    }
    await this.#execution.loadRun(authority.workItemClaim);
    const round = internal.continuationState?.round ?? 0;
    if (round >= runtime.version.execution.maxToolRounds) {
      return { status: "failed", failureCode: "model_tool_round_limit_exceeded" };
    }
    const segmentId =
      round === 0
        ? `segment:${authority.attemptId}`
        : `segment:${authority.attemptId}:round:${round + 1}`;
    const dispatchStore = modelDispatchStore(runtime, this.#store);
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
          history:
            internal.continuationState?.history ??
            [
              ...(runtime.governedContext?.modelItems() ?? []),
              ...prepared.history,
            ],
          continuation:
            internal.continuationState?.continuation ?? { kind: "manual" },
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
            this.#execution.recordProviderTurnState(
              authority.workItemClaim,
              attempt,
              providerTurnState,
            ).then(() => undefined),
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
      if (decision.kind === "settle") return decision.outcome;
      if (
        executed.segment.requestedTools.length === 0 &&
        executed.segment.assistantContinuation === null
      ) {
        throw new Error("workflow_node_continuation_not_settled");
      }
      const toolHistory =
        executed.segment.requestedTools.length === 0
          ? []
          : await this.#executeTools(
              input,
              executed.segment.requestedTools,
              executed.segment.lastAgentSequence,
              controller.signal,
            );
      const priorHistory =
        internal.continuationState?.history ??
        [
          ...(runtime.governedContext?.modelItems() ?? []),
          ...prepared.history,
        ];
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
      return this.execute({
        ...input,
        continuationState: {
          round: round + 1,
          history: [
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
            ...toolHistory,
          ],
          continuation,
        },
      } as typeof input);
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
      return decideWorkflowNodeExecutionError({
        error,
        effectCertainty,
      }).outcome;
    } finally {
      await cancellationWatcher.close();
      await heartbeat.close();
    }
  }

  async #executeTools(
    input: Parameters<WorkflowAdmittedAgentExecutionEngine["execute"]>[0],
    requests: readonly Extract<
      import("@crewon/agent-kernel").KernelAgentEvent,
      { type: "tool.requested" }
    >[],
    startingSequence: number,
    signal: AbortSignal,
  ): Promise<import("@crewon/agent-kernel").AgentHistoryItem[]> {
    const history: import("@crewon/agent-kernel").AgentHistoryItem[] = [];
    let sequence = startingSequence;
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
      if (policy.approvalRequirement === "perAction") {
        throw new Error("workflow_tool_approval_handoff_required");
      }
      if (input.node.kind === "humanGate") {
        throw new Error("workflow_human_gate_model_execution_forbidden");
      }
      const prepared = await this.#execution.beginToolExecution(
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
      const toolAttempt =
        prepared.attempt ??
        (await this.#execution.beginToolRecovery(
          input.authority.workItemClaim,
          prepared.receipt,
        ));
      let receipt = prepared.receipt;
      let resolution: ToolExecutionResolution;
      if (receipt.status === "completed") {
        resolution = completedToolResolution(receipt);
      } else {
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
        );
        resolution = shouldExecute
          ? await input.runtime.toolRuntime.execute(command, signal)
          : await input.runtime.toolRuntime.reconcile(command, signal);
      }
      if (resolution.status === "unknownOutcome") {
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
        await this.#execution.commitToolExecutionCompletion(
          input.authority.workItemClaim,
          receipt,
          {
            stepId: toolAttempt.attempt.stepId,
            attemptId: toolAttempt.attempt.attemptId,
          },
          completedEvent,
          resolution.providerReceiptId,
        );
      }
      history.push(
        {
          type: "tool_call",
          kind: call.kind,
          callId: call.callId,
          name: call.name,
          input: call.input,
        },
        {
          type: "tool_result",
          kind: call.kind,
          callId: call.callId,
          output: resolution.result.output,
        },
      );
    }
    return history;
  }
}

type WorkflowAgentContinuationState = Readonly<{
  round: number;
  history: readonly import("@crewon/agent-kernel").AgentHistoryItem[];
  continuation: import("@crewon/agent-kernel").AgentContinuation;
}>;

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
      },
      inputValue: input.inputValue,
      node: input.node,
    });
  }
}

function modelDispatchStore(
  runtime: AgentVersionRuntime,
  store: WorkflowExecutionStore,
): ModelDispatchEvidenceStore {
  if (
    runtime.kernel.supportsModelDispatchEvidence !== true ||
    typeof store.prepareModelDispatch !== "function" ||
    typeof store.markModelDispatchPossiblySent !== "function" ||
    typeof store.loadModelDispatchReceipt !== "function"
  ) {
    throw new Error("model_dispatch_evidence_store_missing");
  }
  return store as ModelDispatchEvidenceStore;
}

function leaseInput(claim: Parameters<WorkflowAgentNodePort["execute"]>[0]["workItemClaim"]) {
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
    approvalProof: null,
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
