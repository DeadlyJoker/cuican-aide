import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
export type RunExecutionProgressScope = Readonly<{
  tenantId: string;
  runId: string;
}>;
export type ReadRunExecutionProgressInput = Readonly<{
  scope: RunExecutionProgressScope;
  lease: WorkItemLeaseInput;
  /** Default execution access stops at cancellation; cancellation access cannot resume execution. */
  purpose?: "execute" | "cancel";
}>;
export type RunExecutionProgressCheckpoint = Readonly<{
  throughSequence: number;
  sourceEventId: string;
  payload: string;
}>;
export type SaveRunExecutionProgressInput = ReadRunExecutionProgressInput &
  Readonly<{
    expectedThroughSequence: number;
    checkpoint: RunExecutionProgressCheckpoint;
  }>;
/** Derived execution progress only; source events remain authoritative and append-only. */
export interface RunExecutionProgressStore {
  load(
    input: ReadRunExecutionProgressInput,
  ): Promise<RunExecutionProgressCheckpoint | null>;
  save(input: SaveRunExecutionProgressInput): Promise<void>;
  /** Discard only the derived row while holding the cancellation lease; source events are untouched. */
  resetForCancellation?(input: ReadRunExecutionProgressInput): Promise<void>;
}
