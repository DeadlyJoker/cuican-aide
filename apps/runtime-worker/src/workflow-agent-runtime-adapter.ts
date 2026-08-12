import { AgentKernelError } from "@crewon/agent-kernel";
import type {
  DomainStore,
  DurableQueueStore,
  ModelDispatchEvidenceStore,
  RunExecutionService,
} from "@crewon/application";
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
    const segmentId = `segment:${authority.attemptId}`;
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
          allowedTools: null,
          runtimeTools: [],
          history: [
            ...(runtime.governedContext?.modelItems() ?? []),
            ...prepared.history,
          ],
          continuation: { kind: "manual" },
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
      throw new Error("workflow_node_continuation_not_settled");
    } catch (error) {
      if (heartbeat.failure() !== null) throw heartbeat.failure();
      if (cancellationWatcher.failure() !== null) {
        throw cancellationWatcher.failure();
      }
      if (cancellationWatcher.cancellationRequested()) {
        return { status: "canceled" };
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
