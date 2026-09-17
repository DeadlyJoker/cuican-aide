import { Buffer } from "node:buffer";
import type {
  MessageRecord,
  ThreadMessageWindow,
  ThreadMessageWindowQuery,
  ThreadMessageWindowStore,
  ThreadScopedLocator,
  ThreadMessageRunBinding,
} from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import {
  assertMessageWindowThread,
  selectMessageWindowSequences,
  validateMessageWindowQuery,
} from "./thread-message-window.ts";

type Source = Readonly<{
  thread: ThreadState;
  messages: readonly MessageRecord[];
  invalidations: ReadonlyMap<number, unknown> | undefined;
  runBindings: (
    messages: readonly MessageRecord[],
  ) => readonly ThreadMessageRunBinding[];
}>;

export class InMemoryThreadMessageWindowStore
  implements ThreadMessageWindowStore
{
  readonly #read: (locator: ThreadScopedLocator) => Source | null;
  constructor(read: (locator: ThreadScopedLocator) => Source | null) {
    this.#read = read;
  }

  async readWindow(
    query: ThreadMessageWindowQuery,
  ): Promise<ThreadMessageWindow> {
    validateMessageWindowQuery(query);
    const source = this.#read(query);
    const thread = source?.thread ?? null;
    assertMessageWindowThread(thread, query);
    const messages = source!.messages;
    const older = query.position?.direction !== "newer";
    const lowerBound = (sequence: number) => {
      let start = 0;
      let end = messages.length;
      while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if (messages[middle]!.sequence < sequence) start = middle + 1;
        else end = middle;
      }
      return start;
    };
    const visible = (index: number) =>
      !source!.invalidations?.has(messages[index]!.sequence);
    let index =
      query.position === null
        ? messages.length - 1
        : older
          ? lowerBound(query.position.messageSequence) - 1
          : lowerBound(query.position.messageSequence + 1);
    const metadata: { sequence: number; storedBytes: number }[] = [];
    const selected = new Map<number, MessageRecord>();
    for (
      ;
      index >= 0 && index < messages.length && metadata.length < query.limit;
      index += older ? -1 : 1
    ) {
      if (!visible(index)) continue;
      const message = messages[index]!;
      metadata.push({
        sequence: message.sequence,
        storedBytes:
          Buffer.byteLength(message.content) +
          Buffer.byteLength(JSON.stringify(message)),
      });
      selected.set(message.sequence, message);
    }
    const page = selectMessageWindowSequences(metadata)
      .sort((a, b) => a - b)
      .map((sequence) => selected.get(sequence)!);
    const exists = (index: number, step: number) => {
      for (; index >= 0 && index < messages.length; index += step)
        if (visible(index)) return true;
      return false;
    };
    return structuredClone({
      thread,
      messages: page,
      hasOlder:
        page[0] !== undefined && exists(lowerBound(page[0].sequence) - 1, -1),
      hasNewer:
        page.at(-1) !== undefined &&
        exists(lowerBound(page.at(-1)!.sequence + 1), 1),
      ...(query.view === "transcript"
        ? { runBindings: source!.runBindings(page) }
        : {}),
    });
  }
}
