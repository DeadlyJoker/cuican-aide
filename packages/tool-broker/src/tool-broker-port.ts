import type { ActionIntent } from "@crewon/contracts/runtime";

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

/** Executes external effects and can reconcile the same action after a crash. */
export interface ToolExecutionProviderPort {
  executionPolicy(kind: ToolCallKind, name: string): ToolExecutionPolicy | null;
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
}

/** Supplies the model-visible Tool catalog without owning Tool execution. */
export interface ToolCatalogPort {
  definitions(): readonly ToolDefinition[];
}

/** Complete Worker-owned Tool boundary. */
export interface ToolRuntimePort
  extends ToolCatalogPort,
    ToolExecutionProviderPort {
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
