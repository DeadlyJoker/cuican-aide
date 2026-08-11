export const RUNTIME_WORKER_WORKSPACE_API_VERSION = 1 as const;
export const RUNTIME_WORKER_WORKSPACE_FREEZE_COMMAND_PATH =
  "/internal/v1/workspace-list/freeze-command" as const;
export const RUNTIME_WORKER_WORKSPACE_DISPATCH_PATH =
  "/internal/v1/workspace-list/dispatch" as const;

export const RUNTIME_WORKER_WORKSPACE_WIRE_LIMITS = Object.freeze({
  freezeRequestBytes: 2 * 1024,
  freezeResponseBytes: 3 * 1024,
  freezeErrorBytes: 256,
  dispatchRequestBytes: 8 * 1024,
  dispatchResponseBytes: 68 * 1024,
  dispatchErrorBytes: 256,
  maxEntries: 200,
  maxNameBytes: 255,
  maxOutputBytes: 64 * 1024,
  maxScannedEntries: 10_000,
  maxScannedNameBytes: 1024 * 1024,
  maxTimeoutMs: 30_000,
});

export type RuntimeWorkerWorkspacePhase = "execute" | "reconcile" | "cancel";

export type RuntimeWorkerWorkspaceFreezeCommandRequest = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-freeze-request.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  tenantId: string;
  spaceId: string;
  actor: Readonly<{ principalId: string; actorId: string }>;
  threadFence: Readonly<{ threadId: string; expectedRevision: number }>;
  idempotencyKey: string;
  maxEntries: number;
}>;

export type RuntimeWorkerWorkspaceListLimits = Readonly<{
  depth: 0;
  maxEntries: number;
  maxNameBytes: number;
  maxOutputBytes: number;
  maxScannedEntries: number;
  maxScannedNameBytes: number;
  timeoutMs: number;
}>;

export type RuntimeWorkerFrozenWorkspaceCommand = Readonly<{
  executionId: string;
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  deviceId: string;
  runtimeBindingId: string;
  policySnapshotId: string;
  actionDigest: string;
  commandDigest: string;
  limits: RuntimeWorkerWorkspaceListLimits;
}>;

export type RuntimeWorkerWorkspaceFreezeCommandResponse = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-freeze-response.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  command: RuntimeWorkerFrozenWorkspaceCommand;
}>;

export type RuntimeWorkerWorkspaceFreezeCommandError = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-freeze-error.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  code: string;
  retryable: boolean;
  certainty: "notSent";
}>;

export type RuntimeWorkerWorkspaceResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string;
      entries: readonly Readonly<{
        name: string;
        kind: "file" | "directory";
      }>[];
      truncated: boolean;
    }>
  | Readonly<{
      status: "failed";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string;
      code: string;
      retryable: boolean;
    }>
  | Readonly<{
      status: "canceled" | "unknownOutcome";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string | null;
    }>;

export type RuntimeWorkerWorkspaceOperation = Readonly<{
  schemaVersion: "crewon.workspace-operation.v0";
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
  idempotencyKey: string;
  executionId: string;
  revision: number;
  status: "prepared" | RuntimeWorkerWorkspaceResolution["status"];
  command: RuntimeWorkerFrozenWorkspaceCommand;
  resolution: RuntimeWorkerWorkspaceResolution | null;
}>;

export type RuntimeWorkerWorkspaceDeliveryLease = Readonly<{
  schemaVersion: "crewon.workspace-delivery-lease.v0";
  executionId: string;
  attemptNumber: number;
  phase: RuntimeWorkerWorkspacePhase;
  ownerId: string;
  leaseId: string;
  epoch: number;
  leasedAt: string;
  expiresAt: string;
}>;

export type RuntimeWorkerWorkspaceDispatchRequest = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-dispatch-request.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  phase: RuntimeWorkerWorkspacePhase;
  operation: RuntimeWorkerWorkspaceOperation;
  deliveryLease: RuntimeWorkerWorkspaceDeliveryLease;
}>;

export type RuntimeWorkerWorkspaceDispatchResponse = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-dispatch-response.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  phase: RuntimeWorkerWorkspacePhase;
  resolution: RuntimeWorkerWorkspaceResolution;
}>;

export type RuntimeWorkerWorkspaceDispatchError = Readonly<{
  schemaVersion: "crewon.runtime-worker-workspace-dispatch-error.v0";
  apiVersion: typeof RUNTIME_WORKER_WORKSPACE_API_VERSION;
  phase: RuntimeWorkerWorkspacePhase;
  code: string;
  retryable: boolean;
  certainty: "notSent" | "possiblySent";
}>;
