import type { ArtifactRecord } from "@crewon/domain";

export type ArtifactRetentionCandidate = Readonly<{
  record: ArtifactRecord;
  idempotencyKey: string;
}>;

export type ArtifactRetentionReadOptions = Readonly<{
  /** Advisory cancellation; a caller must retain admission until the read actually settles. */
  signal: AbortSignal;
  maxDurationMs: number;
}>;

/** A positive answer requires immutable terminal Run and Tool recovery evidence. Reads must not mutate authority. */
export interface ArtifactRetentionGuard {
  canRetireArtifact(
    candidate: ArtifactRetentionCandidate,
    options?: ArtifactRetentionReadOptions,
  ): Promise<boolean>;
}

export type ArtifactRetentionPolicy = Readonly<{
  minimumIntervalMs: number;
  recoveryGraceMs: number;
  maxRecords: number;
  maxBytes: number;
  maxDurationMs: number;
}>;

export type ArtifactRetentionResult = Readonly<{
  disposition: "deferred" | "maintained";
  indexed: number;
  checked: number;
  deleted: number;
  deletedBytes: number;
  /** Authenticated interrupted writes promoted to ready; no Run/Tool settlement is implied. */
  recovered: number;
  recoveredBytes: number;
  /** Examined writes retained because recovery was unavailable or exceeded its per-file budget. */
  recoveryDeferred: number;
}>;

export interface ArtifactRetentionStore {
  resourceSnapshot?(): Readonly<{
    authorityQueries: number;
    processAuthorityQueries: number;
    maxProcessAuthorityQueries: number;
    closed: boolean;
  }>;
  maintainArtifacts(input: {
    policy: ArtifactRetentionPolicy;
    guard: ArtifactRetentionGuard;
    signal: AbortSignal;
  }): Promise<ArtifactRetentionResult>;
}
