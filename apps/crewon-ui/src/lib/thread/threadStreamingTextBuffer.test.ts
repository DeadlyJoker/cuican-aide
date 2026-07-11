import { describe, expect, it } from "vitest";

import {
  createStreamingTextBuffer,
  type StreamingTextByThread,
  type StreamingTextFrameScheduler,
} from "./threadStreamingTextBuffer";

function createManualScheduler() {
  const callbacks = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: StreamingTextFrameScheduler = {
    cancelFrame: (handle) => {
      callbacks.delete(handle);
    },
    requestFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
  };

  return {
    callbacks,
    flushNext: () => {
      const [handle, callback] = callbacks.entries().next().value ?? [];
      if (!handle || !callback) {
        return;
      }

      callbacks.delete(handle);
      callback();
    },
    scheduler,
  };
}

describe("streaming text buffer", () => {
  it("coalesces character deltas into one state update per frame", () => {
    const manualScheduler = createManualScheduler();
    let streamingTextByThread: StreamingTextByThread = {};
    let updateCount = 0;
    const buffer = createStreamingTextBuffer((updater) => {
      updateCount += 1;
      streamingTextByThread = updater(streamingTextByThread);
    }, manualScheduler.scheduler);

    buffer.append("thread-1", "A");
    buffer.append("thread-1", "B");
    buffer.append("thread-2", "C");

    expect(updateCount).toBe(0);
    expect(manualScheduler.callbacks.size).toBe(1);

    manualScheduler.flushNext();

    expect(updateCount).toBe(1);
    expect(streamingTextByThread).toEqual({
      "thread-1": "AB",
      "thread-2": "C",
    });
  });

  it("clears pending deltas before a scheduled frame can resurrect old text", () => {
    const manualScheduler = createManualScheduler();
    let streamingTextByThread: StreamingTextByThread = { "thread-1": "old" };
    let updateCount = 0;
    const buffer = createStreamingTextBuffer((updater) => {
      updateCount += 1;
      streamingTextByThread = updater(streamingTextByThread);
    }, manualScheduler.scheduler);

    buffer.append("thread-1", " stale");
    buffer.clearPending();

    expect(manualScheduler.callbacks.size).toBe(0);

    manualScheduler.flushNext();

    expect(updateCount).toBe(0);
    expect(streamingTextByThread).toEqual({ "thread-1": "old" });
  });
});
