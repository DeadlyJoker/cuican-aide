import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamingTextBuffer,
  EMPTY_STREAMING_PRESENTATION,
  type StreamingTextBudget,
  type StreamingTextByThread,
} from "./threadStreamingTextBuffer";
import {
  StreamingTextChunks,
  boundedStreamingTail,
} from "./streamingTextChunks";

const budget: StreamingTextBudget = {
  maxStreams: 4,
  visibleBytesPerStream: 64,
  pendingBytesPerStream: 16384,
  totalVisibleBytes: 128,
  totalPendingBytes: 32768,
};
function harness(limits = budget) {
  let text: StreamingTextByThread = {};
  let presentation = EMPTY_STREAMING_PRESENTATION;
  const frames = new Map<number, () => void>();
  let next = 0,
    updates = 0;
  const buffer = createStreamingTextBuffer(
    (update) => {
      text = update(text);
      updates++;
    },
    {
      requestFrame: (callback) => {
        const id = ++next;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (id) => {
        frames.delete(id);
      },
    },
    {
      budget: limits,
      onPresentation: (value) => {
        presentation = value;
      },
    },
  );
  function drainFrames() {
    while (frames.size) {
      const [id, callback] = frames.entries().next().value!;
      frames.delete(id);
      callback();
    }
  }
  function assertBounded() {
    const size = buffer.usage();
    expect(size.streams).toBeLessThanOrEqual(limits.maxStreams);
    expect(size.visibleBytes).toBeLessThanOrEqual(limits.totalVisibleBytes);
    expect(size.pendingBytes).toBeLessThanOrEqual(limits.totalPendingBytes);
    expect(Object.keys(presentation.previews).length).toBeLessThanOrEqual(
      limits.maxStreams,
    );
    expect(
      Object.values(text).reduce((n, text) => n + text.length * 2, 0),
    ).toBeLessThanOrEqual(limits.totalVisibleBytes);
    for (const value of Object.values(text))
      expect(value.length * 2).toBeLessThanOrEqual(
        limits.visibleBytesPerStream,
      );
  }
  return {
    buffer,
    frames,
    drainFrames,
    assertBounded,
    get text() {
      return text;
    },
    get presentation() {
      return presentation;
    },
    get updates() {
      return updates;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("streaming text resource budgets", () => {
  it("accounts for allocated pages and preserves Unicode at page and trim boundaries", () => {
    const queue = new StreamingTextChunks();
    const text = "x".repeat(4095) + "😀" + "z".repeat(4095);
    queue.append(text);
    expect(queue.allocatedBytes).toBe(16384);
    expect(queue.take(4095)).toBe("x".repeat(4095));
    expect(queue.capacityAfterAppend(1)).toBe(24576);
    expect(queue.take(1)).toBe("😀");
    expect(queue.allocatedBytes).toBe(8192);
    expect(queue.tail(2)).toBe("zz");
    expect(queue.take(5000)).toBe("z".repeat(4095));
    expect(queue.allocatedBytes).toBe(0);
    queue.append("old😀z");
    expect(queue.tail(2)).toBe("z");
    expect(boundedStreamingTail("old😀z", 2)).toEqual({
      text: "z",
      truncated: true,
    });
  });

  it("clears only the finishing task, including text not painted yet", () => {
    const h = harness();
    h.buffer.append("first", "discard");
    h.buffer.append("second", "keep😀");
    h.buffer.replace((current) => ({ ...current, first: "" }));
    h.drainFrames();
    expect(h.text).toEqual({ second: "keep😀" });
    h.buffer.reset("second");
    expect(h.text).toEqual({});
    expect(h.frames.size).toBe(0);
  });

  it("limits sustained deltas and marks contiguous trailing content as partial", () => {
    const h = harness();
    let source = "";
    for (let index = 0; index < 1000; index++) {
      const delta = `片段${index}😀`;
      source += delta;
      h.buffer.append("thread", delta);
      if (index % 7 === 0) h.drainFrames();
      h.assertBounded();
    }
    h.drainFrames();
    expect(source.endsWith(h.text.thread!)).toBe(true);
    expect(h.text.thread!.endsWith("片段999😀")).toBe(true);
    expect(h.presentation.previews.thread?.partial).toBe(true);
    expect(h.buffer.usage().pendingBytes).toBe(0);
  });

  it("clips an oversized delta before queue allocation", () => {
    const h = harness();
    h.buffer.append("thread", "old");
    h.buffer.append("thread", "大😀".repeat(1_000_000) + "latest😀");
    expect(h.buffer.usage().pendingBytes).toBe(0);
    h.drainFrames();
    h.assertBounded();
    expect(h.text.thread?.endsWith("latest😀")).toBe(true);
    expect(h.presentation.previews.thread?.partial).toBe(true);
  });

  it("bounds queued bytes globally and reclaims nonfocused previews", async () => {
    const h = harness();
    h.buffer.setFocus("focus");
    h.buffer.append("focus", "f".repeat(5000));
    h.buffer.append("old", "o".repeat(5000));
    const discardedDrain = h.buffer.whenDrained("old");
    h.buffer.append("new", "n".repeat(5000));
    await discardedDrain;
    expect(h.buffer.usage().pendingBytes).toBe(32768);
    h.drainFrames();
    expect(h.text.focus).toBe("f".repeat(32));
    expect(h.text.old).toBeUndefined();
    expect(h.text.new).toBe("n".repeat(32));
    expect(h.presentation.reclaimed).toBe(true);
    h.assertBounded();
  });

  it("bounds retained identities across 20,000 background updates without rendering", () => {
    const h = harness();
    h.buffer.append("focus", "selected");
    h.drainFrames();
    h.buffer.setFocus("focus");
    h.buffer.setVisible(false);
    const updates = h.updates;
    for (let index = 0; index < 20_000; index++) {
      h.buffer.append(`thread-${index}`, `后台${index}😀`);
      if (index % 100 === 0) h.assertBounded();
    }
    expect(h.updates).toBe(updates);
    expect(h.frames.size).toBe(0);
    h.buffer.setVisible(true);
    expect(h.updates).toBe(updates + 1);
    expect(h.text.focus).toBe("selected");
    expect(h.text["thread-19999"]).toBe("后台19999😀");
    h.assertBounded();
    h.buffer.replace({});
    expect(h.presentation).toEqual(EMPTY_STREAMING_PRESENTATION);
    expect(h.buffer.usage()).toEqual({
      streams: 0,
      visibleBytes: 0,
      pendingBytes: 0,
      pendingUnits: 0,
    });
  });

  it("fast forwards a hidden burst without joining old text across an omitted Unicode boundary", async () => {
    const h = harness({ ...budget, visibleBytesPerStream: 4 });
    h.buffer.replace({ thread: "AB" });
    h.buffer.append("thread", "old😀z");
    h.buffer.setVisible(false);
    await h.buffer.whenDrained("thread");
    h.buffer.setVisible(true);
    expect(h.text.thread).toBe("z");
    expect(h.presentation.previews.thread?.partial).toBe(true);
    expect(h.frames.size).toBe(0);
  });

  it("shares one drain waiter and completes settlement even when frames stop", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.buffer.append("thread", "x".repeat(1000) + "完成");
    const drained = h.buffer.whenDrained("thread");
    for (let index = 0; index < 1000; index++)
      expect(h.buffer.whenDrained("thread")).toBe(drained);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    await drained;
    expect(h.text.thread?.endsWith("完成")).toBe(true);
    expect(h.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes pending work and rejects resurrection by late frames or producers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.buffer.append("thread", "x".repeat(100));
    const late = [...h.frames.values()][0]!;
    const drained = h.buffer.whenDrained("thread");
    h.buffer.dispose();
    h.buffer.append("thread", "late");
    h.buffer.replace({ thread: "late" });
    late();
    await drained;
    expect(h.updates).toBe(0);
    expect(h.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.buffer.usage().streams).toBe(0);
  });
});
