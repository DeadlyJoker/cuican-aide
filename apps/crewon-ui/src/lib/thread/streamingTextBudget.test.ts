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
  totalVisibleBytes: 128,
};
function harness(limits = budget) {
  let text: StreamingTextByThread = {};
  let presentation = EMPTY_STREAMING_PRESENTATION;
  let updates = 0;
  const buffer = createStreamingTextBuffer(
    (update) => {
      text = update(text);
      updates++;
    },
    {
      budget: limits,
      onPresentation: (value) => {
        presentation = value;
      },
    },
  );
  function assertBounded() {
    const size = buffer.usage();
    expect(size.streams).toBeLessThanOrEqual(limits.maxStreams);
    expect(size.visibleBytes).toBeLessThanOrEqual(limits.totalVisibleBytes);
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

  it("clears only the finishing task and retains concurrent output", () => {
    const h = harness();
    h.buffer.append("first", "discard");
    h.buffer.append("second", "keep😀");
    h.buffer.replace((current) => ({ ...current, first: "" }));
    expect(h.text).toEqual({ second: "keep😀" });
    h.buffer.reset("second");
    expect(h.text).toEqual({});
  });

  it("limits sustained deltas and marks contiguous trailing content as partial", () => {
    const h = harness();
    let source = "";
    for (let index = 0; index < 1000; index++) {
      const delta = `片段${index}😀`;
      source += delta;
      h.buffer.append("thread", delta);
      h.assertBounded();
    }
    expect(source.endsWith(h.text.thread!)).toBe(true);
    expect(h.text.thread!.endsWith("片段999😀")).toBe(true);
    expect(h.presentation.previews.thread?.partial).toBe(true);
  });

  it("clips an oversized delta before retaining a bounded live preview", () => {
    const h = harness();
    h.buffer.append("thread", "old");
    h.buffer.append("thread", "大😀".repeat(1_000_000) + "latest😀");
    h.assertBounded();
    expect(h.text.thread?.endsWith("latest😀")).toBe(true);
    expect(h.presentation.previews.thread?.partial).toBe(true);
  });

  it("bounds visible bytes globally and reclaims nonfocused previews", async () => {
    const h = harness();
    h.buffer.setFocus("focus");
    h.buffer.append("focus", "f".repeat(5000));
    h.buffer.append("old", "o".repeat(5000));
    const discardedDrain = h.buffer.whenDrained("old");
    h.buffer.append("new", "n".repeat(5000));
    await discardedDrain;
    expect(h.text.focus).toBe("f".repeat(32));
    expect(h.text.old).toBeUndefined();
    expect(h.text.new).toBe("n".repeat(32));
    expect(h.presentation.reclaimed).toBe(true);
    h.assertBounded();
  });

  it("bounds retained identities across 20,000 background updates without rendering", () => {
    const h = harness();
    h.buffer.append("focus", "selected");
    h.buffer.setFocus("focus");
    h.buffer.setVisible(false);
    const updates = h.updates;
    for (let index = 0; index < 20_000; index++) {
      h.buffer.append(`thread-${index}`, `后台${index}😀`);
      if (index % 100 === 0) h.assertBounded();
    }
    expect(h.updates).toBe(updates);
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
  });

  it("never makes settlement wait for a render timer", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.buffer.append("thread", "x".repeat(1000) + "完成");
    await h.buffer.whenDrained("thread");
    expect(h.text.thread?.endsWith("完成")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes previews and rejects resurrection by late producers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.buffer.append("thread", "x".repeat(100));
    const drained = h.buffer.whenDrained("thread");
    h.buffer.dispose();
    h.buffer.append("thread", "late");
    h.buffer.replace({ thread: "late" });
    await drained;
    expect(h.updates).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.buffer.usage().streams).toBe(0);
  });
});
