import type {
  CompiledWorkflowVersion,
  WorkflowNodeDefinition,
} from "@crewon/domain";
import type {
  WorkflowExecutionNodeState,
  WorkflowExecutionState,
} from "./workflow-execution-store-port.ts";
import type { WorkflowNodeClaim } from "./workflow-execution-service.ts";

/** Pure planning so SQLite composition can keep all reads and writes synchronous in one transaction. */
export function initialWorkflowExecution(input: {
  tenantId: string;
  runId: string;
  workflow: CompiledWorkflowVersion;
  now: string;
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
    nodes: input.workflow.executionOrder.map((id) => {
      const node = input.workflow.nodes.find(
        (candidate) => candidate.nodeId === id,
      )!;
      return {
        nodeId: id,
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
    updatedAt: input.now,
  };
}

export function planWorkflowNodeClaims(input: {
  current: WorkflowExecutionState;
  workflow: CompiledWorkflowVersion;
  now: string;
  expiresAt: string;
  operationId: string;
  maximumClaims: number;
  lostClaimIds: ReadonlySet<string>;
  /** A committed child Run owns execution after handoff; its canonical state decides recovery. */
  delegatedClaimIds?: ReadonlySet<string>;
  nextId(): string;
  inputDigest(
    node: WorkflowNodeDefinition,
    nodes: readonly WorkflowExecutionNodeState[],
  ): string;
}): Readonly<{
  next: WorkflowExecutionState;
  claims: readonly WorkflowNodeClaim[];
}> {
  const { current, workflow } = input;
  if (
    current.cancelRequested ||
    (current.status !== "running" && current.status !== "waitingHuman")
  )
    return { next: current, claims: [] };
  const recovered = current.nodes.map((node) =>
    node.status === "running" &&
    !input.delegatedClaimIds?.has(node.claimId!) &&
    (input.lostClaimIds.has(node.claimId!) ||
      Date.parse(node.leaseExpiresAt!) <= Date.parse(input.now))
      ? { ...node, status: "unknown" as const, leaseExpiresAt: null }
      : node,
  );
  const ready = workflow.executionOrder
    .filter((id) => {
      const state = recovered.find((node) => node.nodeId === id)!;
      const definition = workflow.nodes.find((node) => node.nodeId === id)!;
      return (
        state.status === "pending" &&
        definition.dependsOn.every(
          (dependency) =>
            recovered.find((node) => node.nodeId === dependency)?.status ===
            "completed",
        )
      );
    })
    .slice(0, input.maximumClaims);
  if (
    ready.length === 0 &&
    recovered.every((node, index) => node === current.nodes[index])
  )
    return { next: current, claims: [] };
  const claims: WorkflowNodeClaim[] = [];
  const nodes = recovered.map((state) => {
    if (!ready.includes(state.nodeId)) return state;
    const node = workflow.nodes.find(
      (candidate) => candidate.nodeId === state.nodeId,
    )!;
    const claim = {
      node,
      claimId: input.nextId(),
      claimEpoch: state.claimEpoch + 1,
      gateRequestId: node.kind === "humanGate" ? input.nextId() : null,
      inputDigest: input.inputDigest(node, recovered),
    };
    claims.push(claim);
    return {
      ...state,
      status:
        node.kind === "humanGate"
          ? ("waitingHuman" as const)
          : ("running" as const),
      claimId: claim.claimId,
      claimOperationId: input.operationId,
      claimEpoch: claim.claimEpoch,
      gateRequestId: claim.gateRequestId,
      inputDigest: claim.inputDigest,
      leaseExpiresAt: node.kind === "humanGate" ? null : input.expiresAt,
    };
  });
  return { next: projectWorkflowExecution(current, nodes, input.now), claims };
}

export function projectWorkflowExecution(
  current: WorkflowExecutionState,
  nodes: readonly WorkflowExecutionNodeState[],
  updatedAt: string,
): WorkflowExecutionState {
  const active = nodes.some(
    (node) => node.status === "running" || node.status === "unknown",
  );
  const status =
    current.cancelRequested && !active
      ? "canceled"
      : nodes.some((node) => node.status === "failed")
        ? "failed"
        : nodes.every((node) => node.status === "completed")
          ? "completed"
          : nodes.some((node) => node.status === "waitingHuman") && !active
            ? "waitingHuman"
            : "running";
  return {
    ...current,
    revision: current.revision + 1,
    status,
    nodes,
    updatedAt,
  };
}
