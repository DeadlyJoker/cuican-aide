export type ToolExecutionEffect = "readOnly" | "mutation";
export type ToolExecutionRecovery = "replaySafe" | "reconcilable";
export type ToolActionIntentState = Readonly<{
  schemaVersion: "crewon.action-intent.v0";
  runId: string;
  segmentId: string;
  callId: string;
  tool: Readonly<{
    kind: "function" | "custom";
    name: string;
    inputDigest: string;
  }>;
  effect: ToolExecutionEffect;
  recovery: ToolExecutionRecovery;
  policySnapshotId: string;
  workspaceBindingId: string | null;
  resourceBindingId: string | null;
  credentialBindingId: string | null;
  executionTarget: Readonly<{
    kind: "control" | "device" | "docker" | "remote";
    bindingId: string;
  }>;
  capability: string;
  approvalRequirement: "none" | "perAction";
  limits: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  }>;
}>;
export type ToolExecutionReceiptStatus =
  | "prepared"
  | "dispatched"
  | "unknownOutcome"
  | "completed"
  | "canceled";

export type ToolExecutionResult = Readonly<{
  output: string;
  outputDigest: string;
  isError: boolean;
  artifactRef: string | null;
}>;

export type ToolExecutionReceiptState = Readonly<{
  schemaVersion: "crewon.tool-execution-receipt.v0";
  receiptId: string;
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  workItemId: string;
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  actionIntent: ToolActionIntentState | null;
  call: Readonly<{
    segmentId: string;
    callId: string;
    kind: "function" | "custom";
    name: string;
    inputDigest: string;
  }>;
  effect: ToolExecutionEffect;
  recovery: ToolExecutionRecovery;
  status: ToolExecutionReceiptStatus;
  revision: number;
  providerReceiptId: string | null;
  result: ToolExecutionResult | null;
  preparedAt: string;
  dispatchedAt: string | null;
  updatedAt: string;
  resolvedAt: string | null;
}>;

export class ToolExecutionReceiptError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ToolExecutionReceiptError";
    this.code = code;
  }
}

export function prepareToolExecutionReceipt(
  input: Readonly<{
    receiptId: string;
    tenantId: string;
    runId: string;
    stepId: string;
    attemptId: string;
    workItemId: string;
    executionId: string;
    idempotencyKey: string;
    actionDigest: string;
    actionIntent: ToolActionIntentState;
    call: ToolExecutionReceiptState["call"];
    effect: ToolExecutionEffect;
    recovery: ToolExecutionRecovery;
    preparedAt: string;
  }>,
): ToolExecutionReceiptState {
  const receipt: ToolExecutionReceiptState = {
    schemaVersion: "crewon.tool-execution-receipt.v0",
    receiptId: input.receiptId,
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: input.stepId,
    attemptId: input.attemptId,
    workItemId: input.workItemId,
    executionId: input.executionId,
    idempotencyKey: input.idempotencyKey,
    actionDigest: input.actionDigest,
    actionIntent: input.actionIntent,
    call: input.call,
    effect: input.effect,
    recovery: input.recovery,
    status: "prepared",
    revision: 1,
    providerReceiptId: null,
    result: null,
    preparedAt: input.preparedAt,
    dispatchedAt: null,
    updatedAt: input.preparedAt,
    resolvedAt: null,
  };
  validateToolExecutionReceipt(receipt);
  return receipt;
}

export function dispatchToolExecutionReceipt(
  receipt: ToolExecutionReceiptState,
  dispatchedAt: string,
): ToolExecutionReceiptState {
  validateToolExecutionReceipt(receipt);
  requireStatus(receipt, ["prepared"]);
  requireOrderedTimestamp(
    dispatchedAt,
    receipt.updatedAt,
    "tool_receipt_dispatched_at_invalid",
  );
  return {
    ...receipt,
    status: "dispatched",
    revision: receipt.revision + 1,
    dispatchedAt,
    updatedAt: dispatchedAt,
  };
}

export function markToolExecutionUnknownOutcome(
  receipt: ToolExecutionReceiptState,
  input: Readonly<{
    observedAt: string;
    providerReceiptId: string | null;
  }>,
): ToolExecutionReceiptState {
  validateToolExecutionReceipt(receipt);
  requireStatus(receipt, ["dispatched"]);
  requireOrderedTimestamp(
    input.observedAt,
    receipt.updatedAt,
    "tool_receipt_observed_at_invalid",
  );
  requireNullableBoundedNonEmpty(
    input.providerReceiptId,
    512,
    "tool_provider_receipt_id_invalid",
  );
  return {
    ...receipt,
    status: "unknownOutcome",
    revision: receipt.revision + 1,
    providerReceiptId: input.providerReceiptId,
    updatedAt: input.observedAt,
  };
}

export function resolveToolExecutionReceipt(
  receipt: ToolExecutionReceiptState,
  resolution:
    | Readonly<{
        status: "completed";
        resolvedAt: string;
        providerReceiptId: string;
        result: ToolExecutionResult;
      }>
    | Readonly<{
        status: "canceled";
        resolvedAt: string;
        providerReceiptId: string | null;
      }>,
): ToolExecutionReceiptState {
  validateToolExecutionReceipt(receipt);
  requireStatus(receipt, ["prepared", "dispatched", "unknownOutcome"]);
  requireOrderedTimestamp(
    resolution.resolvedAt,
    receipt.updatedAt,
    "tool_receipt_resolved_at_invalid",
  );
  requireNullableBoundedNonEmpty(
    resolution.providerReceiptId,
    512,
    "tool_provider_receipt_id_invalid",
  );
  if (resolution.status === "completed") {
    if (receipt.status === "prepared") {
      throw new ToolExecutionReceiptError("tool_receipt_not_dispatched");
    }
    validateResult(resolution.result);
  }
  const next: ToolExecutionReceiptState = {
    ...receipt,
    status: resolution.status,
    revision: receipt.revision + 1,
    providerReceiptId: resolution.providerReceiptId,
    result: resolution.status === "completed" ? resolution.result : null,
    updatedAt: resolution.resolvedAt,
    resolvedAt: resolution.resolvedAt,
  };
  validateToolExecutionReceipt(next);
  return next;
}

/** Validates decoded durable state before it is trusted by an execution worker. */
export function validateToolExecutionReceipt(
  receipt: ToolExecutionReceiptState,
): void {
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    receipt.schemaVersion !== "crewon.tool-execution-receipt.v0"
  ) {
    throw new ToolExecutionReceiptError("tool_receipt_schema_invalid");
  }
  for (const value of [
    receipt.receiptId,
    receipt.tenantId,
    receipt.runId,
    receipt.stepId,
    receipt.attemptId,
    receipt.workItemId,
    receipt.executionId,
    receipt.idempotencyKey,
    receipt.call.segmentId,
    receipt.call.callId,
  ]) {
    requireBoundedNonEmpty(value, 512, "tool_receipt_identity_invalid");
  }
  requireDigest(receipt.actionDigest, "tool_action_digest_invalid");
  if (receipt.actionIntent !== null) {
    validateActionIntent(receipt.actionIntent, receipt);
  }
  requireDigest(receipt.call.inputDigest, "tool_input_digest_invalid");
  if (
    (receipt.call.kind !== "function" && receipt.call.kind !== "custom") ||
    !/^[A-Za-z0-9_.:-]{1,128}$/.test(receipt.call.name)
  ) {
    throw new ToolExecutionReceiptError("tool_call_identity_invalid");
  }
  if (
    (receipt.effect !== "readOnly" && receipt.effect !== "mutation") ||
    (receipt.recovery !== "replaySafe" && receipt.recovery !== "reconcilable")
  ) {
    throw new ToolExecutionReceiptError("tool_recovery_policy_invalid");
  }
  if (receipt.effect === "mutation" && receipt.recovery !== "reconcilable") {
    throw new ToolExecutionReceiptError("tool_mutation_not_reconcilable");
  }
  if (
    ![
      "prepared",
      "dispatched",
      "unknownOutcome",
      "completed",
      "canceled",
    ].includes(receipt.status) ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 1
  ) {
    throw new ToolExecutionReceiptError("tool_receipt_state_invalid");
  }
  requireTimestamp(receipt.preparedAt, "tool_receipt_prepared_at_invalid");
  requireTimestamp(receipt.updatedAt, "tool_receipt_updated_at_invalid");
  requireNullableBoundedNonEmpty(
    receipt.providerReceiptId,
    512,
    "tool_provider_receipt_id_invalid",
  );
  validateStateShape(receipt);
}

function validateActionIntent(
  intent: ToolActionIntentState,
  receipt: ToolExecutionReceiptState,
): void {
  if (
    typeof intent !== "object" ||
    intent === null ||
    intent.schemaVersion !== "crewon.action-intent.v0" ||
    intent.runId !== receipt.runId ||
    intent.segmentId !== receipt.call.segmentId ||
    intent.callId !== receipt.call.callId ||
    typeof intent.tool !== "object" ||
    intent.tool === null ||
    intent.tool.kind !== receipt.call.kind ||
    intent.tool.name !== receipt.call.name ||
    intent.tool.inputDigest !== receipt.call.inputDigest ||
    intent.effect !== receipt.effect ||
    intent.recovery !== receipt.recovery
  ) {
    throw new ToolExecutionReceiptError("tool_action_intent_mismatch");
  }
  requireBoundedNonEmpty(
    intent.policySnapshotId,
    512,
    "tool_action_policy_snapshot_invalid",
  );
  for (const value of [
    intent.workspaceBindingId,
    intent.resourceBindingId,
    intent.credentialBindingId,
  ]) {
    requireNullableOpaqueId(value, "tool_action_binding_invalid");
  }
  if (
    typeof intent.executionTarget !== "object" ||
    intent.executionTarget === null ||
    (intent.executionTarget.kind !== "control" &&
      intent.executionTarget.kind !== "device" &&
      intent.executionTarget.kind !== "docker" &&
      intent.executionTarget.kind !== "remote")
  ) {
    throw new ToolExecutionReceiptError("tool_action_target_invalid");
  }
  requireOpaqueId(
    intent.executionTarget.bindingId,
    "tool_action_target_invalid",
  );
  if (
    !/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,15}$/.test(intent.capability) ||
    intent.capability.length > 128
  ) {
    throw new ToolExecutionReceiptError("tool_action_capability_invalid");
  }
  if (
    intent.approvalRequirement !== "none" &&
    intent.approvalRequirement !== "perAction"
  ) {
    throw new ToolExecutionReceiptError("tool_action_approval_invalid");
  }
  if (
    typeof intent.limits !== "object" ||
    intent.limits === null ||
    !isPositiveIntegerAtMost(intent.limits.timeoutMs, 86_400_000) ||
    !isPositiveIntegerAtMost(intent.limits.maxOutputBytes, 1_048_576) ||
    !isPositiveIntegerAtMost(intent.limits.maxArtifactBytes, 1_073_741_824)
  ) {
    throw new ToolExecutionReceiptError("tool_action_limits_invalid");
  }
}

function validateStateShape(receipt: ToolExecutionReceiptState): void {
  const dispatchRequired =
    receipt.status === "dispatched" ||
    receipt.status === "unknownOutcome" ||
    receipt.status === "completed";
  const resolved =
    receipt.status === "completed" || receipt.status === "canceled";
  if (
    (receipt.status === "prepared" && receipt.dispatchedAt !== null) ||
    (dispatchRequired && receipt.dispatchedAt === null) ||
    resolved !== (receipt.resolvedAt !== null) ||
    (receipt.status === "completed") !== (receipt.result !== null)
  ) {
    throw new ToolExecutionReceiptError("tool_receipt_state_invalid");
  }
  if (receipt.dispatchedAt !== null) {
    requireOrderedTimestamp(
      receipt.dispatchedAt,
      receipt.preparedAt,
      "tool_receipt_dispatched_at_invalid",
    );
  }
  if (receipt.resolvedAt !== null) {
    requireOrderedTimestamp(
      receipt.resolvedAt,
      receipt.dispatchedAt ?? receipt.preparedAt,
      "tool_receipt_resolved_at_invalid",
    );
  }
  if (Date.parse(receipt.updatedAt) < Date.parse(receipt.preparedAt)) {
    throw new ToolExecutionReceiptError("tool_receipt_updated_at_invalid");
  }
  if (receipt.result !== null) {
    validateResult(receipt.result);
  }
}

function validateResult(result: ToolExecutionResult): void {
  if (
    typeof result.output !== "string" ||
    new TextEncoder().encode(result.output).byteLength > 256 * 1024 ||
    typeof result.isError !== "boolean"
  ) {
    throw new ToolExecutionReceiptError("tool_result_invalid");
  }
  requireDigest(result.outputDigest, "tool_output_digest_invalid");
  requireNullableBoundedNonEmpty(
    result.artifactRef,
    512,
    "tool_artifact_ref_invalid",
  );
}

function requireStatus(
  receipt: ToolExecutionReceiptState,
  allowed: readonly ToolExecutionReceiptStatus[],
): void {
  if (!allowed.includes(receipt.status)) {
    throw new ToolExecutionReceiptError(
      `tool_receipt_invalid_transition:${receipt.status}`,
    );
  }
}

function requireDigest(value: string, code: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ToolExecutionReceiptError(code);
  }
}

function requireOrderedTimestamp(
  value: string,
  earliest: string,
  code: string,
): void {
  requireTimestamp(value, code);
  if (Date.parse(value) < Date.parse(earliest)) {
    throw new ToolExecutionReceiptError(code);
  }
}

function requireTimestamp(value: string, code: string): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ToolExecutionReceiptError(code);
  }
}

function requireNullableBoundedNonEmpty(
  value: string | null,
  maxLength: number,
  code: string,
): void {
  if (value !== null) {
    requireBoundedNonEmpty(value, maxLength, code);
  }
}

function requireNullableOpaqueId(value: string | null, code: string): void {
  if (value !== null) {
    requireOpaqueId(value, code);
  }
}

function requireOpaqueId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw new ToolExecutionReceiptError(code);
  }
}

function isPositiveIntegerAtMost(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function requireBoundedNonEmpty(
  value: string,
  maxLength: number,
  code: string,
): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength
  ) {
    throw new ToolExecutionReceiptError(code);
  }
}
