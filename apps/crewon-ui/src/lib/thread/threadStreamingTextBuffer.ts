import {
  appendStreamingTail,
  boundedStreamingTail,
} from "./streamingTextChunks";

export type StreamingTextByThread = Record<string, string>;
export type StreamingTextActivity = "none" | "received" | "unavailable";
export type StreamingTextPresentation = {
  previews: Record<string, { partial: boolean }>;
  reclaimed: boolean;
};
export const EMPTY_STREAMING_PRESENTATION: StreamingTextPresentation = {
  previews: {},
  reclaimed: false,
};
export type StreamingTextBudget = {
  maxStreams: number;
  visibleBytesPerStream: number;
  totalVisibleBytes: number;
};
// UTF-16 payload bounds, not a promise about React/V8 object overhead or RSS.
export const DEFAULT_STREAMING_TEXT_BUDGET: StreamingTextBudget = {
  maxStreams: 32,
  visibleBytesPerStream: 256 * 1024,
  totalVisibleBytes: 4 * 1024 * 1024,
};
type StreamingTextSetter = (
  updater: (current: StreamingTextByThread) => StreamingTextByThread,
) => void;
type Entry = {
  text: string;
  received: boolean;
  partial: boolean;
};

/** Bounded live previews; received deltas are published without a typing queue. */
export function createStreamingTextBuffer(
  setText: StreamingTextSetter,
  options: {
    budget?: StreamingTextBudget;
    onPresentation?: (value: StreamingTextPresentation) => void;
  } = {},
) {
  const budget = { ...(options.budget ?? DEFAULT_STREAMING_TEXT_BUDGET) };
  if (
    Object.values(budget).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    budget.visibleBytesPerStream < 2 ||
    budget.visibleBytesPerStream > budget.totalVisibleBytes
  ) {
    throw new Error("invalid_streaming_text_budget");
  }
  const visibleUnits = Math.floor(budget.visibleBytesPerStream / 2);
  const entries = new Map<string, Entry>();
  let shown = true;
  let disposed = false;
  let dirty = false;
  let reclaimed = false;
  let focusedThreadId: string | null = null;
  let presentation = EMPTY_STREAMING_PRESENTATION;
  const usage = () => {
    let visibleBytes = 0;
    for (const entry of entries.values()) visibleBytes += entry.text.length * 2;
    return { streams: entries.size, visibleBytes };
  };
  const remove = (id: string) => {
    if (entries.delete(id)) dirty = true;
  };
  const evict = (keep: string | null): boolean => {
    const ids = [...entries.keys()];
    const id =
      ids.find((id) => id !== focusedThreadId && id !== keep) ??
      ids.find((id) => id !== focusedThreadId) ??
      ids[0];
    if (id === undefined) return false;
    remove(id);
    reclaimed = true;
    return true;
  };
  const enforceBudget = (keep: string | null = null) => {
    for (;;) {
      const size = usage();
      if (
        size.streams <= budget.maxStreams &&
        size.visibleBytes <= budget.totalVisibleBytes
      )
        return;
      if (!evict(keep)) return;
    }
  };
  const publish = () => {
    if (!dirty || disposed || !shown) return;
    dirty = false;
    const text = Object.fromEntries(
      [...entries]
        .filter(([, entry]) => entry.text)
        .map(([id, entry]) => [id, entry.text]),
    );
    const nextPresentation = {
      reclaimed,
      previews: Object.fromEntries(
        [...entries].map(([id, entry]) => [id, { partial: entry.partial }]),
      ),
    };
    if (JSON.stringify(nextPresentation) !== JSON.stringify(presentation)) {
      presentation = nextPresentation;
      options.onPresentation?.(presentation);
    }
    setText(() => text);
  };
  const createEntry = (): Entry => ({
    text: "",
    received: false,
    partial: reclaimed,
  });
  // Protocol IDs are already bounded. Do not retain an unbounded malformed key.
  const validId = (id: string) => id.length > 0 && id.length <= 512;

  return {
    append(threadId: string, delta: string): void {
      if (disposed || !delta || !validId(threadId)) return;
      const entry = entries.get(threadId) ?? createEntry();
      const next = appendStreamingTail(entry.text, delta, visibleUnits);
      entry.text = next.text;
      entry.partial ||= next.truncated;
      entry.received ||= /\S/u.test(delta);
      entries.delete(threadId);
      entries.set(threadId, entry);
      dirty = true;
      enforceBudget(threadId);
      // React owns render batching. No application timer may hold back a
      // received delta or make terminal settlement wait for simulated typing.
      publish();
    },
    replace(
      update:
        | StreamingTextByThread
        | ((current: StreamingTextByThread) => StreamingTextByThread),
    ): void {
      if (disposed) return;
      const current = Object.fromEntries(
        [...entries].map(([id, entry]) => [id, entry.text]),
      );
      const next = typeof update === "function" ? update(current) : update;
      for (const id of entries.keys())
        if (!Object.hasOwn(next, id) || !next[id]) remove(id);
      for (const [id, value] of Object.entries(next)) {
        if (!value || !validId(id) || value === current[id]) continue;
        const prior = entries.get(id);
        const entry = createEntry();
        const bounded = boundedStreamingTail(value, visibleUnits);
        entry.text = bounded.text;
        entry.received = /\S/u.test(value) || (prior?.received ?? false);
        entry.partial = bounded.truncated || (prior?.partial ?? reclaimed);
        entries.delete(id);
        entries.set(id, entry);
        dirty = true;
        enforceBudget(id);
      }
      if (!Object.keys(next).length && reclaimed) {
        reclaimed = false;
        dirty = true;
      }
      enforceBudget();
      publish();
    },
    reset(threadId: string): void {
      if (disposed) return;
      remove(threadId);
      publish();
    },
    setVisible(visible: boolean): void {
      if (disposed || shown === visible) return;
      shown = visible;
      publish();
    },
    setFocus(threadId: string | null): void {
      focusedThreadId = threadId;
    },
    activity(threadId: string): StreamingTextActivity {
      if (disposed) return "unavailable";
      const entry = entries.get(threadId);
      if (entry?.received) return "received";
      // Eviction is not proof that the model has produced no output.
      if ((!entry || entry.partial) && reclaimed) return "unavailable";
      return "none";
    },
    // Compatibility with Run settlement: direct publication has no queue to
    // drain, including when the browser suspends painting in a hidden tab.
    whenDrained(_threadId: string): Promise<void> {
      publish();
      return Promise.resolve();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      entries.clear();
    },
    usage,
  };
}
