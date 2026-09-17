import type { WorkItemLeaseInput } from "./durable-queue-port.ts";

export type CompactionCheckpointScope = Readonly<{
  tenantId: string;
  runId: string;
  stepId: string;
  attemptId: string;
}>;
export type ReadCompactionCheckpointInput = Readonly<{
  lease: WorkItemLeaseInput;
  scope: CompactionCheckpointScope;
  contextDigest: string;
}>;
export type CompactionCheckpoint = Readonly<{
  revision: number;
  payload: string;
}>;
export type SaveCompactionCheckpointInput = ReadCompactionCheckpointInput &
  Readonly<{
    expectedRevision: number;
    payload: string;
  }>;
/** Private bounded staging, fenced to the current model attempt; never canonical history. */
export interface CompactionCheckpointStore {
  load(
    input: ReadCompactionCheckpointInput,
  ): Promise<CompactionCheckpoint | null>;
  save(input: SaveCompactionCheckpointInput): Promise<number>;
}
