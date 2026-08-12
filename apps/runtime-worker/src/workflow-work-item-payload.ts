import type { FrozenWorkflowVersionBinding } from "@crewon/domain";

const MAX_ID_BYTES = 256;

export type WorkflowWorkItemPayload =
  | Readonly<{
      schemaVersion: "crewon.workflow-scheduler-work-item.v1";
      trigger: "workflowScheduler";
      binding: FrozenWorkflowVersionBinding;
      schedulerOperationId: string;
      workflowInput: Readonly<{ valueId: string; valueDigest: string }>;
    }>
  | Readonly<{
      schemaVersion: "crewon.workflow-node-work-item.v0";
      trigger: "workflowNode";
      binding: FrozenWorkflowVersionBinding;
      nodeId: string;
      claimId: string;
      claimEpoch: number;
      schedulerOperationId: string;
    }>
  | Readonly<{
      schemaVersion: "crewon.workflow-gate-resume-work-item.v0";
      trigger: "workflowGateResume";
      binding: FrozenWorkflowVersionBinding;
      nodeId: string;
      claimId: string;
      claimEpoch: number;
      gateRequestId: string;
      decisionReceiptId: string;
    }>
  | Readonly<{
      schemaVersion: "crewon.workflow-reconcile-work-item.v0";
      trigger: "workflowReconcile";
      binding: FrozenWorkflowVersionBinding;
      nodeId: string | null;
      claimId: string | null;
      claimEpoch: number | null;
      reconciliationOperationId: string;
    }>;

export function parseWorkflowWorkItemPayload(
  input: Readonly<Record<string, unknown>>,
): WorkflowWorkItemPayload {
  const trigger = input.trigger;
  if (trigger === "workflowScheduler") {
    exact(input, [
      "binding",
      "schedulerOperationId",
      "schemaVersion",
      "trigger",
      "workflowInput",
    ]);
    if (input.schemaVersion !== "crewon.workflow-scheduler-work-item.v1")
      invalid();
    return {
      schemaVersion: input.schemaVersion,
      trigger,
      binding: binding(input.binding),
      schedulerOperationId: id(input.schedulerOperationId),
      workflowInput: valueRef(input.workflowInput),
    };
  }
  if (trigger === "workflowNode") {
    exact(input, [
      "binding",
      "claimEpoch",
      "claimId",
      "nodeId",
      "schedulerOperationId",
      "schemaVersion",
      "trigger",
    ]);
    if (input.schemaVersion !== "crewon.workflow-node-work-item.v0") invalid();
    return {
      schemaVersion: input.schemaVersion,
      trigger,
      binding: binding(input.binding),
      nodeId: id(input.nodeId),
      claimId: id(input.claimId),
      claimEpoch: epoch(input.claimEpoch),
      schedulerOperationId: id(input.schedulerOperationId),
    };
  }
  if (trigger === "workflowGateResume") {
    exact(input, [
      "binding",
      "claimEpoch",
      "claimId",
      "decisionReceiptId",
      "gateRequestId",
      "nodeId",
      "schemaVersion",
      "trigger",
    ]);
    if (input.schemaVersion !== "crewon.workflow-gate-resume-work-item.v0")
      invalid();
    return {
      schemaVersion: input.schemaVersion,
      trigger,
      binding: binding(input.binding),
      nodeId: id(input.nodeId),
      claimId: id(input.claimId),
      claimEpoch: epoch(input.claimEpoch),
      gateRequestId: id(input.gateRequestId),
      decisionReceiptId: id(input.decisionReceiptId),
    };
  }
  if (trigger === "workflowReconcile") {
    exact(input, [
      "binding",
      "claimEpoch",
      "claimId",
      "nodeId",
      "reconciliationOperationId",
      "schemaVersion",
      "trigger",
    ]);
    if (input.schemaVersion !== "crewon.workflow-reconcile-work-item.v0")
      invalid();
    const allNull =
      input.nodeId === null &&
      input.claimId === null &&
      input.claimEpoch === null;
    const allBound =
      input.nodeId !== null &&
      input.claimId !== null &&
      input.claimEpoch !== null;
    if (!allNull && !allBound) invalid();
    return {
      schemaVersion: input.schemaVersion,
      trigger,
      binding: binding(input.binding),
      nodeId: input.nodeId === null ? null : id(input.nodeId),
      claimId: input.claimId === null ? null : id(input.claimId),
      claimEpoch: input.claimEpoch === null ? null : epoch(input.claimEpoch),
      reconciliationOperationId: id(input.reconciliationOperationId),
    };
  }
  invalid();
}

function binding(input: unknown): FrozenWorkflowVersionBinding {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid();
  const value = input as Record<string, unknown>;
  exact(value, ["contentDigest", "workflowId", "workflowVersionId"]);
  return {
    workflowId: id(value.workflowId),
    workflowVersionId: id(value.workflowVersionId),
    contentDigest: id(value.contentDigest),
  };
}

function valueRef(
  input: unknown,
): Readonly<{ valueId: string; valueDigest: string }> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid();
  const value = input as Record<string, unknown>;
  exact(value, ["valueDigest", "valueId"]);
  return { valueId: id(value.valueId), valueDigest: id(value.valueDigest) };
}

function id(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    new TextEncoder().encode(input).length > MAX_ID_BYTES
  )
    invalid();
  return input;
}

function epoch(input: unknown): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) invalid();
  return input as number;
}

function exact(input: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    invalid();
}

function invalid(): never {
  throw new Error("workflow_work_item_payload_invalid");
}
