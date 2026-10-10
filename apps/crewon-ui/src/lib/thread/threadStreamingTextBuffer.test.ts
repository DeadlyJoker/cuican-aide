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

  it("clears one thread without dropping another thread's pending delta", () => {
    const manualScheduler = createManualScheduler();
    let streamingTextByThread: StreamingTextByThread = {};
    const buffer = createStreamingTextBuffer((updater) => {
      streamingTextByThread = updater(streamingTextByThread);
    }, manualScheduler.scheduler);

    buffer.append("discarded-thread", "stale");
    buffer.append("active-thread", "keep");
    buffer.clearPending("discarded-thread");
    manualScheduler.flushNext();

    expect(streamingTextByThread).toEqual({ "active-thread": "keep" });
  });

  it("publishes an entire gateway burst on the next frame and finishes its drain", async () => {
    const manualScheduler = createManualScheduler();
    let streamingTextByThread: StreamingTextByThread = {};
    let updateCount = 0;
    const buffer = createStreamingTextBuffer((updater) => {
      updateCount += 1;
      streamingTextByThread = updater(streamingTextByThread);
    }, manualScheduler.scheduler);
    const burst = `${"答".repeat(395)}😀完成`;
    let drained = false;

    buffer.append("thread-1", burst);
    void buffer.whenDrained("thread-1").then(() => {
      drained = true;
    });

    manualScheduler.flushNext();
    await Promise.resolve();

    expect(streamingTextByThread["thread-1"]).toBe(burst);
    expect(drained).toBe(true);
    expect(updateCount).toBe(1);
    expect(manualScheduler.callbacks.size).toBe(0);
  });

  it("keeps consecutive streamed bursts current without delaying a parallel task", async () => {
    const frames = createManualScheduler();
    let displayed: StreamingTextByThread = {};
    let updates = 0;
    const buffer = createStreamingTextBuffer((updater) => {
      displayed = updater(displayed);
      updates++;
    }, frames.scheduler);
    const first = "正在生成😀".repeat(100);
    buffer.append("first", first);
    frames.flushNext();
    expect(displayed.first).toBe(first);

    buffer.append("first", "\n完成。");
    buffer.append("second", "另一会话的完整输出😀".repeat(100));
    let settled = false;
    const drain = buffer.whenDrained("first").then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect(frames.callbacks.size).toBe(1);
    frames.flushNext();
    await drain;
    expect(displayed.first).toBe(`${first}\n完成。`);
    expect(displayed.second).toBe("另一会话的完整输出😀".repeat(100));
    expect(updates).toBe(2);
    expect(frames.callbacks.size).toBe(0);
  });
});
