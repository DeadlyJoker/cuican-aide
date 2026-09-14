import type { ArtifactRecord } from "@crewon/domain";

export type ArtifactRetentionCandidate = Readonly<{
  record: ArtifactRecord;
  idempotencyKey: string;
}>;

/** A positive answer requires immutable terminal Run and Tool recovery evidence. */
export interface ArtifactRetentionGuard {
  canRetireArtifact(candidate: ArtifactRetentionCandidate): Promise<boolean>;
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
}>;

export interface ArtifactRetentionStore {
  maintainArtifacts(input: {
    policy: ArtifactRetentionPolicy;
    guard: ArtifactRetentionGuard;
    signal: AbortSignal;
  }): Promise<ArtifactRetentionResult>;
}
