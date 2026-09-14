import type { ModelCallRecord } from "@crewon/domain";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";
import type { ModelUsagePageQuery } from "./model-usage-store-port.ts";
export type RecordModelCallInput = Readonly<{
  lease: WorkItemLeaseInput;
  record: ModelCallRecord;
}>;
export type ModelCallEntry = Readonly<{
  order: number;
  record: ModelCallRecord;
}>;
export interface ModelCallStore {
  /** Persist before dispatch; finalize once, preserving uncertain crash outcomes. */
  recordModelCall(
    input: RecordModelCallInput,
  ): Promise<"recorded" | "enriched" | "replayed">;
  listModelCalls(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelCallEntry[]>;
}
