export type WorkspaceDeliveryPhase = "execute" | "reconcile" | "cancel";

export type WorkspaceDeliveryLease = Readonly<{
  schemaVersion: "crewon.workspace-delivery-lease.v0";
  executionId: string;
  attemptNumber: number;
  phase: WorkspaceDeliveryPhase;
  ownerId: string;
  leaseId: string;
  epoch: number;
  leasedAt: string;
  expiresAt: string;
}>;

export type WorkspaceDeliverySettlement = Readonly<{
  kind: "resolution" | "superseded" | "leaseExpired" | "abandoned";
  resolutionStatus:
    | "completed"
    | "failed"
    | "canceled"
    | "unknownOutcome"
    | null;
  settledAt: string;
  resultRevision: number;
  resultDigest: string;
}>;

export type WorkspaceDeliveryAttempt = Readonly<{
  schemaVersion: "crewon.workspace-delivery-attempt.v0";
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  attemptNumber: number;
  operationRevision: number;
  phase: WorkspaceDeliveryPhase;
  status: "pending" | "leased" | "settled";
  actionDigest: string;
  commandDigest: string;
  createdAt: string;
  lease: WorkspaceDeliveryLease | null;
  settlement: WorkspaceDeliverySettlement | null;
}>;

export type ClaimWorkspaceDeliveryInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  attemptNumber: number;
  operationRevision: number;
  phase: WorkspaceDeliveryPhase;
  ownerId: string;
  leaseDurationMs: number;
}>;

export type AbandonWorkspaceDeliveryInput = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  operationRevision: number;
  deliveryLease: WorkspaceDeliveryLease;
  reason: "notSent";
}>;

export type WorkspaceDeliveryAttemptQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  executionId: string;
  afterAttemptNumber: number;
  limit: number;
  view: "audit" | "claimable";
}>;

export class WorkspaceListDispatchError extends Error {
  readonly certainty: "notSent" | "possiblySent";

  constructor(certainty: "notSent" | "possiblySent", options?: ErrorOptions) {
    super(`workspace_dispatch_${certainty}`, options);
    this.name = "WorkspaceListDispatchError";
    this.certainty = certainty;
  }
}

export function validateWorkspaceDeliveryAttempt(
  input: unknown,
): WorkspaceDeliveryAttempt {
  if (
    !exactKeys(input, [
      "actionDigest",
      "attemptNumber",
      "commandDigest",
      "createdAt",
      "executionId",
      "lease",
      "operationRevision",
      "phase",
      "schemaVersion",
      "settlement",
      "spaceId",
      "status",
      "tenantId",
      "threadId",
    ]) ||
    input.schemaVersion !== "crewon.workspace-delivery-attempt.v0" ||
    !deliveryPhase(input.phase)
  ) {
    throw deliveryError("workspace_delivery_attempt_invalid");
  }
  const lease =
    input.lease === null ? null : validateWorkspaceDeliveryLease(input.lease);
  const settlement =
    input.settlement === null
      ? null
      : validateWorkspaceDeliverySettlement(input.settlement);
  if (
    (input.status !== "pending" &&
      input.status !== "leased" &&
      input.status !== "settled") ||
    (input.status === "pending" && (lease !== null || settlement !== null)) ||
    (input.status === "leased" && (lease === null || settlement !== null)) ||
    (input.status === "settled" &&
      (settlement === null ||
        (lease === null && settlement.kind !== "superseded")))
  ) {
    throw deliveryError("workspace_delivery_attempt_invalid");
  }
  const attempt = {
    schemaVersion: "crewon.workspace-delivery-attempt.v0" as const,
    tenantId: opaqueId(input.tenantId),
    spaceId: opaqueId(input.spaceId),
    threadId: opaqueId(input.threadId),
    executionId: opaqueId(input.executionId),
    attemptNumber: positiveInteger(input.attemptNumber),
    operationRevision: positiveInteger(input.operationRevision),
    phase: input.phase,
    status: input.status as WorkspaceDeliveryAttempt["status"],
    actionDigest: digest(input.actionDigest),
    commandDigest: digest(input.commandDigest),
    createdAt: timestamp(input.createdAt),
    lease,
    settlement,
  };
  if (
    lease !== null &&
    (lease.executionId !== attempt.executionId ||
      lease.attemptNumber !== attempt.attemptNumber ||
      lease.phase !== attempt.phase ||
      Date.parse(lease.leasedAt) < Date.parse(attempt.createdAt))
  ) {
    throw deliveryError("workspace_delivery_attempt_invalid");
  }
  if (
    settlement !== null &&
    lease !== null &&
    Date.parse(settlement.settledAt) < Date.parse(lease.leasedAt)
  ) {
    throw deliveryError("workspace_delivery_attempt_invalid");
  }
  if (
    settlement !== null &&
    ((settlement.kind === "resolution" &&
      settlement.resultRevision !== attempt.operationRevision + 1) ||
      ((settlement.kind === "abandoned" ||
        settlement.kind === "leaseExpired") &&
        settlement.resultRevision !== attempt.operationRevision) ||
      (settlement.kind === "superseded" &&
        settlement.resultRevision !== attempt.operationRevision &&
        settlement.resultRevision !== attempt.operationRevision + 1))
  ) {
    throw deliveryError("workspace_delivery_attempt_invalid");
  }
  return attempt;
}

export function validateWorkspaceDeliveryLease(
  input: unknown,
): WorkspaceDeliveryLease {
  if (
    !exactKeys(input, [
      "attemptNumber",
      "epoch",
      "executionId",
      "expiresAt",
      "leaseId",
      "leasedAt",
      "ownerId",
      "phase",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== "crewon.workspace-delivery-lease.v0" ||
    !deliveryPhase(input.phase)
  ) {
    throw deliveryError("workspace_delivery_lease_invalid");
  }
  const lease = {
    schemaVersion: "crewon.workspace-delivery-lease.v0" as const,
    executionId: opaqueId(input.executionId),
    attemptNumber: positiveInteger(input.attemptNumber),
    phase: input.phase,
    ownerId: boundedIdentity(input.ownerId),
    leaseId: opaqueId(input.leaseId),
    epoch: positiveInteger(input.epoch),
    leasedAt: timestamp(input.leasedAt),
    expiresAt: timestamp(input.expiresAt),
  };
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.leasedAt)) {
    throw deliveryError("workspace_delivery_lease_invalid");
  }
  return lease;
}

export function validateClaimWorkspaceDeliveryInput(
  input: ClaimWorkspaceDeliveryInput,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  opaqueId(input.threadId);
  opaqueId(input.executionId);
  positiveInteger(input.attemptNumber);
  positiveInteger(input.operationRevision);
  if (!deliveryPhase(input.phase)) {
    throw deliveryError("workspace_delivery_phase_invalid");
  }
  boundedIdentity(input.ownerId);
  if (
    !Number.isSafeInteger(input.leaseDurationMs) ||
    input.leaseDurationMs < 1_000 ||
    input.leaseDurationMs > 5 * 60_000
  ) {
    throw deliveryError("workspace_delivery_lease_duration_invalid");
  }
}

export function validateAbandonWorkspaceDeliveryInput(
  input: AbandonWorkspaceDeliveryInput,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  opaqueId(input.threadId);
  opaqueId(input.executionId);
  positiveInteger(input.operationRevision);
  const lease = validateWorkspaceDeliveryLease(input.deliveryLease);
  if (lease.executionId !== input.executionId || input.reason !== "notSent") {
    throw deliveryError("workspace_delivery_abandon_invalid");
  }
}

export function validateWorkspaceDeliveryAttemptQuery(
  input: WorkspaceDeliveryAttemptQuery,
): void {
  opaqueId(input.tenantId);
  opaqueId(input.spaceId);
  opaqueId(input.threadId);
  opaqueId(input.executionId);
  if (
    !Number.isSafeInteger(input.afterAttemptNumber) ||
    input.afterAttemptNumber < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.view !== "audit" && input.view !== "claimable")
  ) {
    throw deliveryError("workspace_delivery_query_invalid");
  }
}

function validateWorkspaceDeliverySettlement(
  input: unknown,
): WorkspaceDeliverySettlement {
  if (
    !exactKeys(input, [
      "kind",
      "resolutionStatus",
      "resultDigest",
      "resultRevision",
      "settledAt",
    ]) ||
    (input.kind !== "resolution" &&
      input.kind !== "superseded" &&
      input.kind !== "leaseExpired" &&
      input.kind !== "abandoned") ||
    (input.resolutionStatus !== null &&
      input.resolutionStatus !== "completed" &&
      input.resolutionStatus !== "failed" &&
      input.resolutionStatus !== "canceled" &&
      input.resolutionStatus !== "unknownOutcome") ||
    (input.kind === "resolution") !== (input.resolutionStatus !== null)
  ) {
    throw deliveryError("workspace_delivery_settlement_invalid");
  }
  return {
    kind: input.kind,
    resolutionStatus: input.resolutionStatus,
    resultRevision: positiveInteger(input.resultRevision),
    resultDigest: digest(input.resultDigest),
    settledAt: timestamp(input.settledAt),
  };
}

function deliveryPhase(input: unknown): input is WorkspaceDeliveryPhase {
  return input === "execute" || input === "reconcile" || input === "cancel";
}

function opaqueId(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(input)
  ) {
    throw deliveryError("workspace_delivery_identity_invalid");
  }
  return input;
}

function boundedIdentity(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.trim().length === 0 ||
    input !== input.trim() ||
    new TextEncoder().encode(input).byteLength > 512 ||
    /[\0\r\n]/u.test(input)
  ) {
    throw deliveryError("workspace_delivery_identity_invalid");
  }
  return input;
}

function positiveInteger(input: unknown): number {
  if (!Number.isSafeInteger(input) || Number(input) < 1) {
    throw deliveryError("workspace_delivery_revision_invalid");
  }
  return Number(input);
}

function digest(input: unknown): string {
  if (typeof input !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(input)) {
    throw deliveryError("workspace_delivery_digest_invalid");
  }
  return input;
}

function timestamp(input: unknown): string {
  const milliseconds = typeof input === "string" ? Date.parse(input) : NaN;
  if (
    typeof input !== "string" ||
    !Number.isFinite(milliseconds) ||
    !input.endsWith("Z") ||
    new Date(milliseconds).toISOString() !== input
  ) {
    throw deliveryError("workspace_delivery_timestamp_invalid");
  }
  return input;
}

function exactKeys(
  input: unknown,
  expected: readonly string[],
): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Object.keys(input).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function deliveryError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
