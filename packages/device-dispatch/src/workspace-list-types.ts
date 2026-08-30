const OUTPUT_SCHEMA_VERSION = "crewon.workspace-list-result.v0" as const;
const COMMAND_SCHEMA_VERSION = "crewon.workspace-list-command.v1" as const;
const ACTION_SCHEMA_VERSION = "crewon.workspace-list-action.v1" as const;
const DISPATCH_SCHEMA_VERSION =
  "crewon.workspace-list-dispatch-command.v0" as const;

export const WORKSPACE_LIST_HARD_LIMITS = Object.freeze({
  maxEntries: 200,
  maxNameBytes: 255,
  maxOutputBytes: 64 * 1024,
  maxScannedEntries: 10_000,
  maxScannedNameBytes: 1024 * 1024,
  maxTimeoutMs: 30_000,
  minTimeoutMs: 1,
});

export type WorkspaceListLimits = Readonly<{
  depth: 0;
  maxEntries: number;
  maxNameBytes: number;
  maxOutputBytes: number;
  maxScannedEntries: number;
  maxScannedNameBytes: number;
  timeoutMs: number;
}>;

export type WorkspaceDirectoryBinding = Readonly<{
  workspaceBindingId: string;
  incarnationId: string;
  deviceBindingId: string;
  deviceId: string;
  runtimeBindingId: string;
}>;

export type WorkspaceExecutionAuthority = Readonly<{
  tenantId: string;
  spaceId: string;
  threadId: string;
  expectedThreadRevision: number;
  principalId: string;
  actorId: string;
}>;

export type WorkspaceListCommand = Readonly<{
  schemaVersion: typeof COMMAND_SCHEMA_VERSION;
  executionId: string;
  idempotencyKey: string;
  authority: WorkspaceExecutionAuthority;
  binding: WorkspaceDirectoryBinding;
  policySnapshotId: string;
  operation: "listTopLevel";
  limits: WorkspaceListLimits;
  actionDigest: string;
  commandDigest: string;
}>;

export type WorkspaceListEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "reparsePoint"
  | "other";

/**
 * One entry returned by a stable directory capability. Names stay as bytes so
 * the provider-neutral executor can reject invalid UTF-8 and sort identically
 * on Unix and Windows.
 */
export type WorkspaceDirectoryEntry = Readonly<{
  nameBytes: Uint8Array;
  kind: WorkspaceListEntryKind;
}>;

/**
 * Trusted-computing-base port owning one exclusive, already-open stable
 * directory handle. Implementations enumerate relative to that handle, never
 * reopen a caller path, never follow symlinks/reparse points, honor the page
 * limit without reading one extra entry, abort and close promptly, and make
 * release idempotent.
 */
export interface WorkspaceDirectoryCapabilityPort {
  readonly binding: WorkspaceDirectoryBinding;
  listTopLevelPage(input: {
    cursor: string | null;
    limit: number;
    maxNameBytes: number;
    maxTotalNameBytes: number;
    signal: AbortSignal;
  }): Promise<
    Readonly<{
      entries: readonly WorkspaceDirectoryEntry[];
      nextCursor: string | null;
    }>
  >;
  release(): void | Promise<void>;
}

/** Resolves server-owned binding authority without accepting a filesystem path. */
export interface WorkspaceDirectoryCapabilityResolverPort {
  acquire(
    binding: WorkspaceDirectoryBinding,
    signal: AbortSignal,
  ): Promise<WorkspaceDirectoryCapabilityPort | null>;
}

export type WorkspaceListResult = Readonly<{
  schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  executionId: string;
  actionDigest: string;
  commandDigest: string;
  entries: readonly Readonly<{
    name: string;
    kind: "file" | "directory";
  }>[];
  truncated: boolean;
}>;

export type WorkspaceListProjection = Readonly<{
  entries: WorkspaceListResult["entries"];
  truncated: boolean;
}>;

export class WorkspaceListExecutionError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "WorkspaceListExecutionError";
    this.code = code;
  }
}

export interface WorkspaceListDeadlineSchedulerPort {
  schedule(delayMs: number, callback: () => void): () => void;
}

/** Receives TCB cleanup failures that cannot safely replace a primary error. */
export interface WorkspaceListCleanupFailureReporterPort {
  report(input: {
    phase: "ownedCapability" | "lateAcquire" | "deadlineCleanup";
    error: unknown;
  }): void;
}

/**
 * Executes a bounded top-level read through a stable directory capability.
 * Filesystem paths never cross this boundary.
 */
