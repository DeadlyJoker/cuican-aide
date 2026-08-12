export type ModelDispatchStatus =
  | "prepared"
  | "possiblySent"
  | "responseObserved"
  | "terminal";

export type ModelDispatchProviderIdentity = Readonly<{
  agentVersionId: string;
  adapterName: string;
  adapterVersion: string;
  modelId: string;
}>;

export type ModelDispatchTerminalOutcome = Readonly<{
  kind: "completed" | "failed" | "canceled";
  code: string | null;
}>;

/** Durable evidence for one model request owned by a Run Step Attempt. */
export type ModelDispatchReceipt = Readonly<{
  schemaVersion: "crewon.model-dispatch-receipt.v0";
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  workItemId: string;
  leaseEpoch: number;
  requestDigest: string;
  provider: ModelDispatchProviderIdentity;
  status: ModelDispatchStatus;
  revision: number;
  preparedAt: string;
  possiblySentAt: string | null;
  responseObservedAt: string | null;
  responseCheckpointDigest: string | null;
  terminalAt: string | null;
  terminalOutcome: ModelDispatchTerminalOutcome | null;
  updatedAt: string;
}>;

export class ModelDispatchReceiptError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ModelDispatchReceiptError";
    this.code = code;
  }
}

export function prepareModelDispatchReceipt(
  current: ModelDispatchReceipt | null,
  input: Readonly<{
    tenantId: string;
    runId: string;
    stepId: string;
    attemptId: string;
    workItemId: string;
    leaseEpoch: number;
    requestDigest: string;
    provider: ModelDispatchProviderIdentity;
    preparedAt: string;
  }>,
): ModelDispatchReceipt {
  validateIdentity(input);
  requireDigest(input.requestDigest, "model_dispatch_request_digest_invalid");
  requireTimestamp(input.preparedAt, "model_dispatch_prepared_at_invalid");
  if (current !== null) {
    validateModelDispatchReceipt(current);
    if (!sameAuthority(current, input)) {
      throw new ModelDispatchReceiptError("model_dispatch_receipt_conflict");
    }
    return current;
  }
  return {
    schemaVersion: "crewon.model-dispatch-receipt.v0",
    ...input,
    provider: { ...input.provider },
    status: "prepared",
    revision: 1,
    possiblySentAt: null,
    responseObservedAt: null,
    responseCheckpointDigest: null,
    terminalAt: null,
    terminalOutcome: null,
    updatedAt: input.preparedAt,
  };
}

export function markModelDispatchPossiblySent(
  current: ModelDispatchReceipt,
  sentAt: string,
): ModelDispatchReceipt {
  validateModelDispatchReceipt(current);
  requireTimestamp(sentAt, "model_dispatch_sent_at_invalid");
  if (current.possiblySentAt !== null) return current;
  if (current.status !== "prepared") {
    throw new ModelDispatchReceiptError("model_dispatch_transition_conflict");
  }
  return {
    ...current,
    status: "possiblySent",
    revision: current.revision + 1,
    possiblySentAt: sentAt,
    updatedAt: sentAt,
  };
}

export function observeModelDispatchResponse(
  current: ModelDispatchReceipt,
  input: Readonly<{ checkpointDigest: string; observedAt: string }>,
): ModelDispatchReceipt {
  validateModelDispatchReceipt(current);
  requireDigest(
    input.checkpointDigest,
    "model_dispatch_checkpoint_digest_invalid",
  );
  requireTimestamp(input.observedAt, "model_dispatch_observed_at_invalid");
  if (current.responseCheckpointDigest !== null) {
    if (current.responseCheckpointDigest !== input.checkpointDigest) {
      throw new ModelDispatchReceiptError("model_dispatch_response_conflict");
    }
    return current;
  }
  if (current.status !== "possiblySent") {
    throw new ModelDispatchReceiptError("model_dispatch_transition_conflict");
  }
  return {
    ...current,
    status: "responseObserved",
    revision: current.revision + 1,
    responseObservedAt: input.observedAt,
    responseCheckpointDigest: input.checkpointDigest,
    updatedAt: input.observedAt,
  };
}

export function terminateModelDispatchReceipt(
  current: ModelDispatchReceipt,
  input: Readonly<{
    outcome: ModelDispatchTerminalOutcome;
    terminalAt: string;
  }>,
): ModelDispatchReceipt {
  validateModelDispatchReceipt(current);
  requireTimestamp(input.terminalAt, "model_dispatch_terminal_at_invalid");
  validateOutcome(input.outcome);
  if (current.terminalOutcome !== null) {
    if (!sameOutcome(current.terminalOutcome, input.outcome)) {
      throw new ModelDispatchReceiptError("model_dispatch_terminal_conflict");
    }
    return current;
  }
  return {
    ...current,
    status: "terminal",
    revision: current.revision + 1,
    terminalAt: input.terminalAt,
    terminalOutcome: { ...input.outcome },
    updatedAt: input.terminalAt,
  };
}

export function validateModelDispatchReceipt(
  receipt: ModelDispatchReceipt,
): void {
  validateIdentity(receipt);
  requireDigest(receipt.requestDigest, "model_dispatch_request_digest_invalid");
  requireTimestamp(receipt.preparedAt, "model_dispatch_prepared_at_invalid");
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw new ModelDispatchReceiptError("model_dispatch_revision_invalid");
  }
  const sent = receipt.possiblySentAt !== null;
  const observed = receipt.responseObservedAt !== null;
  const terminal = receipt.terminalAt !== null;
  if (sent)
    requireTimestamp(receipt.possiblySentAt!, "model_dispatch_sent_at_invalid");
  if (observed) {
    requireTimestamp(
      receipt.responseObservedAt!,
      "model_dispatch_observed_at_invalid",
    );
    if (!sent || receipt.responseCheckpointDigest === null) invalidStored();
    requireDigest(
      receipt.responseCheckpointDigest,
      "model_dispatch_checkpoint_digest_invalid",
    );
  } else if (receipt.responseCheckpointDigest !== null) {
    invalidStored();
  }
  if (terminal) {
    requireTimestamp(receipt.terminalAt!, "model_dispatch_terminal_at_invalid");
    if (receipt.terminalOutcome === null) invalidStored();
    validateOutcome(receipt.terminalOutcome!);
  } else if (receipt.terminalOutcome !== null) {
    invalidStored();
  }
  if (
    (receipt.status === "prepared" && (sent || observed || terminal)) ||
    (receipt.status === "possiblySent" && (!sent || observed || terminal)) ||
    (receipt.status === "responseObserved" && (!observed || terminal)) ||
    (receipt.status === "terminal" && !terminal)
  ) {
    invalidStored();
  }
}

function validateIdentity(input: {
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  workItemId: string;
  leaseEpoch: number;
  provider: ModelDispatchProviderIdentity;
}): void {
  for (const value of [
    input.tenantId,
    input.runId,
    input.stepId,
    input.attemptId,
    input.workItemId,
    input.provider.agentVersionId,
    input.provider.adapterName,
    input.provider.adapterVersion,
    input.provider.modelId,
  ]) {
    if (value.trim().length === 0) {
      throw new ModelDispatchReceiptError("model_dispatch_identity_invalid");
    }
  }
  if (!Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 1) {
    throw new ModelDispatchReceiptError("model_dispatch_identity_invalid");
  }
}

function sameAuthority(
  receipt: ModelDispatchReceipt,
  input: Parameters<typeof prepareModelDispatchReceipt>[1],
): boolean {
  return (
    receipt.tenantId === input.tenantId &&
    receipt.runId === input.runId &&
    receipt.stepId === input.stepId &&
    receipt.attemptId === input.attemptId &&
    receipt.workItemId === input.workItemId &&
    receipt.leaseEpoch === input.leaseEpoch &&
    receipt.requestDigest === input.requestDigest &&
    JSON.stringify(receipt.provider) === JSON.stringify(input.provider)
  );
}

function validateOutcome(outcome: ModelDispatchTerminalOutcome): void {
  if (
    (outcome.kind === "completed" && outcome.code !== null) ||
    (outcome.kind !== "completed" && (outcome.code?.trim().length ?? 0) === 0)
  ) {
    throw new ModelDispatchReceiptError("model_dispatch_outcome_invalid");
  }
}

function sameOutcome(
  left: ModelDispatchTerminalOutcome,
  right: ModelDispatchTerminalOutcome,
): boolean {
  return left.kind === right.kind && left.code === right.code;
}

function requireDigest(value: string, code: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ModelDispatchReceiptError(code);
  }
}

function requireTimestamp(value: string, code: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ModelDispatchReceiptError(code);
  }
}

function invalidStored(): never {
  throw new ModelDispatchReceiptError("stored_model_dispatch_receipt_invalid");
}
