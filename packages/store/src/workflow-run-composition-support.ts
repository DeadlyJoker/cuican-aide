import {
  RunStoreError,
  type WorkflowNodeAttemptAdmission,
} from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  type CompiledWorkflowVersion,
  type FrozenWorkflowVersionBinding,
  type RunStepState,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type {
  WorkflowExecutionNodeState,
  WorkflowExecutionState,
} from "@crewon/application";

export type WorkflowCompositionDependencies = Readonly<{
  digester: WorkflowContentDigester;
}>;

export type WorkflowCompositionResult = Readonly<{
  execution: WorkflowExecutionState;
  admissions: readonly WorkflowNodeAttemptAdmission[];
}>;

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

export function claimReadyNodes(input: {
  execution: WorkflowExecutionState;
  workflow: CompiledWorkflowVersion;
  operationId: string;
  leaseDurationMs: number;
  now: string;
  digester: WorkflowContentDigester;
}): Readonly<{
  execution: WorkflowExecutionState;
  claims: readonly import("@crewon/application").WorkflowNodeClaim[];
}> {
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs <= 0
  )
    throw new RunStoreError("workflow_composition_lease_duration_invalid");
  const nowMs = Date.parse(input.now);
  const recovered = input.execution.nodes.map((node) =>
    node.status === "running" &&
    node.leaseExpiresAt !== null &&
    Date.parse(node.leaseExpiresAt) <= nowMs
      ? { ...node, status: "pending" as const, leaseExpiresAt: null }
      : node,
  );
  if (input.execution.cancelRequested || input.execution.status !== "running") {
    return { execution: input.execution, claims: [] };
  }
  const ready = new Set(
    input.workflow.executionOrder.filter((nodeId) => {
      const state = recovered.find((item) => item.nodeId === nodeId)!;
      const node = input.workflow.nodes.find((item) => item.nodeId === nodeId)!;
      return (
        state.status === "pending" &&
        node.dependsOn.every(
          (dependency) =>
            recovered.find((item) => item.nodeId === dependency)?.status ===
            "completed",
        )
      );
    }),
  );
  const claims: import("@crewon/application").WorkflowNodeClaim[] = [];
  const expiresAt = new Date(nowMs + input.leaseDurationMs).toISOString();
  const nodes = recovered.map((state) => {
    if (!ready.has(state.nodeId)) return state;
    const node = input.workflow.nodes.find(
      (item) => item.nodeId === state.nodeId,
    )!;
    const claimId = derivedId(input, state.nodeId, "claim");
    const gateRequestId =
      node.kind === "humanGate" ? derivedId(input, state.nodeId, "gate") : null;
    const inputDigest = input.digester.sha256(
      JSON.stringify({
        nodeId: node.nodeId,
        contentDigest: input.workflow.contentDigest,
        dependencies: node.dependsOn.map((dependency) => ({
          nodeId: dependency,
          resultDigest: recovered.find((item) => item.nodeId === dependency)!
            .resultDigest,
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
      status: node.kind === "humanGate" ? "waitingHuman" : "running",
      claimId,
      claimOperationId: input.operationId,
      claimEpoch: state.claimEpoch + 1,
      leaseExpiresAt: node.kind === "humanGate" ? null : expiresAt,
      gateRequestId,
      inputDigest,
    } satisfies WorkflowExecutionNodeState;
  });
  if (
    claims.length === 0 &&
    nodes.every((node, index) => node === input.execution.nodes[index])
  )
    return { execution: input.execution, claims };
  return {
    execution: {
      ...input.execution,
      revision: input.execution.revision + 1,
      nodes,
      status:
        nodes.some((node) => node.status === "waitingHuman") &&
        !nodes.some(
          (node) => node.status === "running" || node.status === "unknown",
        )
          ? "waitingHuman"
          : input.execution.status,
      updatedAt: input.now,
    },
    claims,
  };
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

function derivedId(
  input: { operationId: string; digester: WorkflowContentDigester },
  nodeId: string,
  kind: string,
): string {
  return `workflow-${kind}:${stripDigest(input.digester.sha256(`${input.operationId}\0${nodeId}\0${kind}`))}`;
}

function stripDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}
