import type { ControlApiClient } from "@crewon/control-client";
import { MessageReplayError } from "./controlMessageReplay";

/** Count canonical user boundaries with one page in memory, including internal Team users. */
export async function readControlReplayBoundary(input: {
  client: ControlApiClient;
  threadId: string;
  userMessageId: string;
  revision: number;
  signal: AbortSignal;
}) {
  let cursor: string | null = null;
  let upperSequence = Infinity;
  let numTurns = 0;
  while (true) {
    input.signal.throwIfAborted();
    const page = await input.client.getThreadMessageWindow(
      input.threadId,
      { cursor, limit: 100 },
      { signal: input.signal },
    );
    input.signal.throwIfAborted();
    if (
      page.threadRevision !== input.revision ||
      page.threadId !== input.threadId ||
      (page.data.at(-1)?.sequence ?? 0) >= upperSequence
    )
      throw new MessageReplayError("changed");
    for (let index = page.data.length - 1; index >= 0; index--) {
      const message = page.data[index]!;
      if (message.role === "user") numTurns++;
      if (numTurns > 0xffff_ffff) throw new MessageReplayError("changed");
      if (message.messageId === input.userMessageId) {
        if (message.role !== "user") throw new MessageReplayError("changed");
        return { message, numTurns };
      }
    }
    if (page.olderCursor === null || page.data.length === 0)
      throw new MessageReplayError("changed");
    upperSequence = page.data[0]!.sequence;
    cursor = page.olderCursor;
  }
}
