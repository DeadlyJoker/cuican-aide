import type { ModelHistoryItem } from "@crewon/domain";
import type { ThreadLocator } from "./thread-store-port.ts";

/** A Store-owned snapshot token. Never sent to a model or used as a cache key. */
export type ModelHistoryContextCheckpoint = Readonly<{
  throughHistorySequence: number;
  fingerprint: string;
}>;

export type ModelHistoryContextState = Readonly<{
  checkpoint: ModelHistoryContextCheckpoint;
  lastItem: ModelHistoryItem | null;
  lastCompaction: Extract<ModelHistoryItem, { type: "compaction" }> | null;
  latestRollback: Extract<ModelHistoryItem, { type: "rollback" }> | null;
}>;

export type ModelHistoryContextProgress = Readonly<{
  processedThroughSequence: number;
  targetSequence: number;
  context: ModelHistoryContextState | null;
}>;

/** Optional acceleration for immutable canonical history; old adapters remain compatible. */
export interface ModelHistoryContextStore {
  /** Advances a resumable index by at most 100 canonical items per transaction. */
  prepare(locator: ThreadLocator): Promise<ModelHistoryContextProgress>;
  /** Returns only effective, uncompacted content, preserving canonical source sequences. */
  listItems(
    locator: ThreadLocator,
    checkpoint: ModelHistoryContextCheckpoint,
    afterSequence: number,
    limit: number,
  ): Promise<
    readonly Exclude<ModelHistoryItem, { type: "compaction" | "rollback" }>[]
  >;
}
