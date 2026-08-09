import {
  ModelHistoryError,
  projectEffectiveModelHistory,
  validateModelHistoryItem,
  type EffectiveModelHistoryItem,
  type ModelHistoryItem,
} from "@crewon/domain";

import { ApplicationError } from "./application-error.ts";
import type { MessageRecord } from "./thread-store-port.ts";

type MessageBackedHistoryItem = Extract<ModelHistoryItem, { type: "message" }> &
  Readonly<{ source: "thread_message" | "assistant_completion" }>;

export type ThreadForkHistoryProjection = Readonly<{
  items: readonly EffectiveModelHistoryItem[];
  rawMessageItems: readonly MessageBackedHistoryItem[];
}>;

/** Selects the current effective source prefix without resurrecting rollback tombstones. */
export function projectThreadForkHistory(
  rawItems: readonly ModelHistoryItem[],
  requestedThroughSequence: number | null,
): ThreadForkHistoryProjection {
  let effective;
  try {
    effective = projectEffectiveModelHistory(rawItems);
  } catch (error) {
    if (error instanceof ModelHistoryError) {
      throw new ApplicationError("internal", "thread_fork_history_invalid", {
        cause: error,
      });
    }
    throw error;
  }
  const throughSequence =
    requestedThroughSequence ?? effective.throughHistorySequence;
  if (throughSequence > effective.throughHistorySequence) {
    throw new ApplicationError(
      "conflict",
      "thread_fork_history_sequence_conflict",
    );
  }
  const items = effective.items.filter(
    ({ sequence }) => sequence <= throughSequence,
  );
  const lastSourceSequence = items.at(-1)?.sequence ?? 0;
  return {
    items,
    rawMessageItems: rawItems.filter(
      (item): item is MessageBackedHistoryItem =>
        item.sequence <= lastSourceSequence && isMessageBackedHistoryItem(item),
    ),
  };
}

/** Correlates the physical Message ledger, then keeps only effective message-backed items. */
export function selectThreadForkMessages(
  projection: ThreadForkHistoryProjection,
  rawMessages: readonly MessageRecord[],
): readonly MessageRecord[] {
  if (rawMessages.length !== projection.rawMessageItems.length) {
    throw new ApplicationError(
      "internal",
      rawMessages.length < projection.rawMessageItems.length
        ? "thread_message_history_incomplete"
        : "thread_message_history_mismatch",
    );
  }
  const survivingSequences = new Set(
    projection.items
      .filter(isMessageBackedHistoryItem)
      .map(({ sequence }) => sequence),
  );
  const selected: MessageRecord[] = [];
  for (const [index, item] of projection.rawMessageItems.entries()) {
    const message = rawMessages[index];
    if (
      message === undefined ||
      message.sequence !== index + 1 ||
      message.tenantId !== item.tenantId ||
      message.threadId !== item.threadId ||
      message.role !== item.role ||
      message.content !== item.content ||
      message.contentDigest !== item.contentDigest ||
      message.createdAt !== item.createdAt
    ) {
      throw new ApplicationError("internal", "thread_message_history_mismatch");
    }
    if (survivingSequences.has(item.sequence)) {
      selected.push(message);
    }
  }
  return selected;
}

/** Rebases surviving canonical history onto a new contiguous Thread ledger. */
export function rebaseThreadForkHistory(
  items: readonly EffectiveModelHistoryItem[],
  target: Readonly<{
    tenantId: string;
    threadId: string;
    createdAt: string;
    itemIds: readonly string[];
  }>,
): readonly ModelHistoryItem[] {
  if (target.itemIds.length !== items.length) {
    throw new ApplicationError(
      "internal",
      "thread_fork_history_rebase_invalid",
    );
  }
  const rebased = items.map((item, index): ModelHistoryItem => {
    const sequence = index + 1;
    if (item.type === "compaction") {
      const replacesThroughSequence = countItemsThroughSequence(
        items,
        item.replacesThroughSequence,
      );
      return {
        ...item,
        itemId: target.itemIds[index]!,
        tenantId: target.tenantId,
        threadId: target.threadId,
        sequence,
        createdAt: target.createdAt,
        replacesThroughSequence,
      };
    }
    return {
      ...item,
      itemId: target.itemIds[index]!,
      tenantId: target.tenantId,
      threadId: target.threadId,
      sequence,
      createdAt: target.createdAt,
    };
  });
  try {
    for (const item of rebased) {
      validateModelHistoryItem(item);
    }
  } catch (error) {
    if (error instanceof ModelHistoryError) {
      throw new ApplicationError(
        "internal",
        "thread_fork_history_rebase_invalid",
        { cause: error },
      );
    }
    throw error;
  }
  return rebased;
}

function countItemsThroughSequence(
  items: readonly EffectiveModelHistoryItem[],
  throughSequence: number,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[middle]!.sequence <= throughSequence) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function isMessageBackedHistoryItem(
  item: ModelHistoryItem | EffectiveModelHistoryItem,
): item is MessageBackedHistoryItem {
  return (
    item.type === "message" &&
    (item.source === "thread_message" || item.source === "assistant_completion")
  );
}
