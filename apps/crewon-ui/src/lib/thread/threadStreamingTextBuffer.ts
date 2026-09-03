export type StreamingTextByThread = Record<string, string>;

// Gateways can release several provider deltas in one burst. Pace those bursts
// at a stable 30 Hz instead of forcing a full Markdown render on every display
// frame. A normal short answer still becomes visible in roughly one second.
const STREAMING_UPDATE_INTERVAL_MS = 32;
const MIN_STREAMING_CHARACTERS_PER_UPDATE = 8;
const TARGET_BURST_STREAMING_UPDATES = 36;

type StreamingTextSetter = (
  updater: (current: StreamingTextByThread) => StreamingTextByThread,
) => void;

export type StreamingTextFrameScheduler = {
  cancelFrame: (handle: number) => void;
  requestFrame: (callback: () => void) => number;
};

function timeoutFrameScheduler(): StreamingTextFrameScheduler {
  return {
    cancelFrame: (handle) => {
      globalThis.clearTimeout(handle);
    },
    requestFrame: (callback) =>
      globalThis.setTimeout(
        callback,
        STREAMING_UPDATE_INTERVAL_MS,
      ) as unknown as number,
  };
}

export function browserStreamingTextFrameScheduler(): StreamingTextFrameScheduler {
  return timeoutFrameScheduler();
}

function hasPendingText(pending: StreamingTextByThread): boolean {
  return Object.values(pending).some((text) => text.length > 0);
}

function streamingChunkSize(characterCount: number): number {
  return Math.max(
    MIN_STREAMING_CHARACTERS_PER_UPDATE,
    Math.ceil(characterCount / TARGET_BURST_STREAMING_UPDATES),
  );
}

function takeStreamingChunk(
  value: string,
  characterLimit: number,
): [chunk: string, remainder: string] {
  let offset = 0;
  let count = 0;
  for (const character of value) {
    if (count >= characterLimit) {
      break;
    }
    offset += character.length;
    count += 1;
  }
  return [value.slice(0, offset), value.slice(offset)];
}

export function createStreamingTextBuffer(
  setStreamingTextByThread: StreamingTextSetter,
  scheduler: StreamingTextFrameScheduler = browserStreamingTextFrameScheduler(),
) {
  let pendingByThread: StreamingTextByThread = {};
  let pendingCharacterCountByThread: Record<string, number> = {};
  let chunkSizeByThread: Record<string, number> = {};
  let scheduledFrame: number | null = null;
  const drainWaiters = new Map<string, Set<() => void>>();

  const resolveDrainWaiters = (threadId: string) => {
    const waiters = drainWaiters.get(threadId);
    if (waiters === undefined) {
      return;
    }
    drainWaiters.delete(threadId);
    for (const resolve of waiters) {
      resolve();
    }
  };

  const cancelScheduledFrame = () => {
    if (scheduledFrame === null) {
      return;
    }

    scheduler.cancelFrame(scheduledFrame);
    scheduledFrame = null;
  };

  const flush = () => {
    scheduledFrame = null;
    if (!hasPendingText(pendingByThread)) {
      return;
    }

    const visibleByThread: StreamingTextByThread = {};
    const remainingByThread: StreamingTextByThread = {};
    const remainingCharacterCountByThread: Record<string, number> = {};
    for (const [threadId, pending] of Object.entries(pendingByThread)) {
      if (!pending) {
        resolveDrainWaiters(threadId);
        continue;
      }
      const [visible, remaining] = takeStreamingChunk(
        pending,
        chunkSizeByThread[threadId] ?? MIN_STREAMING_CHARACTERS_PER_UPDATE,
      );
      visibleByThread[threadId] = visible;
      if (remaining) {
        remainingByThread[threadId] = remaining;
        remainingCharacterCountByThread[threadId] =
          (pendingCharacterCountByThread[threadId] ?? 0) -
          Array.from(visible).length;
      } else {
        delete chunkSizeByThread[threadId];
        resolveDrainWaiters(threadId);
      }
    }
    pendingByThread = remainingByThread;
    pendingCharacterCountByThread = remainingCharacterCountByThread;

    setStreamingTextByThread((current) => {
      let next = current;
      for (const [threadId, delta] of Object.entries(visibleByThread)) {
        if (!delta) {
          continue;
        }

        if (next === current) {
          next = { ...current };
        }
        next[threadId] = `${next[threadId] ?? ""}${delta}`;
      }
      return next;
    });

    if (hasPendingText(pendingByThread)) {
      scheduleFlush();
    }
  };

  const scheduleFlush = () => {
    if (scheduledFrame !== null) {
      return;
    }

    scheduledFrame = scheduler.requestFrame(flush);
  };

  return {
    append(threadId: string, delta: string): void {
      if (!delta) {
        return;
      }

      const pending = `${pendingByThread[threadId] ?? ""}${delta}`;
      const pendingCharacterCount =
        (pendingCharacterCountByThread[threadId] ?? 0) +
        Array.from(delta).length;
      pendingByThread = {
        ...pendingByThread,
        [threadId]: pending,
      };
      pendingCharacterCountByThread = {
        ...pendingCharacterCountByThread,
        [threadId]: pendingCharacterCount,
      };
      chunkSizeByThread = {
        ...chunkSizeByThread,
        [threadId]: Math.max(
          chunkSizeByThread[threadId] ?? 0,
          streamingChunkSize(pendingCharacterCount),
        ),
      };
      scheduleFlush();
    },
    clearPending(threadId?: string): void {
      if (threadId) {
        const { [threadId]: _removed, ...remaining } = pendingByThread;
        pendingByThread = remaining;
        const { [threadId]: _removedCount, ...remainingCounts } =
          pendingCharacterCountByThread;
        pendingCharacterCountByThread = remainingCounts;
        const { [threadId]: _removedSize, ...remainingSizes } =
          chunkSizeByThread;
        chunkSizeByThread = remainingSizes;
        resolveDrainWaiters(threadId);
      } else {
        pendingByThread = {};
        pendingCharacterCountByThread = {};
        chunkSizeByThread = {};
        for (const pendingThreadId of [...drainWaiters.keys()]) {
          resolveDrainWaiters(pendingThreadId);
        }
      }

      if (!hasPendingText(pendingByThread)) {
        cancelScheduledFrame();
      }
    },
    dispose(): void {
      pendingByThread = {};
      pendingCharacterCountByThread = {};
      chunkSizeByThread = {};
      cancelScheduledFrame();
      for (const threadId of [...drainWaiters.keys()]) {
        resolveDrainWaiters(threadId);
      }
    },
    flush,
    whenDrained(threadId: string): Promise<void> {
      if (!pendingByThread[threadId]) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const waiters = drainWaiters.get(threadId) ?? new Set<() => void>();
        waiters.add(resolve);
        drainWaiters.set(threadId, waiters);
      });
    },
  };
}
