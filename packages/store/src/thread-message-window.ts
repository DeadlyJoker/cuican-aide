import {
  RunStoreError,
  type ThreadMessageWindowQuery,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import { validateThreadScopedLocator } from "./store-invariants.ts";

export const MESSAGE_WINDOW_BYTE_LIMIT = 4 * 1024 * 1024;

export function validateMessageWindowQuery(
  query: ThreadMessageWindowQuery,
): void {
  validateThreadScopedLocator(query);
  if (
    query.view !== undefined &&
    query.view !== "messages" &&
    query.view !== "transcript" &&
    query.view !== "transcriptSnapshot"
  )
    throw new RunStoreError("message_window_view_invalid");
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  ) {
    throw new RunStoreError("message_window_limit_invalid");
  }
  const position = query.position;
  if (
    position !== null &&
    (typeof position !== "object" ||
      Array.isArray(position) ||
      (position.direction !== "older" && position.direction !== "newer") ||
      !Number.isSafeInteger(position.messageSequence) ||
      position.messageSequence < 1 ||
      !Number.isSafeInteger(position.threadRevision) ||
      position.threadRevision < 1)
  ) {
    throw new RunStoreError("message_window_position_invalid");
  }
}

export function assertMessageWindowThread(
  thread: ThreadState | null,
  query: ThreadMessageWindowQuery,
): asserts thread is ThreadState {
  if (
    thread === null ||
    thread.status === "deleted" ||
    thread.tenantId !== query.tenantId ||
    thread.spaceId !== query.spaceId ||
    thread.threadId !== query.threadId
  ) {
    throw new RunStoreError("thread_not_found");
  }
  if (
    query.position !== null &&
    query.position.threadRevision !== thread.revision
  ) {
    throw new RunStoreError("thread_message_window_changed");
  }
}

/** Metadata is read before bodies, so one page never decodes arbitrary history. */
export function selectMessageWindowSequences(
  rows: readonly { sequence: number; storedBytes: number }[],
): number[] {
  const sequences: number[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1 ||
      !Number.isSafeInteger(row.storedBytes) ||
      row.storedBytes < 0
    ) {
      throw new RunStoreError("stored_message_invalid");
    }
    if (bytes + row.storedBytes > MESSAGE_WINDOW_BYTE_LIMIT) {
      if (sequences.length === 0)
        throw new RunStoreError("message_window_item_too_large");
      break;
    }
    sequences.push(row.sequence);
    bytes += row.storedBytes;
  }
  return sequences;
}
