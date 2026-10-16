import {
  canonicalJson,
  RunStoreError,
  type WorkflowExecutionState,
  type WorkflowExecutionStore,
} from "@crewon/application";

export const MAX_WORKFLOW_EXECUTION_BYTES = 524_288;

export function decodeState(input: unknown): WorkflowExecutionState {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new RunStoreError("workflow_execution_store_corrupt", {
        cause: error,
      });
    }
  }
  validateState(value);
  return structuredClone(value);
}

export function validateState(
  input: unknown,
): asserts input is WorkflowExecutionState {
  if (!plain(input))
    throw new RunStoreError("workflow_execution_state_invalid");
  const state = input as unknown as WorkflowExecutionState;
  if (
    !exactKeys(state, [
      "cancelRequested",
      "nodes",
      "revision",
      "runId",
      "schemaVersion",
      "status",
      "tenantId",
      "updatedAt",
      "workflowId",
      "contentDigest",
      "workflowVersionId",
    ]) ||
    state.schemaVersion !== "crewon.workflow-execution.v0" ||
    !boundedId(state.tenantId) ||
    !boundedId(state.runId) ||
    !boundedId(state.workflowId) ||
    !boundedId(state.workflowVersionId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(state.contentDigest) ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1 ||
    !["running", "waitingHuman", "completed", "failed", "canceled"].includes(
      state.status,
    ) ||
    typeof state.cancelRequested !== "boolean" ||
    !canonicalUtc(state.updatedAt) ||
    !Array.isArray(state.nodes) ||
    state.nodes.length < 1 ||
    state.nodes.length > 64 ||
    new Set(state.nodes.map((node) => node.nodeId)).size !== state.nodes.length
  )
    throw new RunStoreError("workflow_execution_state_invalid");
  for (const node of state.nodes) validateNode(node);
  const active = state.nodes.some(
    (node) => node.status === "running" || node.status === "unknown",
  );
  const projected =
    state.cancelRequested && !active
      ? "canceled"
      : state.nodes.some((node) => node.status === "failed")
        ? "failed"
        : state.nodes.every((node) => node.status === "completed")
          ? "completed"
          : state.nodes.some((node) => node.status === "waitingHuman") &&
              !active
            ? "waitingHuman"
            : "running";
  if (state.status !== projected)
    throw new RunStoreError("workflow_execution_state_invalid");
}

function validateNode(node: unknown): void {
  if (!plain(node)) throw new RunStoreError("workflow_execution_state_invalid");
  const value = node as unknown as WorkflowExecutionState["nodes"][number];
  if (
    !exactKeys(value, [
      "agentVersionId",
      "claimEpoch",
      "claimId",
      "claimOperationId",
      "failureCode",
      "gateRequestId",
      "inputDigest",
      "kind",
      "leaseExpiresAt",
      "nodeId",
      "resultDigest",
      "status",
    ]) ||
    !boundedId(value.nodeId) ||
    !["agent", "humanGate", "verification"].includes(value.kind) ||
    (value.agentVersionId !== null && !boundedId(value.agentVersionId)) ||
    (value.kind === "humanGate") !== (value.agentVersionId === null) ||
    ![
      "pending",
      "running",
      "waitingHuman",
      "completed",
      "failed",
      "canceled",
      "unknown",
    ].includes(value.status) ||
    !Number.isSafeInteger(value.claimEpoch) ||
    value.claimEpoch < 0 ||
    (value.claimId !== null && !boundedId(value.claimId)) ||
    (value.claimOperationId !== null && !boundedId(value.claimOperationId)) ||
    (value.gateRequestId !== null && !boundedId(value.gateRequestId)) ||
    (value.inputDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.inputDigest)) ||
    (value.leaseExpiresAt !== null && !canonicalUtc(value.leaseExpiresAt)) ||
    (value.resultDigest !== null &&
      !/^sha256:[a-f0-9]{64}$/u.test(value.resultDigest)) ||
    (value.failureCode !== null && !boundedId(value.failureCode))
  )
    throw new RunStoreError("workflow_execution_state_invalid");
  const unclaimed = value.status === "pending";
  const active =
    value.status === "running" ||
    value.status === "waitingHuman" ||
    value.status === "unknown";
  if (
    (unclaimed &&
      (value.claimId !== null ||
        value.claimOperationId !== null ||
        value.claimEpoch !== 0 ||
        value.inputDigest !== null)) ||
    (active &&
      (value.claimId === null ||
        value.claimOperationId === null ||
        value.claimEpoch < 1 ||
        value.inputDigest === null)) ||
    (value.status === "running") !== (value.leaseExpiresAt !== null) ||
    (value.status === "waitingHuman" && value.gateRequestId === null) ||
    (value.kind !== "humanGate" && value.gateRequestId !== null) ||
    (value.status === "completed") !== (value.resultDigest !== null) ||
    (value.status === "failed") !== (value.failureCode !== null) ||
    ((value.status === "canceled" || value.status === "unknown") &&
      (value.resultDigest !== null || value.failureCode !== null))
  )
    throw new RunStoreError("workflow_execution_state_invalid");
}

export function validateCas(
  input: Parameters<
    WorkflowExecutionStore["compareAndSwapWorkflowExecution"]
  >[0],
): void {
  validateLocator(input);
  validateState(input.next);
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    input.next.revision !== input.expectedRevision + 1 ||
    !boundedId(input.receipt.operationId) ||
    typeof input.receipt.fingerprint !== "string" ||
    Buffer.byteLength(input.receipt.fingerprint) > 4096
  )
    throw new RunStoreError("workflow_execution_cas_invalid");
}

export function assertTransition(
  current: WorkflowExecutionState,
  next: WorkflowExecutionState,
): void {
  if (
    current.tenantId !== next.tenantId ||
    current.runId !== next.runId ||
    current.workflowId !== next.workflowId ||
    current.workflowVersionId !== next.workflowVersionId ||
    current.contentDigest !== next.contentDigest ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt) ||
    (current.cancelRequested && !next.cancelRequested) ||
    current.nodes.length !== next.nodes.length ||
    current.nodes.some(
      (node, index) =>
        node.nodeId !== next.nodes[index]?.nodeId ||
        node.kind !== next.nodes[index]?.kind ||
        node.agentVersionId !== next.nodes[index]?.agentVersionId,
    )
  )
    throw new RunStoreError("workflow_execution_authority_mismatch");
  for (const [index, node] of current.nodes.entries()) {
    const candidate = next.nodes[index]!;
    if (!validNodeTransition(node, candidate))
      throw new RunStoreError("workflow_execution_transition_invalid");
  }
}

function validNodeTransition(
  current: WorkflowExecutionState["nodes"][number],
  next: WorkflowExecutionState["nodes"][number],
): boolean {
  if (canonicalJson(current) === canonicalJson(next)) return true;
  if (current.status === "pending")
    return (
      next.status === "running" ||
      next.status === "waitingHuman" ||
      next.status === "canceled"
    );
  if (current.status === "running")
    return ["completed", "failed", "canceled", "unknown"].includes(next.status);
  if (current.status === "waitingHuman" || current.status === "unknown")
    return ["completed", "failed", "canceled", "unknown"].includes(next.status);
  return false;
}

export function assertCreateReplay(
  current: WorkflowExecutionState,
  requested: WorkflowExecutionState,
): void {
  if (
    current.tenantId !== requested.tenantId ||
    current.runId !== requested.runId ||
    current.workflowId !== requested.workflowId ||
    current.workflowVersionId !== requested.workflowVersionId ||
    current.contentDigest !== requested.contentDigest ||
    current.nodes.length !== requested.nodes.length ||
    current.nodes.some(
      (node, index) =>
        node.nodeId !== requested.nodes[index]?.nodeId ||
        node.kind !== requested.nodes[index]?.kind ||
        node.agentVersionId !== requested.nodes[index]?.agentVersionId,
    )
  )
    throw new RunStoreError("workflow_execution_create_conflict");
}

export function validateLocator(input: {
  tenantId: string;
  runId: string;
}): void {
  if (!plain(input) || !boundedId(input.tenantId) || !boundedId(input.runId))
    throw new RunStoreError("workflow_execution_locator_invalid");
}

export function validateReceiptLocator(input: {
  tenantId: string;
  runId: string;
  operationId: string;
}): void {
  validateLocator(input);
  if (!boundedId(input.operationId))
    throw new RunStoreError("workflow_execution_receipt_locator_invalid");
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function canonicalUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
