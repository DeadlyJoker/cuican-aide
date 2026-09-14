import {
  appendStreamingTail,
  boundedStreamingTail,
  StreamingTextChunks,
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
  pendingBytesPerStream: number;
  totalVisibleBytes: number;
  totalPendingBytes: number;
};
// UTF-16 payload bounds, not a promise about React/V8 object overhead or RSS.
export const DEFAULT_STREAMING_TEXT_BUDGET: StreamingTextBudget = {
  maxStreams: 32,
  visibleBytesPerStream: 256 * 1024,
  pendingBytesPerStream: 1024 * 1024,
  totalVisibleBytes: 4 * 1024 * 1024,
  totalPendingBytes: 8 * 1024 * 1024,
};
const UPDATE_INTERVAL_MS = 32;
const DRAIN_DEADLINE_MS = 2000;
type StreamingTextSetter = (
  updater: (current: StreamingTextByThread) => StreamingTextByThread,
) => void;
export type StreamingTextFrameScheduler = {
  cancelFrame: (handle: number) => void;
  requestFrame: (callback: () => void) => number;
};
export function browserStreamingTextFrameScheduler(): StreamingTextFrameScheduler {
  return {
    cancelFrame: (handle) => globalThis.clearTimeout(handle),
    requestFrame: (callback) =>
      globalThis.setTimeout(callback, UPDATE_INTERVAL_MS) as unknown as number,
  };
}
type Entry = {
  text: string;
  received: boolean;
  pending: StreamingTextChunks;
  pendingCharacters: number;
  chunkSize: number;
  partial: boolean;
  drain?: {
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  };
};
function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

export function createStreamingTextBuffer(
  setText: StreamingTextSetter,
  scheduler: StreamingTextFrameScheduler = browserStreamingTextFrameScheduler(),
  options: {
    budget?: StreamingTextBudget;
    onPresentation?: (value: StreamingTextPresentation) => void;
  } = {},
) {
  const budget = { ...(options.budget ?? DEFAULT_STREAMING_TEXT_BUDGET) };
  if (
    Object.values(budget).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    budget.visibleBytesPerStream < 2 ||
    budget.pendingBytesPerStream < 8192 ||
    budget.visibleBytesPerStream > budget.totalVisibleBytes ||
    budget.pendingBytesPerStream > budget.totalPendingBytes
  ) {
    throw new Error("invalid_streaming_text_budget");
  }
  const visibleUnits = Math.floor(budget.visibleBytesPerStream / 2);
  const entries = new Map<string, Entry>();
  let frame: number | null = null;
  let shown = true;
  let disposed = false;
  let dirty = false;
  let reclaimed = false;
  let focusedThreadId: string | null = null;
  let presentation = EMPTY_STREAMING_PRESENTATION;
  const usage = () => {
    let visibleBytes = 0,
      pendingBytes = 0,
      pendingUnits = 0;
    for (const entry of entries.values()) {
      visibleBytes += entry.text.length * 2;
      pendingBytes += entry.pending.allocatedBytes;
      pendingUnits += entry.pending.length;
    }
    return { streams: entries.size, visibleBytes, pendingBytes, pendingUnits };
  };
  const resolveDrain = (entry: Entry) => {
    if (!entry.drain) return;
    const drain = entry.drain;
    delete entry.drain;
    clearTimeout(drain.timer);
    drain.resolve();
  };
  const clearQueue = (entry: Entry) => {
    entry.pending.clear();
    entry.pendingCharacters = 0;
    entry.chunkSize = 8;
    resolveDrain(entry);
  };
  const remove = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    clearQueue(entry);
    entries.delete(id);
    dirty = true;
  };
  const cancelFrame = () => {
    if (frame === null) return;
    scheduler.cancelFrame(frame);
    frame = null;
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
        size.visibleBytes <= budget.totalVisibleBytes &&
        size.pendingBytes <= budget.totalPendingBytes
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
  const fastForward = (entry: Entry) => {
    if (!entry.pending.length) return;
    const tail = entry.pending.tail(visibleUnits);
    const omitted = entry.pending.length > tail.length;
    const next = appendStreamingTail(
      omitted ? "" : entry.text,
      tail,
      visibleUnits,
    );
    entry.text = next.text;
    entry.partial ||= omitted || next.truncated;
    clearQueue(entry);
    dirty = true;
  };
  const schedule = () => {
    if (
      disposed ||
      !shown ||
      frame !== null ||
      (!dirty && !usage().pendingUnits)
    )
      return;
    frame = scheduler.requestFrame(flush);
  };
  function flush() {
    cancelFrame();
    if (disposed || !shown) return;
    for (const entry of entries.values()) {
      if (!entry.pending.length) continue;
      const chunk = entry.pending.take(entry.chunkSize);
      entry.pendingCharacters = Math.max(
        0,
        entry.pendingCharacters - characterCount(chunk),
      );
      const next = appendStreamingTail(entry.text, chunk, visibleUnits);
      entry.text = next.text;
      entry.partial ||= next.truncated;
      dirty = true;
      if (!entry.pending.length) clearQueue(entry);
    }
    enforceBudget();
    publish();
    schedule();
  }
  const createEntry = (): Entry => ({
    text: "",
    received: false,
    pending: new StreamingTextChunks(),
    pendingCharacters: 0,
    chunkSize: 8,
    partial: reclaimed,
  });
  // Protocol IDs are already bounded. Do not retain an unbounded malformed key.
  const validId = (id: string) => id.length > 0 && id.length <= 512;
  const combinedText = (entry: Entry) =>
    entry.text + entry.pending.tail(entry.pending.length);

  return {
    append(threadId: string, delta: string): void {
      if (disposed || !delta || !validId(threadId)) return;
      const entry = entries.get(threadId) ?? createEntry();
      entry.received ||= /\S/u.test(delta);
      entries.delete(threadId);
      entries.set(threadId, entry);
      enforceBudget(threadId);
      if (!entries.has(threadId)) {
        schedule();
        return;
      }
      const needed = entry.pending.capacityAfterAppend(delta.length);
      if (needed > budget.pendingBytesPerStream) {
        const tail = entry.pending.tail(visibleUnits);
        const prefix =
          entry.pending.length > tail.length
            ? tail
            : appendStreamingTail(entry.text, tail, visibleUnits).text;
        const next = appendStreamingTail(prefix, delta, visibleUnits);
        entry.text = next.text;
        entry.partial = true;
        clearQueue(entry);
      } else {
        while (
          usage().pendingBytes - entry.pending.allocatedBytes + needed >
          budget.totalPendingBytes
        ) {
          if (!evict(threadId) || !entries.has(threadId)) {
            schedule();
            return;
          }
        }
        entry.pending.append(delta);
        entry.pendingCharacters += characterCount(delta);
        entry.chunkSize = Math.max(
          entry.chunkSize,
          Math.ceil(entry.pendingCharacters / 36),
        );
      }
      dirty = true;
      enforceBudget(threadId);
      schedule();
    },
    // Evaluate updates against both displayed and queued text. Clearing a task
    // must not drop another task's not-yet-painted deltas.
    replace(
      update:
        | StreamingTextByThread
        | ((current: StreamingTextByThread) => StreamingTextByThread),
    ): void {
      if (disposed) return;
      const current = Object.fromEntries(
        [...entries].map(([id, entry]) => [id, combinedText(entry)]),
      );
      const next = typeof update === "function" ? update(current) : update;
      for (const id of entries.keys())
        if (!Object.hasOwn(next, id) || !next[id]) remove(id);
      for (const [id, value] of Object.entries(next)) {
        if (
          !value ||
          !validId(id) ||
          (entries.has(id) && value === current[id])
        )
          continue;
        const prior = entries.get(id);
        const entry = createEntry();
        const bounded = boundedStreamingTail(value, visibleUnits);
        entry.text = bounded.text;
        entry.received = /\S/u.test(value) || (prior?.received ?? false);
        entry.partial = bounded.truncated || (prior?.partial ?? reclaimed);
        remove(id);
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
      cancelFrame();
      schedule();
    },
    reset(threadId: string): void {
      if (disposed) return;
      remove(threadId);
      publish();
      cancelFrame();
      schedule();
    },
    clearPending(threadId?: string): void {
      if (disposed) return;
      for (const [id, entry] of entries) {
        if (threadId !== undefined && id !== threadId) continue;
        clearQueue(entry);
        if (!entry.text) entries.delete(id);
      }
      if (!usage().pendingUnits) {
        cancelFrame();
        dirty = false;
      }
    },
    setVisible(visible: boolean): void {
      if (disposed || shown === visible) return;
      shown = visible;
      cancelFrame();
      for (const entry of entries.values()) fastForward(entry);
      enforceBudget();
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
    whenDrained(threadId: string): Promise<void> {
      const entry = entries.get(threadId);
      if (disposed || !entry?.pending.length) {
        publish();
        return Promise.resolve();
      }
      if (!shown) {
        fastForward(entry);
        enforceBudget();
        return Promise.resolve();
      }
      if (entry.drain) return entry.drain.promise;
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => {
        fastForward(entry);
        enforceBudget();
        publish();
        cancelFrame();
        schedule();
      }, DRAIN_DEADLINE_MS);
      entry.drain = { promise, resolve, timer };
      schedule();
      return promise;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelFrame();
      for (const entry of entries.values()) clearQueue(entry);
      entries.clear();
    },
    flush,
    usage,
  };
}
