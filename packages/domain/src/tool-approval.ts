export type ToolApprovalStatus =
  | "required"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded";

export type ToolApprovalDecision = Readonly<{
  outcome: "approved" | "rejected";
  actorId: string;
  comment: string | null;
  decidedAt: string;
}>;

export type ToolApprovalState = Readonly<{
  schemaVersion: "crewon.tool-approval.v0";
  approvalId: string;
  tenantId: string;
  spaceId: string;
  runId: string;
  receiptId: string;
  workItemId: string;
  actionDigest: string;
  policySnapshotId: string;
  requestedByActorId: string;
  status: ToolApprovalStatus;
  revision: number;
  requiredAt: string;
  expiresAt: string | null;
  decision: ToolApprovalDecision | null;
  terminalReasonCode: string | null;
  updatedAt: string;
}>;

export class ToolApprovalError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ToolApprovalError";
    this.code = code;
  }
}

export function createToolApproval(
  input: Omit<
    ToolApprovalState,
    | "schemaVersion"
    | "status"
    | "revision"
    | "decision"
    | "terminalReasonCode"
    | "updatedAt"
  >,
): ToolApprovalState {
  validateIdentity(input);
  requireTimestamp(input.requiredAt, "approval_required_at_invalid");
  if (input.expiresAt !== null) {
    requireTimestamp(input.expiresAt, "approval_expires_at_invalid");
    if (Date.parse(input.expiresAt) <= Date.parse(input.requiredAt)) {
      throw new ToolApprovalError("approval_expiry_invalid");
    }
  }
  return {
    schemaVersion: "crewon.tool-approval.v0",
    ...input,
    status: "required",
    revision: 1,
    decision: null,
    terminalReasonCode: null,
    updatedAt: input.requiredAt,
  };
}

export function decideToolApproval(
  state: ToolApprovalState,
  input: ToolApprovalDecision & Readonly<{ expectedRevision: number }>,
): ToolApprovalState {
  validateState(state);
  if (state.status !== "required") {
    throw new ToolApprovalError("approval_already_terminal");
  }
  if (input.expectedRevision !== state.revision) {
    throw new ToolApprovalError("approval_revision_conflict");
  }
  requireOpaqueId(input.actorId, "approval_actor_id_invalid");
  requireComment(input.comment);
  requireTimestamp(input.decidedAt, "approval_decided_at_invalid");
  if (Date.parse(input.decidedAt) < Date.parse(state.requiredAt)) {
    throw new ToolApprovalError("approval_decision_time_invalid");
  }
  if (
    state.expiresAt !== null &&
    Date.parse(input.decidedAt) >= Date.parse(state.expiresAt)
  ) {
    throw new ToolApprovalError("approval_expired");
  }
  if (input.outcome !== "approved" && input.outcome !== "rejected") {
    throw new ToolApprovalError("approval_decision_invalid");
  }
  return {
    ...state,
    status: input.outcome,
    revision: state.revision + 1,
    decision: {
      outcome: input.outcome,
      actorId: input.actorId,
      comment: input.comment,
      decidedAt: input.decidedAt,
    },
    updatedAt: input.decidedAt,
  };
}

export function terminateToolApproval(
  state: ToolApprovalState,
  input: Readonly<{
    status: "expired" | "superseded";
    expectedRevision: number;
    reasonCode: string;
    occurredAt: string;
  }>,
): ToolApprovalState {
  validateState(state);
  if (state.status !== "required") {
    throw new ToolApprovalError("approval_already_terminal");
  }
  if (input.expectedRevision !== state.revision) {
    throw new ToolApprovalError("approval_revision_conflict");
  }
  requireOpaqueId(input.reasonCode, "approval_terminal_reason_invalid");
  requireTimestamp(input.occurredAt, "approval_terminal_at_invalid");
  if (Date.parse(input.occurredAt) < Date.parse(state.requiredAt)) {
    throw new ToolApprovalError("approval_terminal_time_invalid");
  }
  return {
    ...state,
    status: input.status,
    revision: state.revision + 1,
    terminalReasonCode: input.reasonCode,
    updatedAt: input.occurredAt,
  };
}

export function validateToolApprovalState(state: ToolApprovalState): void {
  validateState(state);
}

function validateState(state: ToolApprovalState): void {
  if (
    typeof state !== "object" ||
    state === null ||
    state.schemaVersion !== "crewon.tool-approval.v0" ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 1
  ) {
    throw new ToolApprovalError("approval_state_invalid");
  }
  validateIdentity(state);
  requireTimestamp(state.requiredAt, "approval_required_at_invalid");
  requireTimestamp(state.updatedAt, "approval_updated_at_invalid");
  if (state.expiresAt !== null) {
    requireTimestamp(state.expiresAt, "approval_expires_at_invalid");
  }
  if (state.status === "required") {
    if (
      state.revision !== 1 ||
      state.decision !== null ||
      state.terminalReasonCode !== null ||
      state.updatedAt !== state.requiredAt
    ) {
      throw new ToolApprovalError("approval_state_invalid");
    }
    return;
  }
  if (state.status === "approved" || state.status === "rejected") {
    const decision = state.decision;
    if (
      state.revision !== 2 ||
      decision === null ||
      decision.outcome !== state.status ||
      state.terminalReasonCode !== null ||
      state.updatedAt !== decision.decidedAt
    ) {
      throw new ToolApprovalError("approval_state_invalid");
    }
    requireOpaqueId(decision.actorId, "approval_actor_id_invalid");
    requireComment(decision.comment);
    requireTimestamp(decision.decidedAt, "approval_decided_at_invalid");
    return;
  }
  if (state.status !== "expired" && state.status !== "superseded") {
    throw new ToolApprovalError("approval_status_invalid");
  }
  if (
    state.revision !== 2 ||
    state.decision !== null ||
    state.terminalReasonCode === null
  ) {
    throw new ToolApprovalError("approval_state_invalid");
  }
  requireOpaqueId(state.terminalReasonCode, "approval_terminal_reason_invalid");
}

function validateIdentity(
  input: Readonly<{
    approvalId: string;
    tenantId: string;
    spaceId: string;
    runId: string;
    receiptId: string;
    workItemId: string;
    actionDigest: string;
    policySnapshotId: string;
    requestedByActorId: string;
  }>,
): void {
  for (const [value, code] of [
    [input.approvalId, "approval_id_invalid"],
    [input.tenantId, "approval_tenant_id_invalid"],
    [input.spaceId, "approval_space_id_invalid"],
    [input.runId, "approval_run_id_invalid"],
    [input.receiptId, "approval_receipt_id_invalid"],
    [input.workItemId, "approval_work_item_id_invalid"],
    [input.policySnapshotId, "approval_policy_snapshot_invalid"],
    [input.requestedByActorId, "approval_request_actor_invalid"],
  ] as const) {
    requireOpaqueId(value, code);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.actionDigest)) {
    throw new ToolApprovalError("approval_action_digest_invalid");
  }
}

function requireOpaqueId(value: string, code: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value)) {
    throw new ToolApprovalError(code);
  }
}

function requireComment(value: string | null): void {
  if (
    value !== null &&
    (value.trim().length === 0 ||
      new TextEncoder().encode(value).length > 2_048)
  ) {
    throw new ToolApprovalError("approval_comment_invalid");
  }
}

function requireTimestamp(value: string, code: string): void {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new ToolApprovalError(code);
  }
}
