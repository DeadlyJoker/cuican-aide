import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createStreamingTextBuffer,
  type StreamingTextByThread,
} from "./threadStreamingTextBuffer";

function harness() {
  let text: StreamingTextByThread = {};
  let updates = 0;
  const buffer = createStreamingTextBuffer((updater) => {
    updates++;
    text = updater(text);
  });
  return {
    buffer,
    get text() {
      return text;
    },
    get updates() {
      return updates;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("direct streaming text previews", () => {
  it("publishes each complete received delta immediately without a timer", () => {
    vi.useFakeTimers();
    const h = harness();

    h.buffer.append("first", "A");
    expect(h.text).toEqual({ first: "A" });
    h.buffer.append("first", "B😀");
    expect(h.text).toEqual({ first: "AB😀" });
    h.buffer.append("second", "C");
    expect(h.text).toEqual({ first: "AB😀", second: "C" });
    expect(h.updates).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears one completed preview without dropping a concurrent task", () => {
    const h = harness();
    h.buffer.append("finished", "discarded");
    h.buffer.append("active", "keep");
    h.buffer.reset("finished");
    expect(h.text).toEqual({ active: "keep" });
    h.buffer.append("active", "😀");
    expect(h.text).toEqual({ active: "keep😀" });
  });

  it("does not resurrect reset hidden output when the page returns", () => {
    const h = harness();
    h.buffer.setVisible(false);
    h.buffer.append("discarded", "stale");
    h.buffer.append("active", "keep");
    h.buffer.reset("discarded");
    expect(h.updates).toBe(0);
    h.buffer.setVisible(true);
    expect(h.text).toEqual({ active: "keep" });
  });

  it("shows a gateway burst in full before Run settlement without advancing time", async () => {
    vi.useFakeTimers();
    const h = harness();
    const burst = `${"答".repeat(395)}😀完成`;
    h.buffer.append("thread", burst);
    expect(h.text.thread).toBe(burst);
    await h.buffer.whenDrained("thread");
    expect(h.text.thread).toBe(burst);
    expect(h.updates).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps consecutive bursts current without delaying a parallel task", async () => {
    const h = harness();
    const first = "正在生成😀".repeat(100);
    const second = "另一会话的完整输出😀".repeat(100);
    h.buffer.append("first", first);
    expect(h.text.first).toBe(first);
    h.buffer.append("first", "\n完成。");
    expect(h.text.first).toBe(`${first}\n完成。`);
    h.buffer.append("second", second);
    expect(h.text.second).toBe(second);
    await h.buffer.whenDrained("first");
    expect(h.text).toEqual({ first: `${first}\n完成。`, second });
    expect(h.updates).toBe(3);
  });
});
