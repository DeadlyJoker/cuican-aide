import {
  parseProviderCheckpoint,
  type ProviderCheckpoint,
} from "@crewon/contracts/runtime";
import type {
  ModelDispatchTerminalOutcome,
  ToolExecutionReceiptState,
} from "@crewon/domain";
import { validateProviderTurnState } from "@crewon/domain";
import { canonicalJson } from "./canonical-json.ts";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { RunAttemptIdentity } from "./run-execution-store-port.ts";
import { RunStoreError } from "./run-store-port.ts";
import type { ToolCompletedAgentEvent } from "./run-execution-service.ts";
import type { WorkflowNodeTerminalSettlement } from "./workflow-node-terminal-settlement.ts";
import type {
  WorkflowAtomicHandoff,
  WorkflowRunDisposition,
} from "./workflow-run-composition-port.ts";

export const MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS = 256;
export const MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES = 512 * 1024;
export const MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES = 40_000;

export type WorkflowContinuationHistoryItem =
  | Readonly<{
      type: "message";
      role: "user" | "assistant" | "developer" | "system";
      content: string;
    }>
  | Readonly<{
      type: "tool_call";
      kind: "function" | "custom";
      callId: string;
      name: string;
      input: string;
    }>
  | Readonly<{
      type: "tool_result";
      kind: "function" | "custom";
      callId: string;
      output: string;
    }>;

/** Exact authority of the Workflow node that owns a continuing Agent Attempt. */
export type WorkflowAgentAttemptAuthority = Readonly<{
  tenantId: string;
  runId: string;
  workItemId: string;
  leaseEpoch: number;
  nodeId: string;
  nodeKind: "agent" | "verification";
  claimId: string;
  claimEpoch: number;
  agentVersionId: string;
  attempt: RunAttemptIdentity;
}>;

/** Bounded crash-recovery state after an assistant or Tool boundary. */
export type WorkflowNodeContinuationCheckpoint = Readonly<{
  schemaVersion: "crewon.workflow-node-continuation.v0";
  authority: WorkflowAgentAttemptAuthority;
  segmentId: string;
  modelSampleIndex: number;
  toolRoundsConsumed: number;
  providerCheckpoint: ProviderCheckpoint | null;
  providerTurnState: string | null;
  activeDispatch: WorkflowNodeDispatchAuthority | null;
  terminalCandidate: WorkflowNodeTerminalCandidate | null;
  history: readonly WorkflowContinuationHistoryItem[];
  revision: number;
  updatedAt: string;
}>;

export type WorkflowNodeTerminalCandidate = Readonly<{
  schemaVersion: "crewon.workflow-node-terminal-candidate.v0";
  candidateId: string;
  segmentId: string;
  evidence: WorkflowNodeTerminalSettlement["evidence"];
  dispatchTerminalOutcome: ModelDispatchTerminalOutcome;
}>;

/** Deep-validates a persisted checkpoint before it can re-enter model context. */
export function validateWorkflowNodeContinuationCheckpoint(
  input: unknown,
): WorkflowNodeContinuationCheckpoint {
  const checkpoint = exactRecord(input);
  exactKeys(checkpoint, [
    "activeDispatch",
    "authority",
    "history",
    "modelSampleIndex",
    "providerCheckpoint",
    "providerTurnState",
    "revision",
    "schemaVersion",
    "segmentId",
    "terminalCandidate",
    "toolRoundsConsumed",
    "updatedAt",
  ]);
  if (
    checkpoint.schemaVersion !== "crewon.workflow-node-continuation.v0" ||
    !boundedId(checkpoint.segmentId) ||
    !nonNegativeInteger(checkpoint.modelSampleIndex) ||
    !nonNegativeInteger(checkpoint.toolRoundsConsumed) ||
    !positiveInteger(checkpoint.revision) ||
    !canonicalUtc(checkpoint.updatedAt)
  )
    invalidContinuation();
  const authority = validateAuthority(checkpoint.authority);
  const activeDispatch = validateActiveDispatch(checkpoint.activeDispatch);
  const terminalCandidate = validateTerminalCandidate(
    checkpoint.terminalCandidate,
  );
  let providerCheckpoint: ProviderCheckpoint | null;
  try {
    providerCheckpoint =
      checkpoint.providerCheckpoint === null
        ? null
        : structuredClone(
            parseProviderCheckpoint(checkpoint.providerCheckpoint),
          );
  } catch {
    invalidContinuation();
  }
  let providerTurnState: string | null;
  try {
    providerTurnState = validateProviderTurnState(checkpoint.providerTurnState);
  } catch {
    invalidContinuation();
  }
  if (
    !Array.isArray(checkpoint.history) ||
    checkpoint.history.length > MAX_WORKFLOW_CONTINUATION_HISTORY_ITEMS
  )
    invalidContinuation();
  const history = checkpoint.history.map(validateHistoryItem);
  if (
    utf8Bytes(canonicalJson(history)) > MAX_WORKFLOW_CONTINUATION_HISTORY_BYTES
  )
    invalidContinuation();
  return structuredClone({
    schemaVersion: "crewon.workflow-node-continuation.v0",
    authority,
    segmentId: checkpoint.segmentId,
    modelSampleIndex: checkpoint.modelSampleIndex,
    toolRoundsConsumed: checkpoint.toolRoundsConsumed,
    providerCheckpoint,
    providerTurnState,
    activeDispatch,
    terminalCandidate,
    history,
    revision: checkpoint.revision,
    updatedAt: checkpoint.updatedAt,
  }) as WorkflowNodeContinuationCheckpoint;
}

function validateTerminalCandidate(
  input: unknown,
): WorkflowNodeTerminalCandidate | null {
  if (input === null) return null;
  const value = exactRecord(input);
  exactKeys(value, [
    "candidateId",
    "dispatchTerminalOutcome",
    "evidence",
    "schemaVersion",
    "segmentId",
  ]);
  const dispatch = exactRecord(value.dispatchTerminalOutcome);
  exactKeys(dispatch, ["certainty", "code", "kind"]);
  if (
    value.schemaVersion !== "crewon.workflow-node-terminal-candidate.v0" ||
    !digest(value.candidateId) ||
    !boundedId(value.segmentId) ||
    !["completed", "failed", "canceled"].includes(String(dispatch.kind)) ||
    !["notSent", "responseObserved"].includes(String(dispatch.certainty)) ||
    (dispatch.kind === "completed"
      ? dispatch.code !== null
      : !boundedText(dispatch.code))
  )
    invalidContinuation();
  const evidence = exactRecord(value.evidence);
  validateTerminalEvidenceShape(evidence);
  if (
    evidence.status !== dispatch.kind ||
    utf8Bytes(canonicalJson(value)) >
      MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES
  )
    invalidContinuation();
  return structuredClone(value) as WorkflowNodeTerminalCandidate;
}

function validateTerminalEvidenceShape(
  evidence: Record<string, unknown>,
): void {
  if (evidence.schemaVersion !== "crewon.workflow-node-terminal.v0")
    invalidContinuation();
  if (evidence.status === "completed") {
    exactKeys(evidence, [
      "canonicalValueJson",
      "schemaVersion",
      "status",
      "value",
      "valueRef",
    ]);
    const valueRef = exactRecord(evidence.valueRef);
    exactKeys(valueRef, ["authority", "valueDigest"]);
    validateValueAuthority(valueRef.authority);
    if (
      !boundedText(evidence.canonicalValueJson) ||
      !digest(valueRef.valueDigest)
    )
      invalidContinuation();
    return;
  }
  if (evidence.status === "failed") {
    exactKeys(evidence, [
      "authority",
      "certainty",
      "failureCode",
      "schemaVersion",
      "status",
    ]);
    validateValueAuthority(evidence.authority);
    if (
      !boundedText(evidence.failureCode) ||
      !["notSent", "responseObserved"].includes(String(evidence.certainty))
    )
      invalidContinuation();
    return;
  }
  if (evidence.status === "canceled") {
    exactKeys(evidence, ["authority", "certainty", "schemaVersion", "status"]);
    validateValueAuthority(evidence.authority);
    if (!["notSent", "responseObserved"].includes(String(evidence.certainty)))
      invalidContinuation();
    return;
  }
  invalidContinuation();
}

function validateValueAuthority(input: unknown): void {
  const authority = exactRecord(input);
  exactKeys(authority, [
    "nodeId",
    "outputSchemaDigest",
    "workflowContentDigest",
    "workflowId",
    "workflowVersionId",
  ]);
  if (
    ![
      authority.nodeId,
      authority.workflowId,
      authority.workflowVersionId,
    ].every(boundedId) ||
    !digest(authority.outputSchemaDigest) ||
    !digest(authority.workflowContentDigest)
  )
    invalidContinuation();
}

function digest(input: unknown): boolean {
  return typeof input === "string" && /^sha256:[0-9a-f]{64}$/.test(input);
}

function validateAuthority(input: unknown): WorkflowAgentAttemptAuthority {
  const value = exactRecord(input);
  exactKeys(value, [
    "agentVersionId",
    "attempt",
    "claimEpoch",
    "claimId",
    "leaseEpoch",
    "nodeId",
    "nodeKind",
    "runId",
    "tenantId",
    "workItemId",
  ]);
  const attempt = exactRecord(value.attempt);
  exactKeys(attempt, ["attemptId", "stepId"]);
  if (
    ![
      value.tenantId,
      value.runId,
      value.workItemId,
      value.nodeId,
      value.claimId,
      value.agentVersionId,
      attempt.stepId,
      attempt.attemptId,
    ].every(boundedId) ||
    !positiveInteger(value.leaseEpoch) ||
    !positiveInteger(value.claimEpoch) ||
    (value.nodeKind !== "agent" && value.nodeKind !== "verification")
  )
    invalidContinuation();
  return structuredClone(value) as WorkflowAgentAttemptAuthority;
}

function validateActiveDispatch(
  input: unknown,
): WorkflowNodeDispatchAuthority | null {
  if (input === null) return null;
  const value = exactRecord(input);
  exactKeys(value, [
    "expectedRevision",
    "operationId",
    "requestSequence",
    "status",
  ]);
  if (
    !boundedId(value.operationId) ||
    !positiveInteger(value.requestSequence) ||
    !positiveInteger(value.expectedRevision) ||
    (value.status !== "prepared" &&
      value.status !== "possiblySent" &&
      value.status !== "responseObserved")
  )
    invalidContinuation();
  return structuredClone(value) as WorkflowNodeDispatchAuthority;
}

function validateHistoryItem(input: unknown): WorkflowContinuationHistoryItem {
  const value = exactRecord(input);
  if (value.type === "message") {
    exactKeys(value, ["content", "role", "type"]);
    if (
      !["user", "assistant", "developer", "system"].includes(
        value.role as string,
      ) ||
      !boundedText(value.content)
    )
      invalidContinuation();
  } else if (value.type === "tool_call") {
    exactKeys(value, ["callId", "input", "kind", "name", "type"]);
    if (
      (value.kind !== "function" && value.kind !== "custom") ||
      !boundedId(value.callId) ||
      !boundedId(value.name) ||
      !boundedText(value.input, true)
    )
      invalidContinuation();
  } else if (value.type === "tool_result") {
    exactKeys(value, ["callId", "kind", "output", "type"]);
    if (
      (value.kind !== "function" && value.kind !== "custom") ||
      !boundedId(value.callId) ||
      !boundedText(value.output, true)
    )
      invalidContinuation();
  } else invalidContinuation();
  try {
    if (
      utf8Bytes(canonicalJson(value)) >
      MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES
    )
      invalidContinuation();
  } catch {
    invalidContinuation();
  }
  return structuredClone(value) as WorkflowContinuationHistoryItem;
}

function exactRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalidContinuation();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalidContinuation();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  )
    invalidContinuation();
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    utf8Bytes(value) <= 512
  );
}

function boundedText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    utf8Bytes(value) <= MAX_WORKFLOW_CONTINUATION_HISTORY_ITEM_BYTES
  );
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function canonicalUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalidContinuation(): never {
  throw new RunStoreError("workflow_node_continuation_invalid");
}

/** Exact model request evidence that a resumed sample must retrieve or settle. */
export type WorkflowNodeDispatchAuthority = Readonly<{
  operationId: string;
  requestSequence: number;
  expectedRevision: number;
  status: "prepared" | "possiblySent" | "responseObserved";
}>;

export type SettleWorkflowNodeModelTerminalInput =
  WorkflowNodeTerminalSettlement &
    Readonly<{
      lease: WorkItemLeaseInput;
      authority: WorkflowAgentAttemptAuthority;
      dispatch: WorkflowNodeDispatchAuthority;
      dispatchTerminalOutcome: ModelDispatchTerminalOutcome;
    }>;

export type CommitWorkflowToolContinuationInput = Readonly<{
  lease: WorkItemLeaseInput;
  authority: WorkflowAgentAttemptAuthority;
  receipt: ToolExecutionReceiptState;
  toolAttempt: RunAttemptIdentity;
  completedEvent: ToolCompletedAgentEvent;
  providerReceiptId: string;
  expectedContinuationRevision: number | null;
  next: Omit<
    WorkflowNodeContinuationCheckpoint,
    "revision" | "updatedAt" | "terminalCandidate"
  >;
  committedAt: string;
}>;

export type CommitWorkflowAssistantContinuationInput = Readonly<{
  lease: WorkItemLeaseInput;
  authority: WorkflowAgentAttemptAuthority;
  expectedContinuationRevision: number | null;
  next: Omit<
    WorkflowNodeContinuationCheckpoint,
    "revision" | "updatedAt" | "terminalCandidate"
  >;
  committedAt: string;
  terminalResult:
    | null
    | Readonly<{ status: "completed"; output: string }>
    | Readonly<{ status: "failed"; failureCode: string }>
    | Readonly<{ status: "canceled" }>;
}>;

/**
 * Workflow-private continuation authority.
 *
 * Tool completion and the next continuation checkpoint must commit in one
 * transaction. Implementations fence the exact current node claim, Agent
 * Attempt, Work Item lease epoch, AgentVersion, segment and revision.
 */
export interface WorkflowNodeContinuationStore {
  loadWorkflowNodeContinuation(
    authority: WorkflowAgentAttemptAuthority,
  ): Promise<WorkflowNodeContinuationCheckpoint | null>;
  commitWorkflowToolContinuation(
    input: CommitWorkflowToolContinuationInput,
  ): Promise<
    Readonly<{
      receipt: ToolExecutionReceiptState;
      continuation: WorkflowNodeContinuationCheckpoint;
    }>
  >;
  commitWorkflowAssistantContinuation(
    input: CommitWorkflowAssistantContinuationInput,
  ): Promise<WorkflowNodeContinuationCheckpoint>;
  settlePreparedWorkflowNodeTerminal(
    input: Readonly<{
      lease: WorkItemLeaseInput;
      binding: import("@crewon/domain").FrozenWorkflowVersionBinding;
      authority: WorkflowAgentAttemptAuthority;
      candidateId: string;
      operationId: string;
    }>,
  ): ReturnType<
    WorkflowNodeContinuationStore["settleWorkflowNodeModelTerminal"]
  >;

  /**
   * Atomically establishes the single terminal truth for one Workflow node.
   *
   * Implementations compare the dispatch receipt revision, terminate that
   * receipt, validate completed canonical JSON/digest/schema, finish the exact
   * Agent Attempt and Step, settle the DAG node, and perform the Work Item
   * handoff in one transaction. A replay returns the already committed result.
   * A possibly-sent request without response evidence is not terminalizable.
   */
  settleWorkflowNodeModelTerminal(
    input: SettleWorkflowNodeModelTerminalInput,
  ): Promise<
    Readonly<{
      disposition: "settled" | "replay" | "reconciliationScheduled";
      continuation: null;
      handoff: WorkflowAtomicHandoff;
      runDisposition: WorkflowRunDisposition;
      evidence: WorkflowNodeTerminalSettlement["evidence"];
    }>
  >;
}
