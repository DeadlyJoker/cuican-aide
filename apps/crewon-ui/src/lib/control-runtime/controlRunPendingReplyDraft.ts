import { appendStreamingTail } from "../thread/streamingTextChunks";

/** UI-only text; localId is never a durable Message or ThreadItem identifier. */
export type ControlPendingReplyDraft = Readonly<{
  localId: string;
  text: string;
  partial: boolean;
}>;

const MAX_DRAFT_UNITS = 128 * 1024;
const MAX_RUN_DRAFTS = 32;

/** Bounded per-Run previews survive replacement of the thread's live stream slot. */
export class ControlRunPendingReplyDrafts {
  readonly #drafts = new Map<string, ControlPendingReplyDraft>();

  apply(runId: string, projected: { reset: boolean; delta: string }): void {
    if (!projected.reset && !projected.delta) return;
    const prior = projected.reset ? undefined : this.#drafts.get(runId);
    const tail = appendStreamingTail(
      prior?.text ?? "",
      projected.delta,
      MAX_DRAFT_UNITS,
    );
    this.#drafts.delete(runId);
    this.#drafts.set(runId, {
      localId: `pending-reply:${runId}`,
      text: tail.text,
      partial: (prior?.partial ?? false) || tail.truncated,
    });
    while (this.#drafts.size > MAX_RUN_DRAFTS)
      this.#drafts.delete(this.#drafts.keys().next().value!);
  }

  get(runId: string): ControlPendingReplyDraft | null {
    const value = this.#drafts.get(runId);
    return value?.text ? value : null;
  }

  delete(runId: string): void {
    this.#drafts.delete(runId);
  }
  clear(): void {
    this.#drafts.clear();
  }
}
