import type {
  DomainStore,
  DurableQueueStore,
  RunExecutionService,
  WorkflowNodeContinuationResume,
  WorkflowRuntimeStore,
} from "@crewon/application";
import { canonicalJson } from "@crewon/application";
import type {
  AgentContinuation,
  AgentHistoryItem,
} from "@crewon/agent-kernel/runtime";
import type { RunAttemptState, RunStepState } from "@crewon/domain";

import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import {
  executeWorkflowTools,
  WorkflowToolApprovalWaitingError,
} from "./workflow-agent-tool-execution.ts";
import {
  WorkflowNodeSideEffectUncertainError,
  type WorkflowAgentNodePort,
  type WorkflowNodeOutcome,
} from "./workflow-runtime-dispatcher.ts";
import {
  loadPendingToolEventsForSegment,
  workflowContinuationHistoryStart,
} from "./pending-tool-events.ts";

type ResumeStore = DomainStore & DurableQueueStore & WorkflowRuntimeStore;

export type WorkflowAgentResumeExecutionInput = Readonly<{
  runtime: AgentVersionRuntime;
  authority: Readonly<{
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
    binding: Parameters<WorkflowAgentNodePort["resume"]>[0]["binding"];
  }>;
  node: Parameters<WorkflowAgentNodePort["resume"]>[0]["node"];
  continuationState: Readonly<{
    modelSampleIndex: number;
    toolRoundsConsumed: number;
    history: readonly AgentHistoryItem[];
    continuation: AgentContinuation;
    revision: number;
  }>;
  adopted: Readonly<{
    attempt: RunAttemptState & Readonly<{ status: "running" }>;
    step: RunStepState;
  }>;
}>;

export async function prepareWorkflowAgentContinuationResume(
  dependencies: Readonly<{
    execution: RunExecutionService;
    store: ResumeStore;
    approvalTtlMs: number | null;
    approvalRecheckMs: number;
  }>,
  input: Parameters<WorkflowAgentNodePort["resume"]>[0] &
    Readonly<{ runtime: AgentVersionRuntime }>,
): Promise<
  | Readonly<{ kind: "execute"; input: WorkflowAgentResumeExecutionInput }>
  | Readonly<{ kind: "outcome"; outcome: WorkflowNodeOutcome }>
> {
  const { claim, node, resume, runtime } = input;
  assertResumeAuthority(input);
  const run = await dependencies.execution.loadRun(claim);
  const pending = await loadPendingToolEventsForSegment({
    store: dependencies.store,
    run,
    segmentId: resume.continuation.segmentId,
  });
  assertDurableToolHistory(resume.continuation.history, pending);
  const base = {
    runtime,
    authority: {
      tenantId: resume.attempt.tenantId,
      runId: resume.attempt.runId,
      nodeId: node.nodeId,
      agentVersionId: resume.continuation.authority.agentVersionId,
      claimId: resume.claim.claimId,
      claimEpoch: resume.claim.claimEpoch,
      stepId: resume.attempt.stepId,
      attemptId: resume.attempt.attemptId,
      workItemClaim: claim,
      binding: input.binding,
    },
    node,
  };
  let history = resume.continuation.history;
  let revision = resume.continuation.revision;
  let toolRoundsConsumed = resume.continuation.toolRoundsConsumed;
  if (pending.events.length > 0) {
    try {
      const tool = await executeWorkflowTools(
        {
          execution: dependencies.execution,
          store: dependencies.store,
          approvalTtlMs: dependencies.approvalTtlMs,
          approvalRecheckMs: dependencies.approvalRecheckMs,
        },
        base,
        pending.events,
        pending.lastSegmentSequence,
        new AbortController().signal,
        {
          segmentId: resume.continuation.segmentId,
          modelSampleIndex: resume.continuation.modelSampleIndex,
          toolRoundsConsumed,
          history,
          revision,
          dispatch: null,
          providerCheckpoint: resume.continuation.providerCheckpoint,
          providerTurnState: resume.continuation.providerTurnState,
          nextToolRoundsConsumed:
            toolRoundsConsumed +
            (pending.completedCallIds.length === 0 ? 1 : 0),
        },
      );
      history = tool.history;
      revision = requireResumeRevision(tool.revision);
      toolRoundsConsumed = tool.toolRoundsConsumed;
    } catch (error) {
      if (error instanceof WorkflowToolApprovalWaitingError)
        return {
          kind: "outcome",
          outcome: {
            status: "waitingApproval",
            approvalId: error.approvalId,
          },
        };
      if (error instanceof WorkflowNodeSideEffectUncertainError)
        return { kind: "outcome", outcome: { status: "unknown" } };
      throw error;
    }
  }
  const historyStart = continuationHistoryStart(
    history,
    pending.requestedCallIds,
  );
  const continuation: AgentContinuation =
    resume.continuation.providerCheckpoint === null
      ? { kind: "manual" }
      : {
          kind: "providerCheckpoint",
          checkpoint: resume.continuation.providerCheckpoint,
          newHistoryStartIndex: historyStart,
        };
  return {
    kind: "execute",
    input: {
      ...base,
      continuationState: {
        modelSampleIndex: resume.continuation.modelSampleIndex + 1,
        toolRoundsConsumed,
        history,
        continuation,
        revision,
      },
      adopted: { attempt: resume.attempt, step: resume.step },
    },
  };
}

function assertResumeAuthority(
  input: Parameters<WorkflowAgentNodePort["resume"]>[0] &
    Readonly<{ runtime: AgentVersionRuntime }>,
): void {
  const { claim, node, resume, runtime } = input;
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const agentVersionId =
    node.kind === "agent"
      ? node.agentVersionId
      : node.kind === "verification"
        ? node.verifierAgentVersionId
        : null;
  const expectedAuthority = {
    tenantId: claim.workItem.tenantId,
    runId: claim.workItem.runId,
    workItemId: claim.workItem.workItemId,
    leaseEpoch: claim.lease.epoch,
    nodeId: node.nodeId,
    nodeKind: node.kind,
    claimId: resume.claim.claimId,
    claimEpoch: resume.claim.claimEpoch,
    agentVersionId,
    attempt: {
      stepId: resume.attempt.stepId,
      attemptId: resume.attempt.attemptId,
    },
  };
  const checkpoint = resume.continuation;
  const provider = checkpoint.providerCheckpoint;
  if (
    agentVersionId === null ||
    canonicalJson(resume.reconciliationLease) !== canonicalJson(lease) ||
    canonicalJson(checkpoint.authority) !== canonicalJson(expectedAuthority) ||
    canonicalJson(resume.claim.node) !== canonicalJson(node) ||
    resume.attempt.tenantId !== claim.workItem.tenantId ||
    resume.attempt.runId !== claim.workItem.runId ||
    resume.attempt.workItemId !== claim.workItem.workItemId ||
    resume.attempt.leaseEpoch !== claim.lease.epoch ||
    resume.attempt.status !== "running" ||
    resume.step.tenantId !== resume.attempt.tenantId ||
    resume.step.runId !== resume.attempt.runId ||
    resume.step.stepId !== resume.attempt.stepId ||
    resume.step.status !== "running" ||
    resume.step.currentAttemptId !== resume.attempt.attemptId ||
    checkpoint.activeDispatch !== null ||
    checkpoint.terminalCandidate !== null ||
    canonicalJson(checkpoint.providerCheckpoint) !==
      canonicalJson(resume.attempt.providerCheckpoint) ||
    checkpoint.providerTurnState !== resume.attempt.providerTurnState ||
    runtime.version.agentVersionId !== agentVersionId ||
    (provider !== null &&
      (resume.attempt.checkpointDigest === null ||
        provider.adapterName !== runtime.kernel.modelIdentity.adapterName ||
        provider.adapterVersion !==
          runtime.kernel.modelIdentity.adapterVersion ||
        provider.modelId !== runtime.kernel.modelIdentity.modelId))
  )
    throw new Error("workflow_node_resume_authority_mismatch");
}

function assertDurableToolHistory(
  history: readonly AgentHistoryItem[],
  pending: Readonly<{
    requestedCallIds: readonly string[];
    completedCallIds: readonly string[];
  }>,
): void {
  const calls = new Set(
    history
      .filter((item) => item.type === "tool_call")
      .map((item) => item.callId),
  );
  const results = new Set(
    history
      .filter((item) => item.type === "tool_result")
      .map((item) => item.callId),
  );
  if (
    pending.requestedCallIds.some((callId) => !calls.has(callId)) ||
    pending.completedCallIds.some((callId) => !results.has(callId))
  )
    throw new Error("workflow_node_resume_tool_history_mismatch");
}

function continuationHistoryStart(
  history: readonly AgentHistoryItem[],
  requestedCallIds: readonly string[],
): number {
  if (requestedCallIds.length > 0)
    return workflowContinuationHistoryStart(history, requestedCallIds);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.type === "message" && item.role === "assistant") return index;
  }
  throw new Error("workflow_node_resume_history_boundary_missing");
}

function requireResumeRevision(revision: number | null): number {
  if (revision === null)
    throw new Error("workflow_node_resume_continuation_missing");
  return revision;
}
