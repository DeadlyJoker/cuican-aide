import type {
  DeviceFilesystemReadCommand,
  DeviceFilesystemReadDispatchReference,
  DeviceFilesystemReadDispatchResolution,
  DeviceFilesystemReadRouteIntent,
} from "@crewon/contracts";

import type { IdempotencyDescriptor } from "./run-store-port.ts";

export type WorkspaceReadFilePhase = "execute" | "reconcile" | "cancel";

export type FrozenWorkspaceReadFileDispatch = Readonly<{
  command: DeviceFilesystemReadCommand;
  routeIntent: DeviceFilesystemReadRouteIntent;
  reference: DeviceFilesystemReadDispatchReference;
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
  status: "prepared" | "possiblySent" | DeviceFilesystemReadDispatchResolution["status"];
  frozen: FrozenWorkspaceReadFileDispatch;
  resolution: DeviceFilesystemReadDispatchResolution | null;
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
        resolution: DeviceFilesystemReadDispatchResolution;
      }>,
  ): Promise<WorkspaceReadFileMutationResult>;
}

