import type {
  CompiledWorkflowVersion,
  FrozenWorkflowVersionBinding,
  WorkflowNodeDefinition,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import { canonicalJson } from "./canonical-json.ts";
import { RunStoreError } from "./run-store-port.ts";
import type {
  WorkflowExecutionNodeState,
  WorkflowExecutionState,
  WorkflowExecutionStore,
} from "./workflow-execution-store-port.ts";

const MAX_CAS_RETRIES = 8;

export type WorkflowNodeClaim = Readonly<{
  node: WorkflowNodeDefinition;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string | null;
  inputDigest: string;
}>;

/** Coordinates a frozen WorkflowVersion exclusively through durable CAS state. */
export class WorkflowExecutionService {
  readonly #store: WorkflowExecutionStore;
  readonly #now: () => string;
  readonly #nextId: () => string;
  readonly #sha256: (value: string) => string;

  constructor(dependencies: {
    store: WorkflowExecutionStore;
    now(): string;
    nextId(): string;
    sha256(value: string): string;
  }) {
    this.#store = dependencies.store;
    this.#now = dependencies.now;
    this.#nextId = dependencies.nextId;
    this.#sha256 = dependencies.sha256;
  }

  async initialize(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
  }): Promise<WorkflowExecutionState> {
    assertFrozenBinding(input.binding, input.workflow);
    const updatedAt = this.#now();
    const state: WorkflowExecutionState = {
      schemaVersion: "crewon.workflow-execution.v0",
      tenantId: input.tenantId,
      runId: input.runId,
      workflowId: input.binding.workflowId,
      workflowVersionId: input.workflow.workflowVersionId,
      contentDigest: input.workflow.contentDigest,
      revision: 1,
      status: "running",
      cancelRequested: false,
      nodes: input.workflow.executionOrder.map((nodeId) => {
        const node = input.workflow.nodes.find(
          (candidate) => candidate.nodeId === nodeId,
        )!;
        return initialNode(node);
      }),
      updatedAt,
    };
    const result = await this.#storeCall(() =>
      this.#store.createWorkflowExecution(state),
    );
    assertBinding(result.state, input.binding, input.workflow);
    return result.state;
  }

  async load(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
  }): Promise<WorkflowExecutionState> {
    return this.#load(input);
  }

  async claimReady(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    leaseDurationMs: number;
    operationId: string;
  }): Promise<readonly WorkflowNodeClaim[]> {
    requirePositiveDuration(input.leaseDurationMs);
    const existing = await this.#storeCall(() =>
      this.#store.loadWorkflowExecution({
        tenantId: input.tenantId,
        runId: input.runId,
      }),
    );
    if (existing?.nodes.some((node) => node.status === "queued"))
      throw new ApplicationError(
        "conflict",
        "workflow_execution_composition_required",
      );
    const replay = await this.#storeCall(() =>
      this.#store.loadWorkflowExecutionReceipt({
        tenantId: input.tenantId,
        runId: input.runId,
        operationId: input.operationId,
      }),
    );
    if (replay !== null) {
      const fingerprint = claimFingerprint(input, replay.state.revision - 1);
      if (replay.fingerprint !== fingerprint)
        throw new ApplicationError(
          "conflict",
          "workflow_execution_idempotency_conflict",
        );
      assertBinding(replay.state, input.binding, input.workflow);
      return claimsFromReceipt(replay.state, input.workflow, input.operationId);
    }
    for (let retry = 0; retry < MAX_CAS_RETRIES; retry += 1) {
      const current = await this.#load(input);
      if (current.cancelRequested || current.status !== "running") return [];
      const now = this.#now();
      const recovered = recoverExpired(current.nodes, now);
      const readyIds = input.workflow.executionOrder.filter((nodeId) => {
        const state = recovered.find((node) => node.nodeId === nodeId)!;
        const definition = input.workflow.nodes.find(
          (node) => node.nodeId === nodeId,
        )!;
        return (
          state.status === "pending" &&
          definition.dependsOn.every(
            (dependency) =>
              recovered.find((node) => node.nodeId === dependency)?.status ===
              "completed",
          )
        );
      });
      if (readyIds.length === 0 && sameNodes(current.nodes, recovered))
        return [];
      const claims: WorkflowNodeClaim[] = [];
      const expiresAt = new Date(
        Date.parse(now) + input.leaseDurationMs,
      ).toISOString();
      const nodes = recovered.map((state) => {
        if (!readyIds.includes(state.nodeId)) return state;
        const node = input.workflow.nodes.find(
          (candidate) => candidate.nodeId === state.nodeId,
        )!;
        const claimId = this.#nextId();
        const gateRequestId = node.kind === "humanGate" ? this.#nextId() : null;
        const inputDigest = this.#sha256(
          JSON.stringify({
            nodeId: node.nodeId,
            contentDigest: input.workflow.contentDigest,
            dependencies: node.dependsOn.map((dependency) => {
              const settled = recovered.find(
                (candidate) => candidate.nodeId === dependency,
              )!;
              return { nodeId: dependency, resultDigest: settled.resultDigest };
            }),
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
      const next = projectState(current, nodes, now);
      const fingerprint = claimFingerprint(input, current.revision);
      const result = await this.#storeCall(() =>
        this.#store.compareAndSwapWorkflowExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          expectedRevision: current.revision,
          next,
          receipt: {
            operationId: input.operationId,
            fingerprint,
          },
        }),
      );
      if (result.disposition !== "conflict") return claims;
    }
    throw new ApplicationError("conflict", "workflow_execution_cas_exhausted");
  }

  async settleNode(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    nodeId: string;
    claimId: string;
    operationId: string;
    outcome:
      | Readonly<{ status: "completed"; resultDigest: string }>
      | Readonly<{ status: "failed"; failureCode: string }>
      | Readonly<{ status: "canceled" }>
      | Readonly<{ status: "unknown" }>;
  }): Promise<WorkflowExecutionState> {
    const fingerprint = settlementFingerprint(input);
    const replay = await this.#storeCall(() =>
      this.#store.loadWorkflowExecutionReceipt({
        tenantId: input.tenantId,
        runId: input.runId,
        operationId: input.operationId,
      }),
    );
    if (replay !== null) {
      if (replay.fingerprint !== fingerprint) {
        throw new ApplicationError(
          "conflict",
          "workflow_execution_idempotency_conflict",
        );
      }
      assertBinding(replay.state, input.binding, input.workflow);
      return replay.state;
    }
    for (let retry = 0; retry < MAX_CAS_RETRIES; retry += 1) {
      const current = await this.#load(input);
      const target = current.nodes.find((node) => node.nodeId === input.nodeId);
      if (!target || target.claimId !== input.claimId) {
        throw new ApplicationError("conflict", "workflow_node_claim_stale");
      }
      if (isTerminal(target.status)) {
        throw new ApplicationError(
          "conflict",
          "workflow_node_terminal_settlement_conflict",
        );
      }
      const expected =
        target.status === "waitingHuman" ? "waitingHuman" : "running";
      if (target.status !== expected && target.status !== "unknown") {
        throw new ApplicationError("conflict", "workflow_node_not_settleable");
      }
      const nodes = current.nodes.map((node) =>
        node.nodeId === input.nodeId
          ? {
              ...node,
              status: input.outcome.status,
              leaseExpiresAt: null,
              resultDigest:
                input.outcome.status === "completed"
                  ? input.outcome.resultDigest
                  : null,
              failureCode:
                input.outcome.status === "failed"
                  ? input.outcome.failureCode
                  : null,
            }
          : node,
      );
      const next = projectState(current, nodes, this.#now());
      const result = await this.#storeCall(() =>
        this.#store.compareAndSwapWorkflowExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          expectedRevision: current.revision,
          next,
          receipt: { operationId: input.operationId, fingerprint },
        }),
      );
      if (result.disposition !== "conflict") return result.state;
    }
    throw new ApplicationError("conflict", "workflow_execution_cas_exhausted");
  }

  async requestCancel(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
    operationId: string;
  }): Promise<WorkflowExecutionState> {
    const replay = await this.#storeCall(() =>
      this.#store.loadWorkflowExecutionReceipt({
        tenantId: input.tenantId,
        runId: input.runId,
        operationId: input.operationId,
      }),
    );
    if (replay !== null) {
      const fingerprint = cancelFingerprint(input, replay.state.revision - 1);
      if (replay.fingerprint !== fingerprint)
        throw new ApplicationError(
          "conflict",
          "workflow_execution_idempotency_conflict",
        );
      assertBinding(replay.state, input.binding, input.workflow);
      return replay.state;
    }
    for (let retry = 0; retry < MAX_CAS_RETRIES; retry += 1) {
      const current = await this.#load(input);
      if (current.cancelRequested && current.status === "canceled")
        return current;
      const nodes = current.nodes.map((node) =>
        node.status === "pending" || node.status === "waitingHuman"
          ? { ...node, status: "canceled" as const, leaseExpiresAt: null }
          : node,
      );
      const next = {
        ...projectState(current, nodes, this.#now()),
        cancelRequested: true,
        status: nodes.some(
          (node) => node.status === "running" || node.status === "unknown",
        )
          ? ("running" as const)
          : ("canceled" as const),
      };
      const result = await this.#storeCall(() =>
        this.#store.compareAndSwapWorkflowExecution({
          tenantId: input.tenantId,
          runId: input.runId,
          expectedRevision: current.revision,
          next,
          receipt: {
            operationId: input.operationId,
            fingerprint: cancelFingerprint(input, current.revision),
          },
        }),
      );
      if (result.disposition !== "conflict") return result.state;
    }
    throw new ApplicationError("conflict", "workflow_execution_cas_exhausted");
  }

  async listUnknownClaims(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
  }): Promise<readonly WorkflowNodeClaim[]> {
    const current = await this.#load(input);
    return current.nodes
      .filter((node) => node.status === "unknown")
      .map((node) => claimFromState(node, input.workflow));
  }

  async #load(input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    workflow: CompiledWorkflowVersion;
  }): Promise<WorkflowExecutionState> {
    const state = await this.#storeCall(() =>
      this.#store.loadWorkflowExecution(input),
    );
    if (!state)
      throw new ApplicationError("notFound", "workflow_execution_not_found");
    assertBinding(state, input.binding, input.workflow);
    return state;
  }

  async #storeCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof RunStoreError) {
        throw new ApplicationError(
          error.code.includes("conflict") ? "conflict" : "internal",
          error.code,
          { cause: error },
        );
      }
      throw new ApplicationError(
        "internal",
        "workflow_execution_store_failed",
        {
          cause: error instanceof Error ? error : undefined,
        },
      );
    }
  }
}

function initialNode(node: WorkflowNodeDefinition): WorkflowExecutionNodeState {
  return {
    nodeId: node.nodeId,
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
}

function recoverExpired(
  nodes: readonly WorkflowExecutionNodeState[],
  now: string,
): readonly WorkflowExecutionNodeState[] {
  return nodes.map((node) =>
    node.status === "running" &&
    node.leaseExpiresAt !== null &&
    Date.parse(node.leaseExpiresAt) <= Date.parse(now)
      ? { ...node, status: "unknown" as const, leaseExpiresAt: null }
      : node,
  );
}

function projectState(
  current: WorkflowExecutionState,
  nodes: readonly WorkflowExecutionNodeState[],
  updatedAt: string,
): WorkflowExecutionState {
  const active = nodes.some(
    (node) =>
      node.status === "queued" ||
      node.status === "running" ||
      node.status === "unknown",
  );
  const status =
    current.cancelRequested && !active
      ? "canceled"
      : nodes.some((node) => node.status === "failed")
        ? "failed"
        : nodes.every((node) => node.status === "completed")
          ? "completed"
          : nodes.some((node) => node.status === "waitingHuman") &&
              !nodes.some(
                (node) =>
                  node.status === "queued" ||
                  node.status === "running" ||
                  node.status === "unknown",
              )
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

function claimFingerprint(
  input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
    leaseDurationMs: number;
  },
  expectedRevision: number,
): string {
  return canonicalJson({
    kind: "workflow.claim.v1",
    tenantId: input.tenantId,
    runId: input.runId,
    binding: input.binding,
    expectedRevision,
    leaseDurationMs: input.leaseDurationMs,
  });
}

function settlementFingerprint(input: {
  tenantId: string;
  runId: string;
  binding: FrozenWorkflowVersionBinding;
  nodeId: string;
  claimId: string;
  outcome: unknown;
}): string {
  return canonicalJson({
    kind: "workflow.settle.v1",
    tenantId: input.tenantId,
    runId: input.runId,
    binding: input.binding,
    nodeId: input.nodeId,
    claimId: input.claimId,
    outcome: input.outcome,
  });
}

function cancelFingerprint(
  input: {
    tenantId: string;
    runId: string;
    binding: FrozenWorkflowVersionBinding;
  },
  expectedRevision: number,
): string {
  return canonicalJson({
    kind: "workflow.cancel.v1",
    tenantId: input.tenantId,
    runId: input.runId,
    binding: input.binding,
    expectedRevision,
  });
}

function claimsFromReceipt(
  state: WorkflowExecutionState,
  workflow: CompiledWorkflowVersion,
  operationId: string,
): readonly WorkflowNodeClaim[] {
  return state.nodes
    .filter(
      (node) =>
        (node.status === "running" || node.status === "waitingHuman") &&
        node.claimId !== null &&
        node.claimOperationId === operationId,
    )
    .map((node) => claimFromState(node, workflow));
}

function claimFromState(
  state: WorkflowExecutionNodeState,
  workflow: CompiledWorkflowVersion,
): WorkflowNodeClaim {
  const node = workflow.nodes.find(
    (candidate) => candidate.nodeId === state.nodeId,
  );
  if (!node || state.claimId === null || state.inputDigest === null)
    throw new ApplicationError("internal", "workflow_claim_state_corrupt");
  return {
    node,
    claimId: state.claimId,
    claimEpoch: state.claimEpoch,
    gateRequestId: state.gateRequestId,
    inputDigest: state.inputDigest,
  };
}

function assertBinding(
  state: WorkflowExecutionState,
  binding: FrozenWorkflowVersionBinding,
  workflow: CompiledWorkflowVersion,
): void {
  if (
    state.workflowId !== binding.workflowId ||
    state.workflowVersionId !== workflow.workflowVersionId ||
    state.contentDigest !== workflow.contentDigest ||
    state.nodes.length !== workflow.nodes.length ||
    state.nodes.some(
      (node, index) => node.nodeId !== workflow.executionOrder[index],
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "workflow_execution_binding_mismatch",
    );
  }
}

function assertFrozenBinding(
  binding: FrozenWorkflowVersionBinding,
  workflow: CompiledWorkflowVersion,
): void {
  if (
    binding.workflowId !== workflow.workflowId ||
    binding.workflowVersionId !== workflow.workflowVersionId ||
    binding.contentDigest !== workflow.contentDigest
  ) {
    throw new ApplicationError(
      "conflict",
      "workflow_execution_binding_mismatch",
    );
  }
}

function isTerminal(status: WorkflowExecutionNodeState["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function sameNodes(
  left: readonly WorkflowExecutionNodeState[],
  right: readonly WorkflowExecutionNodeState[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePositiveDuration(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 24 * 60 * 60 * 1_000
  ) {
    throw new ApplicationError("validation", "workflow_lease_duration_invalid");
  }
}
