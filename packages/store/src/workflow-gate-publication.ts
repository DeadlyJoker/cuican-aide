import {
  RunStoreError,
  type OutboxMessage,
  type WorkflowHumanGatePublication,
} from "@crewon/application";

import { stableJson } from "./store-invariants.ts";

export type StoredWorkflowGatePublication = Readonly<{
  tenantId: string;
  runId: string;
  binding: Readonly<Record<string, unknown>>;
  schedulerOperationId: string;
  nodeId: string;
  claimId: string;
  claimEpoch: number;
  gateRequestId: string;
  approvalPolicyId: string;
  inputDigest: string;
  publicationOutboxMessageId: string;
  approvalResumeWorkItemId: string;
  status: "publicationPending" | "published";
  createdAt: string;
  updatedAt: string;
}>;

export function prepareWorkflowGatePublication(
  message: OutboxMessage,
  state: unknown,
  now: string,
): Readonly<{
  publication: WorkflowHumanGatePublication;
  nextState: StoredWorkflowGatePublication;
}> {
  const gate = parseStoredGate(state);
  assertWorkflowGatePublicationMessage(message, gate);
  if (gate.status !== "publicationPending") {
    throw new RunStoreError("workflow_gate_publication_mismatch");
  }
  const nextState = { ...gate, status: "published" as const, updatedAt: now };
  return {
    publication: projectWorkflowGatePublication(nextState),
    nextState,
  };
}

export function assertWorkflowGatePublicationMessage(
  message: OutboxMessage,
  state: unknown,
): void {
  const gate = parseStoredGate(state);
  const payload = parseStoredGate(message.payload);
  const projectedPayload =
    gate.status === "published" && payload.status === "publicationPending"
      ? { ...payload, status: "published" as const, updatedAt: gate.updatedAt }
      : payload;
  if (
    message.topic !== "workflow.gate.requested" ||
    message.messageId !== gate.publicationOutboxMessageId ||
    message.tenantId !== gate.tenantId ||
    message.runId !== gate.runId ||
    message.createdAt !== gate.createdAt ||
    stableJson(projectedPayload) !== stableJson(gate)
  ) {
    throw new RunStoreError("workflow_gate_publication_mismatch");
  }
}

export function projectWorkflowGatePublication(
  state: unknown,
): WorkflowHumanGatePublication {
  const gate = parseStoredGate(state);
  if (gate.status !== "published")
    throw new RunStoreError("workflow_gate_publication_not_published");
  return {
    runId: gate.runId,
    nodeId: gate.nodeId,
    claimId: gate.claimId,
    claimEpoch: gate.claimEpoch,
    gateRequestId: gate.gateRequestId,
    approvalPolicyId: gate.approvalPolicyId,
    status: "published",
    createdAt: gate.createdAt,
  };
}

function parseStoredGate(value: unknown): StoredWorkflowGatePublication {
  if (!record(value)) throw invalid();
  const keys = Object.keys(value).sort().join("\0");
  if (
    keys !==
      [
        "approvalPolicyId",
        "approvalResumeWorkItemId",
        "binding",
        "claimEpoch",
        "claimId",
        "createdAt",
        "gateRequestId",
        "inputDigest",
        "nodeId",
        "publicationOutboxMessageId",
        "runId",
        "schedulerOperationId",
        "status",
        "tenantId",
        "updatedAt",
      ].join("\0") ||
    !record(value.binding) ||
    !positiveInteger(value.claimEpoch) ||
    (value.status !== "publicationPending" && value.status !== "published") ||
    ![
      value.tenantId,
      value.runId,
      value.schedulerOperationId,
      value.nodeId,
      value.claimId,
      value.gateRequestId,
      value.approvalPolicyId,
      value.inputDigest,
      value.publicationOutboxMessageId,
      value.approvalResumeWorkItemId,
      value.createdAt,
      value.updatedAt,
    ].every(bounded)
  ) {
    throw invalid();
  }
  return value as StoredWorkflowGatePublication;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function bounded(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}

function invalid(): RunStoreError {
  return new RunStoreError("workflow_gate_publication_invalid");
}
