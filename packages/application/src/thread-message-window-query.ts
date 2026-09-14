import { ApplicationError } from "./application-error.ts";
import type { ThreadMessageWindowPosition } from "./thread-message-window-store-port.ts";

type Query = Readonly<{
  threadId: string;
  position: ThreadMessageWindowPosition | null;
  limit: number;
}>;

export function validateThreadMessageWindowQuery(input: unknown): Query {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) => !["threadId", "position", "limit"].includes(key),
    ) ||
    typeof input.threadId !== "string" ||
    input.threadId.trim().length === 0
  ) {
    throw new ApplicationError("validation", "message_window_query_invalid");
  }
  if (!integer(input.limit) || input.limit > 100) {
    throw new ApplicationError("validation", "message_window_limit_invalid");
  }
  return {
    threadId: input.threadId,
    limit: input.limit,
    position: parsePosition(input.position),
  };
}

function parsePosition(input: unknown): ThreadMessageWindowPosition | null {
  if (input === null) return null;
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) =>
        !["direction", "messageSequence", "threadRevision"].includes(key),
    )
  ) {
    throw new ApplicationError("validation", "message_window_position_invalid");
  }
  const { direction, messageSequence, threadRevision } = input;
  if (
    (direction !== "older" && direction !== "newer") ||
    !integer(messageSequence) ||
    !integer(threadRevision)
  ) {
    throw new ApplicationError("validation", "message_window_position_invalid");
  }
  return { direction, messageSequence, threadRevision };
}

function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}
function integer(input: unknown): input is number {
  return Number.isSafeInteger(input) && Number(input) >= 1;
}
