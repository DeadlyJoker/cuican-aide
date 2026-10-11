import { protocolError } from "./responses-errors.ts";

const MAX_TRACKED_MESSAGE_ITEMS = 512;

type MessageOutput = { text: string; completed: boolean };

/** Validates item completion without confusing an item's text with the whole response. */
export class ResponsesMessageOutput {
  readonly #items = new Map<number, MessageOutput>();
  #hasUnindexedDelta = false;
  #completedMessages = 0;

  observeDelta(indexValue: unknown, delta: string): void {
    const index = outputIndex(indexValue);
    if (delta.length === 0) return;
    if (index === null) {
      // After any message has completed, an unindexed delta cannot safely be
      // assigned to that closed item or to a new one.
      if (this.#completedMessages > 0)
        throw protocolError("responses_delta_after_item_done");
      this.#hasUnindexedDelta = true;
      return;
    }
    const item = this.#item(index);
    if (item.completed) throw protocolError("responses_delta_after_item_done");
    item.text += delta;
  }

  complete(indexValue: unknown, content: string, streamed: string): void {
    const requestedIndex = outputIndex(indexValue);
    const onlyIndex =
      this.#items.size === 1 ? this.#items.keys().next().value : undefined;
    const index = requestedIndex ?? onlyIndex ?? null;
    const item = index === null ? undefined : this.#items.get(index);
    if (item?.completed) throw protocolError("responses_output_item_duplicate");

    // Old single-message gateways may omit the delta index, the done index,
    // or both. Their text remains fully checked; never infer across two items.
    const legacySingle =
      this.#completedMessages === 0 &&
      (this.#items.size === 0 ||
        (this.#items.size === 1 &&
          index === onlyIndex &&
          (requestedIndex === null || this.#hasUnindexedDelta)));
    const expected = legacySingle
      ? streamed
      : index === null
        ? undefined
        : (item?.text ?? "");
    if (content !== expected)
      throw protocolError("responses_final_output_mismatch");
    if (this.#completedMessages >= MAX_TRACKED_MESSAGE_ITEMS)
      throw protocolError("responses_output_items_exceeded");
    if (index !== null) {
      const completed = item ?? this.#item(index);
      completed.text = content;
      completed.completed = true;
    }
    this.#completedMessages += 1;
  }

  #item(index: number): MessageOutput {
    const existing = this.#items.get(index);
    if (existing !== undefined) return existing;
    if (this.#items.size >= MAX_TRACKED_MESSAGE_ITEMS)
      throw protocolError("responses_output_items_exceeded");
    const item = { text: "", completed: false };
    this.#items.set(index, item);
    return item;
  }
}

function outputIndex(value: unknown): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw protocolError("responses_output_index_invalid");
  return Number(value);
}
