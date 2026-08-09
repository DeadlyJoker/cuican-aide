import type { ModelHistoryHead, ModelHistoryItem } from "@crewon/domain";

import type { ThreadLocator } from "./thread-store-port.ts";

export type ModelHistoryAppend = Readonly<{
  expectedLastSequence: number;
  items: readonly ModelHistoryItem[];
}>;

/** Durable provider-neutral context authority for one Thread. */
export interface ModelHistoryStore {
  loadModelHistoryHead(
    locator: ThreadLocator,
  ): Promise<ModelHistoryHead | null>;
  listModelHistoryItems(
    locator: ThreadLocator,
    afterSequence: number,
    limit: number,
  ): Promise<readonly ModelHistoryItem[]>;
}
