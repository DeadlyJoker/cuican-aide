import type { ThreadMessageWindow } from "@crewon/application";
import {
  formatThreadMessageWindowCursor,
  type GetThreadMessageWindowResponse,
} from "@crewon/contracts";
import { projectMessage } from "./thread-projection.ts";

export function projectThreadMessageWindow(
  window: ThreadMessageWindow,
): GetThreadMessageWindowResponse {
  const threadId = window.thread.threadId;
  const cursor = (direction: "older" | "newer") => {
    const message =
      direction === "older" ? window.messages[0] : window.messages.at(-1);
    if (
      !(direction === "older" ? window.hasOlder : window.hasNewer) ||
      !message
    )
      return null;
    return formatThreadMessageWindowCursor(threadId, {
      threadRevision: window.thread.revision,
      direction,
      messageSequence: message.sequence,
    });
  };
  return {
    schemaVersion: "crewon.message-window.v0",
    threadId,
    threadRevision: window.thread.revision,
    eventSequence: window.thread.lastEventSequence,
    headMessageSequence: window.thread.lastMessageSequence,
    data: window.messages.map(projectMessage),
    olderCursor: cursor("older"),
    newerCursor: cursor("newer"),
  };
}
