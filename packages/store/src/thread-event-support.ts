import { RunStoreError } from "@crewon/application";
import type { ThreadLifecycleEvent } from "@crewon/domain";

import { parseQueueTimestamp } from "./store-invariants.ts";

export type StoredThreadEventRow = Readonly<{
  tenantId: string;
  threadId: string;
  sequence: string | number;
  eventId: string;
  eventJson: unknown;
}>;

export function decodeStoredThreadEvent(
  row: StoredThreadEventRow,
  locator: Readonly<{ tenantId: string; threadId: string }>,
): ThreadLifecycleEvent {
  try {
    const value =
      typeof row.eventJson === "string"
        ? (JSON.parse(row.eventJson) as unknown)
        : row.eventJson;
    if (!isThreadLifecycleEvent(value)) {
      throw new Error("thread_event_shape_invalid");
    }
    const sequence = Number(row.sequence);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      row.tenantId !== locator.tenantId ||
      row.threadId !== locator.threadId ||
      value.identity.threadId !== row.threadId ||
      value.sequence !== sequence ||
      value.eventId !== row.eventId
    ) {
      throw new Error("thread_event_columns_mismatch");
    }
    return structuredClone(value);
  } catch (error) {
    throw new RunStoreError("stored_thread_event_invalid", { cause: error });
  }
}

export function validateStoredThreadEventPage(
  events: readonly ThreadLifecycleEvent[],
  locator: Readonly<{ tenantId: string; threadId: string }>,
  afterSequence: number,
): void {
  let expectedSequence = afterSequence + 1;
  for (const event of events) {
    if (
      event.identity.threadId !== locator.threadId ||
      event.sequence !== expectedSequence
    ) {
      throw new RunStoreError("stored_thread_event_page_invalid");
    }
    expectedSequence += 1;
  }
}

function isThreadLifecycleEvent(value: unknown): value is ThreadLifecycleEvent {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "crewon.thread-event.v0" ||
    !isRecord(value.identity) ||
    !isNonEmptyString(value.identity.threadId) ||
    !isNonEmptyString(value.eventId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.occurredAt !== "string" ||
    !isTimestamp(value.occurredAt) ||
    !isRecord(value.data)
  ) {
    return false;
  }
  switch (value.type) {
    case "thread.created":
      return (
        isNonEmptyString(value.data.tenantId) &&
        isNonEmptyString(value.data.spaceId) &&
        isNonEmptyString(value.data.createdByActorId) &&
        (value.data.title === null ||
          (typeof value.data.title === "string" &&
            value.data.title.trim().length > 0 &&
            value.data.title.length <= 256))
      );
    case "thread.message.appended":
      return (
        isNonEmptyString(value.data.messageId) &&
        Number.isSafeInteger(value.data.messageSequence) &&
        Number(value.data.messageSequence) >= 1 &&
        (value.data.role === "user" ||
          value.data.role === "assistant" ||
          value.data.role === "system" ||
          value.data.role === "tool") &&
        typeof value.data.contentDigest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(value.data.contentDigest)
      );
    case "thread.forked":
      return (
        isNonEmptyString(value.data.sourceThreadId) &&
        Number.isSafeInteger(value.data.throughHistorySequence) &&
        Number(value.data.throughHistorySequence) >= 0 &&
        Number.isSafeInteger(value.data.throughMessageSequence) &&
        Number(value.data.throughMessageSequence) >= 0 &&
        isNonEmptyString(value.data.actorId)
      );
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return isNonEmptyString(value.data.actorId);
    case "thread.renamed":
      return (
        isNonEmptyString(value.data.actorId) &&
        (value.data.title === null ||
          (typeof value.data.title === "string" &&
            value.data.title.trim().length > 0 &&
            value.data.title.length <= 256))
      );
    case "thread.rolled_back":
      return (
        isNonEmptyString(value.data.actorId) &&
        isNonEmptyString(value.data.rollbackId) &&
        isNonEmptyString(value.data.markerItemId) &&
        Number.isSafeInteger(value.data.requestedTurns) &&
        Number(value.data.requestedTurns) >= 1 &&
        Number(value.data.requestedTurns) <= 0xffff_ffff &&
        Number.isSafeInteger(value.data.removedTurns) &&
        Number(value.data.removedTurns) >= 0 &&
        Number(value.data.removedTurns) <= Number(value.data.requestedTurns) &&
        Number.isSafeInteger(value.data.historyThroughSequence) &&
        Number(value.data.historyThroughSequence) >= 0 &&
        Number.isSafeInteger(value.data.markerHistorySequence) &&
        Number(value.data.markerHistorySequence) ===
          Number(value.data.historyThroughSequence) + 1 &&
        ((value.data.historyFromSequence === null &&
          Number(value.data.removedTurns) === 0) ||
          (Number.isSafeInteger(value.data.historyFromSequence) &&
            Number(value.data.historyFromSequence) >= 1 &&
            Number(value.data.historyFromSequence) <=
              Number(value.data.historyThroughSequence) &&
            Number(value.data.removedTurns) > 0))
      );
    default:
      return false;
  }
}

function isTimestamp(value: string): boolean {
  try {
    parseQueueTimestamp(value, "stored_thread_event_invalid");
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
