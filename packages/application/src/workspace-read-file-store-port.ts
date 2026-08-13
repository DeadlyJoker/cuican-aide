import type { IdempotencyDescriptor } from "./run-store-port.ts";

export type WorkspaceReadFilePhase = "execute" | "reconcile" | "cancel";

export const WORKSPACE_READ_FILE_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
  maxArtifactBytes: 16 * 1024 * 1024,
});

export type FrozenWorkspaceReadFileDispatch = Readonly<{
  schemaVersion: "crewon.workspace-read-file-command.v0";
  executionId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  leaseId: string;
  leaseEpoch: number;
  expiresAt: string;
  workspaceBindingId: string;
  incarnationId: string;
  runtimeBindingId: string;
  policySnapshotId: string;
  actionDigest: string;
  commandDigest: string;
  relativePathSegments: readonly string[];
  limits: Readonly<{
    timeoutMs: number;
    maxOutputBytes: number;
    maxArtifactBytes: number;
  }>;
  providerReceiptId: string | null;
}>;

export type WorkspaceReadFileResolution =
  | Readonly<{
      status: "completed";
      executionId: string;
      actionDigest: string;
      commandDigest: string;
      providerReceiptId: string;
      result: Readonly<{
        schemaVersion: "crewon.workspace-file-read-result.v0";
        encoding: "utf8";
        content: string;
        byteLength: number;
        outputDigest: string;
      }>;
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

export type WorkspaceReadFileRecord = Readonly<{
  schemaVersion: "crewon.workspace-read-file-operation.v0";
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  executionId: string;
  revision: number;
  status: "prepared" | "possiblySent" | WorkspaceReadFileResolution["status"];
  frozen: FrozenWorkspaceReadFileDispatch;
  resolution: WorkspaceReadFileResolution | null;
}>;

export type WorkspaceReadFileMutationResult = Readonly<{
  disposition: "committed" | "replayed";
  operation: WorkspaceReadFileRecord;
}>;

export type WorkspaceReadFileReceiptQuery = Readonly<{
  tenantId: string;
  spaceId: string;
  phase: WorkspaceReadFilePhase;
  idempotency: IdempotencyDescriptor;
}>;

export type WorkspaceReadFileLocator = Readonly<{
  tenantId: string;
  spaceId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  executionId: string;
}>;

export type PrepareWorkspaceReadFileInput = WorkspaceReadFileLocator &
  Readonly<{
    idempotency: IdempotencyDescriptor;
    frozen: FrozenWorkspaceReadFileDispatch;
  }>;

export type PrepareWorkspaceReadFileActionInput = WorkspaceReadFileLocator &
  Readonly<{
    phase: "reconcile" | "cancel";
    idempotency: IdempotencyDescriptor;
  }>;

/** Durable authority for private workspace.read_file execution and recovery. */
export interface WorkspaceReadFileStore {
  loadWorkspaceReadFileReceipt(
    query: WorkspaceReadFileReceiptQuery,
  ): Promise<WorkspaceReadFileMutationResult | null>;
  prepareWorkspaceReadFile(
    input: PrepareWorkspaceReadFileInput,
  ): Promise<WorkspaceReadFileMutationResult>;
  prepareWorkspaceReadFileAction(
    input: PrepareWorkspaceReadFileActionInput,
  ): Promise<WorkspaceReadFileMutationResult>;
  markWorkspaceReadFilePossiblySent(
    input: WorkspaceReadFileLocator & Readonly<{ expectedRevision: number }>,
  ): Promise<WorkspaceReadFileRecord>;
  abandonWorkspaceReadFileSend(
    input: WorkspaceReadFileLocator & Readonly<{ expectedRevision: number }>,
  ): Promise<WorkspaceReadFileRecord>;
  commitWorkspaceReadFileResolution(
    input: WorkspaceReadFileLocator &
      Readonly<{
        phase: WorkspaceReadFilePhase;
        idempotency: IdempotencyDescriptor;
        expectedRevision: number;
        resolution: WorkspaceReadFileResolution;
      }>,
  ): Promise<WorkspaceReadFileMutationResult>;
}
