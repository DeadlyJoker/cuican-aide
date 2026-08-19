import type {
  AgentHistoryItem,
  KernelAgentEvent,
} from "@crewon/agent-kernel/runtime";
import type {
  DomainStore,
  DurableQueueStore,
  RunExecutionService,
  WorkItemClaim,
  WorkflowRuntimeStore,
  WorkflowToolApprovalOutcome,
} from "@crewon/application";
import type {
  FrozenWorkflowVersionBinding,
  ModelDispatchReceipt,
  ToolApprovalState,
  ToolExecutionReceiptState,
  WorkflowNodeDefinition,
} from "@crewon/domain";
import type {
  ToolExecutionCommand,
  ToolExecutionResolution,
} from "@crewon/tool-broker";

import type { AgentVersionRuntime } from "./agent-version-runtime.ts";
import {
  workflowAttemptAuthority,
  workflowContinuationCheckpoint,
  type WorkflowDurableExecutionAuthority,
} from "./workflow-agent-durable-continuation.ts";
import { WorkflowNodeSideEffectUncertainError } from "./workflow-runtime-dispatcher.ts";
import {
  projectWorkflowModelVisibleText,
  validateWorkflowModelHistory,
} from "./workflow-agent-value-projection.ts";

type WorkflowToolExecutionStore = DomainStore &
  DurableQueueStore &
  WorkflowRuntimeStore;

export type WorkflowAgentToolExecutionInput = Readonly<{
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
    workItemClaim: WorkItemClaim;
    binding: FrozenWorkflowVersionBinding;
  }>;
  node: WorkflowNodeDefinition;
}>;

export type WorkflowToolContinuationInput = Readonly<{
  segmentId: string;
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  history: readonly AgentHistoryItem[];
  revision: number | null;
  dispatch: ModelDispatchReceipt | null;
  providerCheckpoint: import("@crewon/contracts").ProviderCheckpoint | null;
  providerTurnState: string | null;
  nextToolRoundsConsumed: number;
}>;

export class WorkflowToolApprovalWaitingError extends Error {
  readonly approvalId: string;

  constructor(approvalId: string) {
    super("workflow_tool_approval_waiting");
    this.approvalId = approvalId;
  }
}

export async function executeWorkflowTools(
  dependencies: Readonly<{
    execution: RunExecutionService;
    store: WorkflowToolExecutionStore;
    approvalTtlMs: number | null;
    approvalRecheckMs: number;
  }>,
  input: WorkflowAgentToolExecutionInput,
  requests: readonly Extract<KernelAgentEvent, { type: "tool.requested" }>[],
  startingSequence: number,
  signal: AbortSignal,
  continuation: WorkflowToolContinuationInput,
  adopted?: Extract<WorkflowToolApprovalOutcome, { kind: "approved" }>,
): Promise<
  Readonly<{
    history: readonly AgentHistoryItem[];
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
    if (!defined || policy === null)
      throw new Error("tool_execution_policy_missing");
    if (input.node.kind === "humanGate")
      throw new Error("workflow_human_gate_model_execution_forbidden");
    const prepared =
      adopted?.receipt.call.callId === call.callId
        ? {
            disposition: "existing" as const,
            receipt: adopted.receipt,
            attempt: null,
          }
        : await dependencies.execution.beginToolExecution(
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
    const approval: ToolApprovalState | null =
      adopted?.receipt.call.callId === call.callId ? adopted.approval : null;
    if (policy.approvalRequirement === "perAction" && approval === null) {
      const artifacts =
        await dependencies.execution.prepareWorkflowToolApproval(
          input.authority.workItemClaim,
          receipt,
          { expiresAfterMs: dependencies.approvalTtlMs },
        );
      const published = await dependencies.store.publishWorkflowToolApproval({
        lease: leaseInput(input.authority.workItemClaim),
        binding: input.authority.binding,
        authority: workflowAttemptAuthority(durableAuthority(input)),
        operationId: `workflow-tool-approval:${receipt.actionDigest}`,
        expectedContinuationRevision: requireRevision(revision),
        receipt,
        ...artifacts,
        approvalRecheckMs: dependencies.approvalRecheckMs,
      });
      throw new WorkflowToolApprovalWaitingError(published.approval.approvalId);
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
          (await dependencies.execution.beginToolRecovery(
            input.authority.workItemClaim,
            prepared.receipt,
          ));
        toolAttempt = active.attempt;
      }
      const shouldExecute = receipt.status === "prepared";
      if (shouldExecute)
        receipt = await dependencies.execution.dispatchToolExecution(
          input.authority.workItemClaim,
          receipt,
        );
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
        await dependencies.execution.transitionToolExecution(
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
    if (resolution.status === "canceled")
      throw new Error("workflow_tool_execution_canceled");
    const visibleOutput = projectWorkflowModelVisibleText(
      resolution.result.output,
    );
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
        output: visibleOutput.content,
        isError: resolution.result.isError,
        artifactRef: resolution.result.artifactRef,
        outputTruncated: visibleOutput.truncated,
      },
    };
    if (receipt.status !== "completed") {
      if (toolAttempt === null)
        throw new Error("workflow_tool_attempt_missing");
      const nextHistory = validateWorkflowModelHistory([
        ...currentHistory,
        {
          type: "tool_result" as const,
          kind: call.kind,
          callId: call.callId,
          output: visibleOutput.content,
        },
      ]);
      const committed = await dependencies.store.commitWorkflowToolContinuation(
        {
          lease: leaseInput(input.authority.workItemClaim),
          authority: workflowAttemptAuthority(durableAuthority(input)),
          receipt,
          toolAttempt,
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
        },
      );
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

function requireRevision(revision: number | null): number {
  if (revision === null)
    throw new Error("workflow_tool_approval_continuation_missing");
  return revision;
}

function durableAuthority(
  input: WorkflowAgentToolExecutionInput,
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

function leaseInput(claim: WorkItemClaim) {
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
  claim: WorkItemClaim,
  approval: ToolApprovalState | null,
): ToolExecutionCommand {
  if (receipt.actionIntent === null)
    throw new Error("tool_action_intent_missing");
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
  if (receipt.result === null || receipt.providerReceiptId === null)
    throw new Error("tool_receipt_result_missing");
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
