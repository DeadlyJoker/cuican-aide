import type { ActionIntent, WorkspaceChangeSummary } from "@crewon/contracts";

export type ToolCallKind = "function" | "custom";

export type ToolJsonPrimitive = string | number | boolean | null;
export type ToolJsonValue =
  | ToolJsonPrimitive
  | readonly ToolJsonValue[]
  | Readonly<{ [key: string]: ToolJsonValue }>;

export type ToolDefinition =
  | Readonly<{
      schemaVersion: "crewon.tool-definition.v0";
      kind: "function";
      name: string;
      description: string;
      execution: "serial" | "parallel";
      inputSchema: Readonly<{ [key: string]: ToolJsonValue }>;
    }>
  | Readonly<{
      schemaVersion: "crewon.tool-definition.v0";
      kind: "custom";
      name: string;
      description: string;
      execution: "serial" | "parallel";
      inputFormat: "text";
    }>;

export type ToolInvocation = Readonly<{
  schemaVersion: "crewon.tool-invocation.v0";
  idempotencyKey: string;
  runId: string;
  segmentId: string;
  callId: string;
  kind: ToolCallKind;
  name: string;
  input: string;
}>;

export type ToolResult = Readonly<{
  schemaVersion: "crewon.tool-result.v0";
  callId: string;
  output: string;
  isError: boolean;
  artifactRef: string | null;
  workspaceChanges?: WorkspaceChangeSummary;
}>;

export type ToolExecutionPolicy = Readonly<{
  effect: "readOnly" | "mutation";
  recovery: "replaySafe" | "reconcilable";
  resourceBindingId: string | null;
  credentialBindingId: string | null;
  executionTarget: ActionIntent["executionTarget"];
  capability: string;
  approvalRequirement: ActionIntent["approvalRequirement"];
  limits: ActionIntent["limits"];
}>;

/** Run-scoped host boundary used when a Tool exposes more than one safe policy. */
export type ToolExecutionPolicyContext = Readonly<{
  sandboxMode: "workspace-write" | "danger-full-access";
}>;

export type ToolExecutionCommand = ToolInvocation &
  Readonly<{
    executionId: string;
    executionLease: ToolExecutionLease;
    actionDigest: string;
    actionIntent: ActionIntent;
    approvalProof: ToolApprovalProof | null;
  }>;

export type ToolExecutionLease = Readonly<{
  workItemId: string;
  stepId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
}>;

export type ToolApprovalProof = Readonly<{
  schemaVersion: "crewon.tool-approval-proof.v0";
  approvalId: string;
  actionDigest: string;
  policySnapshotId: string;
  approvalRevision: number;
  decidedAt: string;
}>;

export type ToolExecutionResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      providerReceiptId: string;
      result: ToolResult;
    }>
  | Readonly<{
      status: "canceled";
      executionId: string;
      providerReceiptId: string | null;
    }>
  | Readonly<{
      status: "unknownOutcome";
      executionId: string;
      providerReceiptId: string | null;
    }>;

/**
 * Worker confirmation that a result or unknown-outcome fence is durably committed. After this
 * acknowledgement all retries must read that receipt, never dispatch it again.
 * This releases local result memory, not the provider's durable idempotency key.
 */
export type ToolExecutionResultAcknowledgement = Readonly<{
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  actionIntent: ActionIntent;
  status: "completed" | "canceled" | "unknownOutcome";
  providerReceiptId: string | null;
}>;

export type RetainedToolExecutionResult = Readonly<{
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  kind: ToolCallKind;
  name: string;
  /** Optional for older adapters; unknown fences must not hide a locally completed result. */
  status?: ToolExecutionResolution["status"];
}>;

export type RetainedToolExecutionResultQuery = Readonly<{
  runId: string;
  limit: number;
  /** Pending metadata is opt-in for durable cancellation; it carries no result status. */
  visibility?: "settled" | "includePending";
}>;

/** Host-only ownership; never serialized into a Tool invocation or model history. */
export type ToolExecutionReservationOptions = Readonly<{
  resultOwner: Readonly<{ tenantId: string }>;
}>;

export type ScopedRetainedToolExecutionResult = RetainedToolExecutionResult &
  Readonly<{ tenantId: string; runId: string }>;
export type RetainedToolExecutionResultScan = Readonly<{ limit: number }>;

export type RetainedToolExecutionResultLookup = Pick<
  ToolExecutionResultAcknowledgement,
  "executionId" | "idempotencyKey" | "actionDigest" | "actionIntent"
>;

/** Host reserves capacity before publishing dispatch; release if dispatch cannot proceed. */
export type ToolExecutionReservation = Readonly<{
  execute(): Promise<ToolExecutionResolution>;
  release(): void;
}>;

/** Executes external effects and can reconcile the same action after a crash. */
export interface ToolExecutionProviderPort {
  reserveExecution?(
    command: ToolExecutionCommand,
    signal: AbortSignal,
    options?: ToolExecutionReservationOptions,
  ): ToolExecutionReservation | undefined;
  executionPolicy(
    kind: ToolCallKind,
    name: string,
    context?: ToolExecutionPolicyContext,
  ): ToolExecutionPolicy | null;
  execute(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution>;
  reconcile(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution>;
  cancel(
    command: ToolExecutionCommand,
    signal: AbortSignal,
  ): Promise<ToolExecutionResolution>;
  /** Acknowledge authoritative commit. False defers release until physical execution ends. */
  acknowledgeExecutionResult?(
    acknowledgement: ToolExecutionResultAcknowledgement,
  ): boolean | void;
  /** Interrupt a local execution only after authoritative cancellation; never dispatches. */
  cancelRetainedExecution?(
    lookup: RetainedToolExecutionResultLookup,
  ): ToolExecutionResolution | null;
  /** Bounded metadata for repairing a commit/ack interruption, without result bodies. */
  retainedExecutionResults?(
    query: RetainedToolExecutionResultQuery,
  ): readonly RetainedToolExecutionResult[];
  /** Rotating bounded local metadata across Runs, including inactive Runs; never executes a Tool. */
  scanRetainedExecutionResults?(
    query: RetainedToolExecutionResultScan,
  ): readonly ScopedRetainedToolExecutionResult[];
  /** Pure local lookup: never dispatches, waits for a pending handler, or releases ownership. */
  readRetainedExecutionResult?(
    lookup: RetainedToolExecutionResultLookup,
  ): ToolExecutionResolution | null;
}

/** Supplies the model-visible Tool catalog without owning Tool execution. */
export interface ToolCatalogPort {
  definitions(): readonly ToolDefinition[];
}

/** Complete Worker-owned Tool boundary. */
export interface ToolRuntimePort
  extends ToolCatalogPort,
    ToolExecutionProviderPort {
  /**
   * Synchronous local proof that closing an exclusively owned runtime loses no
   * reservation, physical execution or recovery evidence. Missing means unknown.
   * Call only with no borrowers; a filtered/empty result scan is not this proof.
   */
  canRetire?(): boolean;
  close?(): Promise<void>;
}

export class ToolBrokerError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ToolBrokerError";
    this.code = code;
  }
}

/**
 * Raised by an execution adapter after a reconcilable mutation may have been
 * dispatched but no trustworthy completion receipt was returned.
 */
export class ToolExecutionUnknownOutcomeError extends ToolBrokerError {
  constructor(options?: ErrorOptions) {
    super("tool_execution_unknown_outcome", options);
    this.name = "ToolExecutionUnknownOutcomeError";
  }
}
