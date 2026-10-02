import type { PluginJsonValue } from "./sdk-types.js";

/** Native AbortSignal is assignable; Node-only declarations do not require DOM types. */
export type PluginAbortSignal = Readonly<{
  aborted: boolean;
  reason: unknown;
  throwIfAborted(): void;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}>;

export type PluginToolCallKind = "function" | "custom";
export type PluginToolDefinition =
  | Readonly<{
      schemaVersion: "crewon.tool-definition.v0";
      kind: "function";
      name: string;
      description: string;
      execution: "serial" | "parallel";
      inputSchema: Readonly<Record<string, PluginJsonValue>>;
    }>
  | Readonly<{
      schemaVersion: "crewon.tool-definition.v0";
      kind: "custom";
      name: string;
      description: string;
      execution: "serial" | "parallel";
      inputFormat: "text";
    }>;

export type PluginToolExecutionLimits = Readonly<{
  timeoutMs: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
}>;
export type PluginToolActionIntent = Readonly<{
  schemaVersion: "crewon.action-intent.v0";
  runId: string;
  segmentId: string;
  callId: string;
  tool: Readonly<{
    kind: PluginToolCallKind;
    name: string;
    inputDigest: string;
  }>;
  effect: "readOnly" | "mutation";
  recovery: "replaySafe" | "reconcilable";
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
  limits: PluginToolExecutionLimits;
}>;

export type PluginToolExecutionPolicy = Pick<
  PluginToolActionIntent,
  | "effect"
  | "recovery"
  | "resourceBindingId"
  | "credentialBindingId"
  | "executionTarget"
  | "capability"
  | "approvalRequirement"
  | "limits"
>;
export type PluginToolExecutionPolicyContext = Readonly<{
  sandboxMode: "workspace-write" | "danger-full-access";
}>;
export type PluginToolInvocation = Readonly<{
  schemaVersion: "crewon.tool-invocation.v0";
  idempotencyKey: string;
  runId: string;
  segmentId: string;
  callId: string;
  kind: PluginToolCallKind;
  name: string;
  input: string;
}>;
export type PluginToolExecutionLease = Readonly<{
  workItemId: string;
  stepId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
}>;
export type PluginToolApprovalProof = Readonly<{
  schemaVersion: "crewon.tool-approval-proof.v0";
  approvalId: string;
  actionDigest: string;
  policySnapshotId: string;
  approvalRevision: number;
  decidedAt: string;
}>;
export type PluginToolExecutionCommand = PluginToolInvocation &
  Readonly<{
    executionId: string;
    executionLease: PluginToolExecutionLease;
    actionDigest: string;
    actionIntent: PluginToolActionIntent;
    approvalProof: PluginToolApprovalProof | null;
  }>;

export type PluginWorkspaceChangeSummary = Readonly<{
  schemaVersion: "crewon.workspace-change-summary.v0";
  paths: string[];
  additions: number;
  deletions: number;
  statsComplete: boolean;
}>;
export type PluginToolResult = Readonly<{
  schemaVersion: "crewon.tool-result.v0";
  callId: string;
  output: string;
  isError: boolean;
  artifactRef: string | null;
  workspaceChanges?: PluginWorkspaceChangeSummary;
}>;
export type PluginToolExecutionResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      providerReceiptId: string;
      result: PluginToolResult;
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

/** Durable host acknowledgement releases local evidence, never provider idempotency. */
export type PluginToolExecutionResultAcknowledgement = Readonly<{
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  actionIntent: PluginToolActionIntent;
  status: PluginToolExecutionResolution["status"];
  providerReceiptId: string | null;
}>;
export type PluginRetainedToolExecutionResult = Readonly<{
  executionId: string;
  idempotencyKey: string;
  actionDigest: string;
  kind: PluginToolCallKind;
  name: string;
  status?: PluginToolExecutionResolution["status"];
}>;
export type PluginRetainedToolExecutionResultQuery = Readonly<{
  runId: string;
  limit: number;
  visibility?: "settled" | "includePending";
}>;
/** Host-only ownership, never model input or serialized model history. */
export type PluginToolExecutionReservationOptions = Readonly<{
  resultOwner: Readonly<{ tenantId: string }>;
}>;
export type PluginScopedRetainedToolExecutionResult =
  PluginRetainedToolExecutionResult &
    Readonly<{ tenantId: string; runId: string }>;
export type PluginRetainedToolExecutionResultScan = Readonly<{ limit: number }>;
export type PluginRetainedToolExecutionResultLookup = Pick<
  PluginToolExecutionResultAcknowledgement,
  "executionId" | "idempotencyKey" | "actionDigest" | "actionIntent"
>;
export type PluginToolExecutionReservation = Readonly<{
  execute(): Promise<PluginToolExecutionResolution>;
  release(): void;
}>;

/** Original host Run execution boundary; this interface does not create or dispatch Runs. */
export interface PluginToolRuntime {
  definitions(): readonly PluginToolDefinition[];
  executionPolicy(
    kind: PluginToolCallKind,
    name: string,
    context?: PluginToolExecutionPolicyContext,
  ): PluginToolExecutionPolicy | null;
  execute(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
  ): Promise<PluginToolExecutionResolution>;
  reconcile(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
  ): Promise<PluginToolExecutionResolution>;
  cancel(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
  ): Promise<PluginToolExecutionResolution>;
  reserveExecution?(
    command: PluginToolExecutionCommand,
    signal: PluginAbortSignal,
    options?: PluginToolExecutionReservationOptions,
  ): PluginToolExecutionReservation | undefined;
  /** False keeps ownership until the physical execution has ended. */
  acknowledgeExecutionResult?(
    acknowledgement: PluginToolExecutionResultAcknowledgement,
  ): boolean | void;
  /** Pure local interruption after authoritative cancellation; never dispatches. */
  cancelRetainedExecution?(
    lookup: PluginRetainedToolExecutionResultLookup,
  ): PluginToolExecutionResolution | null;
  retainedExecutionResults?(
    query: PluginRetainedToolExecutionResultQuery,
  ): readonly PluginRetainedToolExecutionResult[];
  scanRetainedExecutionResults?(
    query: PluginRetainedToolExecutionResultScan,
  ): readonly PluginScopedRetainedToolExecutionResult[];
  /** Pure local lookup; does not wait, dispatch or release ownership. */
  readRetainedExecutionResult?(
    lookup: PluginRetainedToolExecutionResultLookup,
  ): PluginToolExecutionResolution | null;
  /** Missing means unknown; call only with no borrowers. Empty scans are not this proof. */
  canRetire?(): boolean;
  close?(): Promise<void>;
}
