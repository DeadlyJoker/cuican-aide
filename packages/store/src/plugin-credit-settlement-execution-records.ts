import {
  RUN_STATUSES,
  extensionOpaqueId,
  extensionDigest,
  validateProviderTurnState,
  validateToolExecutionReceipt,
  type ExtensionRunBinding,
  type RunState,
  type RunStepState,
  type RunAttemptState,
  type ToolExecutionReceiptState,
} from "@crewon/domain";
import {
  parseExecutionProviderCheckpoint,
  type PluginCreditSettlementLocator,
} from "@crewon/application";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { parseExternalOperation } from "./external-operation-record.ts";
import { decodeSqliteToolReceiptState } from "./sqlite-tool-result-codec.ts";
import { normalizeStoredRunState } from "./stored-run-state.ts";
import type {
  SettlementEvidenceRows,
  SettlementRow,
} from "./plugin-credit-settlement-records.ts";
import {
  allowed,
  fail,
  indexed,
  integer,
  json,
  nullableId,
  ordered,
  queueTime,
  record,
  requiredRow,
  runIdentity,
  timestamp,
  unique,
} from "./plugin-credit-settlement-support.ts";

const code = "plugin_credit_settlement_record_invalid";
const terminal = new Set(["completed", "failed", "canceled"]);
const terminalStep = new Set(["completed", "failed", "skipped", "canceled"]);

export function readSettlementExecution(
  locator: PluginCreditSettlementLocator,
  binding: ExtensionRunBinding,
  rows: SettlementEvidenceRows,
) {
  const run = checkedRun(requiredRow(rows.runRow), binding);
  const steps = rows.steps.map((row) => checkedStep(requiredRow(row), locator));
  const attempts = rows.attempts.map((row) =>
    checkedAttempt(requiredRow(row), locator),
  );
  const workItems = rows.workItems.map((row) =>
    checkedWorkItem(requiredRow(row), locator),
  );
  const tools = rows.toolReceipts.map((row) =>
    checkedTool(requiredRow(row), locator),
  );
  const operations = rows.operations.map((row) =>
    checkedOperation(requiredRow(row), binding),
  );
  unique(steps.map((state) => state.stepId));
  unique(attempts.map((state) => state.attemptId));
  unique(workItems.map((item) => item.workItemId));
  unique(tools.map((state) => state.receiptId));
  unique(operations.map((state) => state.operationId));
  linkExecution(steps, attempts, workItems, tools);
  for (const tool of tools) {
    if (
      tool.actionIntent !== null &&
      (tool.actionIntent.policySnapshotId !== run.policySnapshotId ||
        tool.actionIntent.workspaceBindingId !== run.workspaceBindingId)
    )
      fail("plugin_credit_settlement_tool_authority_mismatch");
  }
  for (const operation of operations) {
    const matches = tools.filter(
      (tool) =>
        tool.effect === "mutation" &&
        tool.executionId === operation.executionId &&
        tool.actionDigest === operation.actionDigest &&
        tool.idempotencyKey === operation.idempotencyKey,
    );
    if (matches.length !== 1)
      fail("plugin_credit_settlement_operation_receipt_mismatch");
  }
  const mutations = tools.filter((tool) => tool.effect === "mutation");
  const readyToFinalize =
    terminal.has(run.status) &&
    run.terminalAt !== null &&
    workItems.length > 0 &&
    workItems.every((item) => item.status === "completed") &&
    steps.every((step) => terminalStep.has(step.status)) &&
    attempts.every((attempt) => attempt.status !== "running") &&
    operations.every(
      (operation) =>
        operation.status === "succeeded" || operation.status === "failed",
    ) &&
    mutations.every(
      (tool) =>
        tool.actionIntent !== null &&
        (tool.status === "completed"
          ? tool.result !== null
          : tool.status === "canceled" && tool.dispatchedAt === null),
    );
  return {
    run,
    steps,
    attempts,
    workItems,
    tools,
    operations,
    readyToFinalize,
  };
}

function checkedRun(
  row: SettlementRow,
  binding: ExtensionRunBinding,
): RunState {
  const parsed = record(json(row.state_json, 256 * 1024));
  allowed(parsed, [
    "runId",
    "threadId",
    "tenantId",
    "spaceId",
    "createdByActorId",
    "authorityId",
    "runtimeGeneration",
    "agentVersionId",
    "policySnapshotId",
    "workspaceBindingId",
    "workflowVersionBinding",
    "collaborationMode",
    "toolPermissionMode",
    "purpose",
    "origin",
    "goalBinding",
    "goalContinuationMode",
    "goalAccounting",
    "plan",
    "usage",
    "status",
    "revision",
    "lastSequence",
    "cancelRequested",
    "waitingApproval",
    "suspensionReasonCode",
    "reconciliationReceiptId",
    "outputRef",
    "failure",
    "createdAt",
    "updatedAt",
    "terminalAt",
  ]);
  const state = normalizeStoredRunState(parsed as unknown as RunState, code);
  indexed(row, state, {
    tenant_id: "tenantId",
    space_id: "spaceId",
    run_id: "runId",
    revision: "revision",
    last_sequence: "lastSequence",
    thread_id: "threadId",
    updated_at: "updatedAt",
  });
  assertSettlementRunTarget(state, binding);
  if (
    !RUN_STATUSES.includes(state.status) ||
    typeof state.cancelRequested !== "boolean" ||
    integer(state.revision, 1) !== state.revision ||
    integer(state.lastSequence, 1) !== state.lastSequence ||
    terminal.has(state.status) !== (state.terminalAt !== null)
  )
    fail("plugin_credit_settlement_run_mismatch");
  ordered(state.createdAt, state.updatedAt, state.terminalAt);
  return state;
}

export function assertSettlementRunTarget(
  state: RunState,
  binding: ExtensionRunBinding,
): void {
  if (
    state.runId !== binding.runId ||
    state.tenantId !== binding.tenantId ||
    state.spaceId !== binding.spaceId ||
    state.threadId !== binding.threadId ||
    state.createdByActorId !== binding.actorId ||
    state.agentVersionId !== binding.target.agentVersionId ||
    state.authorityId !== binding.target.authorityId ||
    state.runtimeGeneration !== binding.target.runtimeGeneration ||
    state.policySnapshotId !== binding.target.policySnapshotId ||
    state.workspaceBindingId !== binding.target.workspaceBindingId
  )
    fail("plugin_credit_settlement_run_mismatch");
}

function checkedStep(
  row: SettlementRow,
  locator: PluginCreditSettlementLocator,
): RunStepState {
  const value = record(json(row.state_json, 8192), [
    "schemaVersion",
    "stepId",
    "tenantId",
    "runId",
    "kind",
    "status",
    "revision",
    "currentAttemptId",
    "attemptCount",
    "createdAt",
    "updatedAt",
    "terminalAt",
  ]);
  if (
    value.schemaVersion !== "crewon.run-step.v0" ||
    ![
      "model",
      "tool",
      "agent",
      "workflowNode",
      "gate",
      "verification",
    ].includes(String(value.kind)) ||
    ![
      "pending",
      "ready",
      "running",
      "waitingApproval",
      "completed",
      "failed",
      "skipped",
      "canceled",
    ].includes(String(value.status))
  )
    fail();
  const state = value as unknown as RunStepState;
  indexed(row, state, {
    tenant_id: "tenantId",
    run_id: "runId",
    step_id: "stepId",
    kind: "kind",
    status: "status",
    revision: "revision",
    current_attempt_id: "currentAttemptId",
    attempt_count: "attemptCount",
    created_at: "createdAt",
    updated_at: "updatedAt",
    terminal_at: "terminalAt",
  });
  runIdentity(state, locator);
  extensionOpaqueId(state.stepId);
  if (
    state.revision !== integer(state.revision, 1) ||
    state.attemptCount !== integer(state.attemptCount)
  )
    fail();
  if (
    (state.attemptCount === 0) !== (state.currentAttemptId === null) ||
    terminalStep.has(state.status) !== (state.terminalAt !== null)
  )
    fail();
  if (state.currentAttemptId !== null)
    extensionOpaqueId(state.currentAttemptId);
  ordered(state.createdAt, state.updatedAt, state.terminalAt);
  return state;
}

function checkedAttempt(
  row: SettlementRow,
  locator: PluginCreditSettlementLocator,
): RunAttemptState {
  const parsed = record(json(row.state_json, 256 * 1024));
  allowed(parsed, [
    "schemaVersion",
    "attemptId",
    "tenantId",
    "runId",
    "stepId",
    "workItemId",
    "attemptNumber",
    "retryOfAttemptId",
    "leaseEpoch",
    "status",
    "checkpointDigest",
    "providerCheckpoint",
    "providerTurnState",
    "failure",
    "startedAt",
    "updatedAt",
    "terminalAt",
  ]);
  const state = {
    ...parsed,
    providerCheckpoint: parsed.providerCheckpoint ?? null,
    providerTurnState: validateProviderTurnState(parsed.providerTurnState),
  } as unknown as RunAttemptState;
  if (
    state.schemaVersion !== "crewon.run-attempt.v0" ||
    !["running", "completed", "failed", "canceled", "abandoned"].includes(
      state.status,
    )
  )
    fail();
  indexed(row, state, {
    tenant_id: "tenantId",
    run_id: "runId",
    step_id: "stepId",
    attempt_id: "attemptId",
    work_item_id: "workItemId",
    attempt_number: "attemptNumber",
    retry_of_attempt_id: "retryOfAttemptId",
    lease_epoch: "leaseEpoch",
    status: "status",
    started_at: "startedAt",
    updated_at: "updatedAt",
    terminal_at: "terminalAt",
  });
  runIdentity(state, locator);
  for (const id of [state.attemptId, state.stepId, state.workItemId])
    extensionOpaqueId(id);
  if (
    state.attemptNumber !== integer(state.attemptNumber, 1) ||
    state.leaseEpoch !== integer(state.leaseEpoch, 1)
  )
    fail();
  if (
    (state.attemptNumber === 1) !== (state.retryOfAttemptId === null) ||
    (state.status === "running") !== (state.terminalAt === null)
  )
    fail();
  if (state.retryOfAttemptId !== null)
    extensionOpaqueId(state.retryOfAttemptId);
  if (state.checkpointDigest !== null) extensionDigest(state.checkpointDigest);
  if (state.providerCheckpoint !== null)
    parseExecutionProviderCheckpoint(state.providerCheckpoint);
  if (state.status === "failed") {
    const failure = record(state.failure, ["code", "retryable"]);
    extensionOpaqueId(failure.code);
    if (typeof failure.retryable !== "boolean") fail();
  } else if (state.failure !== null) fail();
  ordered(state.startedAt, state.updatedAt, state.terminalAt);
  return state;
}

type CheckedWorkItem = Readonly<{
  workItemId: string;
  status: string;
  leaseEpoch: number;
  attemptCount: number;
  leaseOwnerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  completedAt: string | null;
  availableAt: string;
  createdAt: string;
  lastErrorCode: string | null;
  record: Record<string, unknown>;
}>;
function checkedWorkItem(
  row: SettlementRow,
  locator: PluginCreditSettlementLocator,
): CheckedWorkItem {
  const item = record(json(row.work_item_json, 64 * 1024), [
    "workItemId",
    "tenantId",
    "runId",
    "kind",
    "payload",
    "createdAt",
  ]);
  runIdentity(item, locator);
  indexed(row, item, {
    work_item_id: "workItemId",
    tenant_id: "tenantId",
    run_id: "runId",
    kind: "kind",
    created_at: "createdAt",
  });
  if (item.kind !== "run.execute") fail();
  record(item.payload);
  const status = String(row.status);
  if (!["pending", "leased", "completed"].includes(status)) fail();
  const leaseOwnerId = nullableId(row.lease_owner_id),
    leaseId = nullableId(row.lease_id);
  const leaseExpiresAt = queueTime(row, "lease_expires_at"),
    completedAt = queueTime(row, "completed_at"),
    availableAt = queueTime(row, "available_at");
  if (
    availableAt === null ||
    (status === "leased"
      ? leaseOwnerId === null ||
        leaseId === null ||
        leaseExpiresAt === null ||
        completedAt !== null
      : leaseOwnerId !== null ||
        leaseId !== null ||
        leaseExpiresAt !== null ||
        (status === "completed") !== (completedAt !== null))
  )
    fail("plugin_credit_settlement_lease_invalid");
  return Object.freeze({
    workItemId: extensionOpaqueId(item.workItemId),
    status,
    leaseEpoch: integer(row.lease_epoch),
    attemptCount: integer(row.attempt_count),
    leaseOwnerId,
    leaseId,
    leaseExpiresAt,
    completedAt,
    availableAt,
    createdAt: timestamp(item.createdAt),
    lastErrorCode: nullableId(row.last_error_code),
    record: item,
  });
}

function checkedTool(
  row: SettlementRow,
  locator: PluginCreditSettlementLocator,
): ToolExecutionReceiptState {
  if (
    typeof row.state_json === "string" &&
    Buffer.byteLength(row.state_json) > 384 * 1024
  )
    fail("plugin_credit_settlement_json_limit");
  const decoded =
    typeof row.state_json === "string"
      ? decodeSqliteToolReceiptState(row.state_json)
      : row.state_json;
  const value = record(json(decoded, 384 * 1024), [
    "schemaVersion",
    "receiptId",
    "tenantId",
    "runId",
    "stepId",
    "attemptId",
    "workItemId",
    "executionId",
    "idempotencyKey",
    "actionDigest",
    "actionIntent",
    "call",
    "effect",
    "recovery",
    "status",
    "revision",
    "providerReceiptId",
    "result",
    "preparedAt",
    "dispatchedAt",
    "updatedAt",
    "resolvedAt",
  ]);
  record(value.call, ["segmentId", "callId", "kind", "name", "inputDigest"]);
  const state = value as unknown as ToolExecutionReceiptState;
  if (state.actionIntent !== null) {
    const intent = record(state.actionIntent, [
      "schemaVersion",
      "runId",
      "segmentId",
      "callId",
      "tool",
      "effect",
      "recovery",
      "policySnapshotId",
      "workspaceBindingId",
      "resourceBindingId",
      "credentialBindingId",
      "executionTarget",
      "capability",
      "approvalRequirement",
      "limits",
    ]);
    record(intent.tool, ["kind", "name", "inputDigest"]);
    record(intent.executionTarget, ["kind", "bindingId"]);
    record(intent.limits, ["timeoutMs", "maxOutputBytes", "maxArtifactBytes"]);
  }
  validateToolExecutionReceipt(state);
  runIdentity(state, locator);
  indexed(row, state, {
    receipt_id: "receiptId",
    tenant_id: "tenantId",
    run_id: "runId",
    step_id: "stepId",
    attempt_id: "attemptId",
    work_item_id: "workItemId",
    action_digest: "actionDigest",
    idempotency_key: "idempotencyKey",
    status: "status",
    revision: "revision",
    prepared_at: "preparedAt",
    updated_at: "updatedAt",
    resolved_at: "resolvedAt",
  });
  if (state.result !== null) {
    const result = record(state.result);
    allowed(result, [
      "output",
      "outputDigest",
      "isError",
      "artifactRef",
      "workspaceChanges",
    ]);
    if (
      extensionStoreDigester.sha256(state.result.output) !==
      state.result.outputDigest
    )
      fail("plugin_credit_settlement_tool_result_digest_mismatch");
  }
  return state;
}

function checkedOperation(row: SettlementRow, binding: ExtensionRunBinding) {
  const operation = parseExternalOperation(json(row.record_json, 24 * 1024));
  indexed(row, operation, {
    tenant_id: "tenantId",
    run_id: "runId",
    binding_digest: "bindingDigest",
    operation_id: "operationId",
    idempotency_key: "idempotencyKey",
    revision: "revision",
  });
  if (
    operation.tenantId !== binding.tenantId ||
    operation.runId !== binding.runId ||
    operation.bindingDigest !== binding.bindingDigest
  )
    fail("plugin_credit_settlement_operation_binding_mismatch");
  return operation;
}

function linkExecution(
  steps: readonly RunStepState[],
  attempts: readonly RunAttemptState[],
  workItems: readonly CheckedWorkItem[],
  tools: readonly ToolExecutionReceiptState[],
): void {
  const byStep = new Map(steps.map((state) => [state.stepId, state]));
  const byAttempt = new Map(attempts.map((state) => [state.attemptId, state]));
  const byWork = new Map(workItems.map((item) => [item.workItemId, item]));
  for (const step of steps) {
    const history = attempts
      .filter((attempt) => attempt.stepId === step.stepId)
      .sort((left, right) => left.attemptNumber - right.attemptNumber);
    if (
      history.length !== step.attemptCount ||
      (history.at(-1)?.attemptId ?? null) !== step.currentAttemptId ||
      history.some(
        (attempt, index) =>
          attempt.attemptNumber !== index + 1 ||
          attempt.retryOfAttemptId !== (history[index - 1]?.attemptId ?? null),
      )
    )
      fail("plugin_credit_settlement_attempt_history_mismatch");
  }
  for (const attempt of attempts) {
    const item = byWork.get(attempt.workItemId);
    if (
      !byStep.has(attempt.stepId) ||
      item === undefined ||
      attempt.leaseEpoch > item.leaseEpoch ||
      item.attemptCount < 1
    )
      fail("plugin_credit_settlement_attempt_lease_mismatch");
  }
  for (const tool of tools) {
    const step = byStep.get(tool.stepId),
      attempt = byAttempt.get(tool.attemptId);
    if (
      step?.kind !== "tool" ||
      attempt === undefined ||
      attempt.stepId !== tool.stepId ||
      attempt.workItemId !== tool.workItemId ||
      !byWork.has(tool.workItemId)
    )
      fail("plugin_credit_settlement_tool_attempt_mismatch");
  }
}
