import {
  RunStoreError,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  type CompiledWorkflowVersion,
  type FrozenWorkflowVersionBinding,
  type RunAttemptState,
  type RunStepState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { WorkflowExecutionState } from "@crewon/application";

export type WorkflowCompositionDependencies = Readonly<{
  digester: WorkflowContentDigester;
}>;

export function reconciliationClaims(
  execution: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
): readonly import("@crewon/application").WorkflowNodeClaim[] {
  return workflow.executionOrder.flatMap((nodeId) => {
    const state = execution.nodes.find((node) => node.nodeId === nodeId)!;
    if (
      state.status !== "unknown" ||
      state.claimId === null ||
      state.inputDigest === null
    )
      return [];
    const node = workflow.nodes.find(
      (candidate) => candidate.nodeId === nodeId,
    )!;
    return [
      {
        node,
        claimId: state.claimId,
        claimEpoch: state.claimEpoch,
        gateRequestId: state.gateRequestId,
        inputDigest: state.inputDigest,
      },
    ];
  });
}

export function parseBoundWorkflow(
  definitionJson: string,
  binding: FrozenWorkflowVersionBinding,
  digester: WorkflowContentDigester,
): CompiledWorkflowVersion {
  let workflow: CompiledWorkflowVersion;
  try {
    workflow = parseCompiledWorkflowVersion(definitionJson, digester);
  } catch (error) {
    throw new RunStoreError("workflow_composition_version_corrupt", {
      cause: error,
    });
  }
  if (
    workflow.workflowId !== binding.workflowId ||
    workflow.workflowVersionId !== binding.workflowVersionId ||
    workflow.contentDigest !== binding.contentDigest
  ) {
    throw new RunStoreError("workflow_composition_binding_mismatch");
  }
  return workflow;
}

export function initialExecution(input: {
  tenantId: string;
  runId: string;
  workflow: CompiledWorkflowVersion;
  updatedAt: string;
}): WorkflowExecutionState {
  return {
    schemaVersion: "crewon.workflow-execution.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    workflowId: input.workflow.workflowId,
    workflowVersionId: input.workflow.workflowVersionId,
    contentDigest: input.workflow.contentDigest,
    revision: 1,
    status: "running",
    cancelRequested: false,
    nodes: input.workflow.executionOrder.map((nodeId) => {
      const node = input.workflow.nodes.find((item) => item.nodeId === nodeId);
      if (node === undefined)
        throw new RunStoreError("workflow_composition_version_corrupt");
      return {
        nodeId,
        kind: node.kind,
        agentVersionId:
          node.kind === "agent"
            ? node.agentVersionId
            : node.kind === "verification"
              ? node.verifierAgentVersionId
              : null,
        status: "pending",
        claimId: null,
        claimOperationId: null,
        claimEpoch: 0,
        leaseExpiresAt: null,
        gateRequestId: null,
        inputDigest: null,
        resultDigest: null,
        failureCode: null,
      };
    }),
    updatedAt: input.updatedAt,
  };
}

export function assertExecutionBinding(
  execution: WorkflowExecutionState,
  tenantId: string,
  runId: string,
  binding: FrozenWorkflowVersionBinding,
  workflow: CompiledWorkflowVersion,
): void {
  if (
    execution.tenantId !== tenantId ||
    execution.runId !== runId ||
    execution.workflowId !== binding.workflowId ||
    execution.workflowVersionId !== binding.workflowVersionId ||
    execution.contentDigest !== binding.contentDigest ||
    execution.nodes.length !== workflow.executionOrder.length ||
    execution.nodes.some((state, index) => {
      const nodeId = workflow.executionOrder[index];
      const node = workflow.nodes.find((item) => item.nodeId === nodeId);
      return (
        node === undefined ||
        state.nodeId !== nodeId ||
        state.kind !== node.kind ||
        state.agentVersionId !==
          (node.kind === "agent"
            ? node.agentVersionId
            : node.kind === "verification"
              ? node.verifierAgentVersionId
              : null)
      );
    })
  ) {
    throw new RunStoreError("workflow_composition_authority_mismatch");
  }
}

export function gateStep(input: {
  tenantId: string;
  runId: string;
  nodeId: string;
  now: string;
}): RunStepState {
  return {
    schemaVersion: "crewon.run-step.v0",
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.nodeId,
    kind: "gate",
    status: "waitingApproval",
    revision: 1,
    currentAttemptId: null,
    attemptCount: 0,
    createdAt: input.now,
    updatedAt: input.now,
    terminalAt: null,
  };
}

export function assertAdmissionReplayAuthority(
  admission: Omit<WorkflowNodeAttemptAdmission, "attempt"> & {
    attempt: WorkflowNodeAttemptAdmission["attempt"] | null;
  },
  step: RunStepState | null,
  attempt: RunAttemptState | null,
): void {
  const historicalStep = admission.step;
  if (
    step === null ||
    step.tenantId !== historicalStep.tenantId ||
    step.runId !== historicalStep.runId ||
    step.stepId !== historicalStep.stepId ||
    step.kind !== historicalStep.kind ||
    step.createdAt !== historicalStep.createdAt ||
    step.revision < historicalStep.revision ||
    step.attemptCount < historicalStep.attemptCount
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
  const historicalAttempt = admission.attempt;
  if (historicalAttempt === null) {
    if (attempt !== null || step.attemptCount !== 0)
      throw new RunStoreError("workflow_composition_receipt_corrupt");
    return;
  }
  if (
    attempt === null ||
    attempt.tenantId !== historicalAttempt.tenantId ||
    attempt.runId !== historicalAttempt.runId ||
    attempt.stepId !== historicalAttempt.stepId ||
    attempt.attemptId !== historicalAttempt.attemptId ||
    attempt.workItemId !== historicalAttempt.workItemId ||
    attempt.attemptNumber !== historicalAttempt.attemptNumber ||
    attempt.retryOfAttemptId !== historicalAttempt.retryOfAttemptId ||
    attempt.leaseEpoch !== historicalAttempt.leaseEpoch ||
    attempt.startedAt !== historicalAttempt.startedAt
  )
    throw new RunStoreError("workflow_composition_receipt_corrupt");
}

export function compositionFingerprint(input: {
  tenantId: string;
  runId: string;
  lease: {
    workItemId: string;
    ownerId: string;
    leaseId: string;
    leaseEpoch: number;
  };
  binding: FrozenWorkflowVersionBinding;
  schedulerOperationId: string;
  leaseDurationMs: number;
  digester: WorkflowContentDigester;
}): string {
  return input.digester.sha256(
    JSON.stringify({
      tenantId: input.tenantId,
      runId: input.runId,
      lease: input.lease,
      binding: input.binding,
      schedulerOperationId: input.schedulerOperationId,
      leaseDurationMs: input.leaseDurationMs,
    }),
  );
}

export function attemptId(
  operationId: string,
  nodeId: string,
  digester: WorkflowContentDigester,
): string {
  return `workflow-attempt:${stripDigest(digester.sha256(`${operationId}\0${nodeId}\0attempt`))}`;
}

export function workflowAuthorityId(
  role:
    | "claim"
    | "gate"
    | "node"
    | "attempt"
    | "value"
    | "gate-outbox"
    | "gate-resume"
    | "scheduler"
    | "reconcile"
    | "run-event"
    | "run-outbox",
  authority: unknown,
  digester: WorkflowContentDigester,
): string {
  const digest = stripDigest(
    digester.sha256(
      JSON.stringify({
        schemaVersion: "crewon.workflow-authority-id.v1",
        role,
        authority,
      }),
    ),
  );
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new RunStoreError("workflow_composition_digest_invalid");
  return `wf1:${role}:${digest}`;
}

export function scheduleReadyNodes(input: {
  execution: WorkflowExecutionState;
  workflow: CompiledWorkflowVersion;
  operationId: string;
  now: string;
  digester: WorkflowContentDigester;
  inputDigest?: (nodeId: string) => string;
}): Readonly<{
  execution: WorkflowExecutionState;
  claims: readonly import("@crewon/application").WorkflowNodeClaim[];
}> {
  if (input.execution.nodes.some((node) => node.status === "unknown"))
    return { execution: input.execution, claims: [] };
  const readyIds = input.workflow.executionOrder.filter((nodeId) => {
    const state = input.execution.nodes.find((node) => node.nodeId === nodeId)!;
    const definition = input.workflow.nodes.find(
      (node) => node.nodeId === nodeId,
    )!;
    return (
      state.status === "pending" &&
      definition.dependsOn.every(
        (dependency) =>
          input.execution.nodes.find((node) => node.nodeId === dependency)
            ?.status === "completed",
      )
    );
  });
  if (readyIds.length === 0) return { execution: input.execution, claims: [] };
  const claims: import("@crewon/application").WorkflowNodeClaim[] = [];
  const nodes = input.execution.nodes.map((state) => {
    if (!readyIds.includes(state.nodeId)) return state;
    const node = input.workflow.nodes.find(
      (candidate) => candidate.nodeId === state.nodeId,
    )!;
    const identity = {
      tenantId: input.execution.tenantId,
      runId: input.execution.runId,
      workflowVersionId: input.execution.workflowVersionId,
      nodeId: state.nodeId,
      claimEpoch: state.claimEpoch + 1,
      operationId: input.operationId,
    };
    const claimId = workflowAuthorityId("claim", identity, input.digester);
    const gateRequestId =
      node.kind === "humanGate"
        ? workflowAuthorityId("gate", identity, input.digester)
        : null;
    const inputDigest = input.inputDigest?.(node.nodeId) ?? input.digester.sha256(
      JSON.stringify({
        nodeId: node.nodeId,
        contentDigest: input.workflow.contentDigest,
        dependencies: node.dependsOn.map((dependency) => ({
          nodeId: dependency,
          resultDigest: input.execution.nodes.find(
            (item) => item.nodeId === dependency,
          )!.resultDigest,
        })),
      }),
    );
    claims.push({
      node,
      claimId,
      claimEpoch: state.claimEpoch + 1,
      gateRequestId,
      inputDigest,
    });
    return {
      ...state,
      status:
        node.kind === "humanGate"
          ? ("waitingHuman" as const)
          : ("queued" as const),
      claimId,
      claimOperationId: input.operationId,
      claimEpoch: state.claimEpoch + 1,
      leaseExpiresAt: null,
      gateRequestId,
      inputDigest,
    };
  });
  return {
    execution: {
      ...input.execution,
      revision: input.execution.revision + 1,
      nodes,
      status:
        nodes.some((node) => node.status === "waitingHuman") &&
        !nodes.some(
          (node) =>
            node.status === "queued" ||
            node.status === "running" ||
            node.status === "unknown",
        )
          ? "waitingHuman"
          : "running",
      updatedAt: input.now,
    },
    claims,
  };
}

export function settleWorkflowClaim(input: {
  execution: WorkflowExecutionState;
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  outcome: import("@crewon/application").WorkflowAtomicNodeOutcome;
  resultDigest?: string;
  now: string;
}): WorkflowExecutionState {
  const target = input.execution.nodes.find(
    (node) => node.nodeId === input.nodeId,
  );
  if (
    target === undefined ||
    target.claimId !== input.claimId ||
    target.claimEpoch !== input.claimEpoch
  )
    throw new RunStoreError("workflow_composition_claim_mismatch");
  const nodes = input.execution.nodes.map((node) =>
    node.nodeId !== input.nodeId
      ? node
      : {
          ...node,
          status: input.outcome.status,
          leaseExpiresAt: null,
          resultDigest:
            input.outcome.status === "completed"
              ? input.resultDigest ?? null
              : null,
          failureCode:
            input.outcome.status === "failed"
              ? input.outcome.failureCode
              : null,
        },
  );
  const active = nodes.some((node) =>
    ["queued", "running", "unknown", "waitingHuman"].includes(node.status),
  );
  const status = nodes.some((node) => node.status === "failed")
    ? "failed"
    : nodes.every((node) => node.status === "completed")
      ? "completed"
      : input.execution.cancelRequested && !active
        ? "canceled"
        : nodes.some((node) => node.status === "waitingHuman") &&
            !nodes.some((node) =>
              ["queued", "running", "unknown"].includes(node.status),
            )
          ? "waitingHuman"
          : "running";
  return {
    ...input.execution,
    revision: input.execution.revision + 1,
    nodes,
    status,
    updatedAt: input.now,
  };
}

function stripDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
