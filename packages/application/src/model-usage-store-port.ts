import type { ModelUsageRecord } from "@crewon/domain";
import type { WorkItemLeaseInput } from "./durable-queue-port.ts";

export type RecordModelUsageInput = Readonly<{
  lease: WorkItemLeaseInput;
  record: ModelUsageRecord;
}>;
export type ModelUsageEntry = Readonly<{
  order: number;
  record: ModelUsageRecord;
}>;
export type ModelUsagePageQuery = Readonly<{
  tenantId: string;
  runId: string;
  afterOrder: number;
  limit: number;
}>;

export interface ModelUsageStore {
  /** Deduplicate recovery reports and enrich missing metadata; this is not a bill. */
  recordModelUsage(
    input: RecordModelUsageInput,
  ): Promise<"recorded" | "enriched" | "replayed">;
  listModelUsage(
    query: ModelUsagePageQuery,
  ): Promise<readonly ModelUsageEntry[]>;
}
