export type StreamingTextByThread = Record<string, string>;

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
      globalThis.setTimeout(callback, 32) as unknown as number,
  };
}

export function browserStreamingTextFrameScheduler(): StreamingTextFrameScheduler {
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function"
  ) {
    return timeoutFrameScheduler();
  }

  return {
    cancelFrame: (handle) => {
      window.cancelAnimationFrame(handle);
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
  };
}

function hasPendingText(pending: StreamingTextByThread): boolean {
  return Object.values(pending).some((text) => text.length > 0);
}

export function createStreamingTextBuffer(
  setStreamingTextByThread: StreamingTextSetter,
  scheduler: StreamingTextFrameScheduler = browserStreamingTextFrameScheduler(),
) {
  let pendingByThread: StreamingTextByThread = {};
  let scheduledFrame: number | null = null;

  const cancelScheduledFrame = () => {
    if (scheduledFrame === null) {
      return;
    }

    scheduler.cancelFrame(scheduledFrame);
    scheduledFrame = null;
  };

  const flush = () => {
    scheduledFrame = null;
    const pending = pendingByThread;
    pendingByThread = {};
    if (!hasPendingText(pending)) {
      return;
    }

    setStreamingTextByThread((current) => {
      let next = current;
      for (const [threadId, delta] of Object.entries(pending)) {
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

      pendingByThread = {
        ...pendingByThread,
        [threadId]: `${pendingByThread[threadId] ?? ""}${delta}`,
      };
      scheduleFlush();
    },
    clearPending(threadId?: string): void {
      if (threadId) {
        const { [threadId]: _removed, ...remaining } = pendingByThread;
        pendingByThread = remaining;
      } else {
        pendingByThread = {};
      }

      if (!hasPendingText(pendingByThread)) {
        cancelScheduledFrame();
      }
    },
    dispose(): void {
      pendingByThread = {};
      cancelScheduledFrame();
    },
    flush,
  };
}
