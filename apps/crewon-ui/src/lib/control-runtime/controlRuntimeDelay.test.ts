// @ts-expect-error Vitest inspects Node listeners; the browser project omits Node types.
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForControlRuntimeDelay } from "./controlRuntimeDelay";

afterEach(() => vi.useRealTimers());

describe("control runtime delay resources", () => {
  it("returns to the listener baseline after 10,000 successful waits", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const unrelatedListener = vi.fn();
    controller.signal.addEventListener("abort", unrelatedListener);
    for (let index = 0; index < 10_000; index += 1) {
      const waiting = waitForControlRuntimeDelay({
        delayMs: 500,
        signal: controller.signal,
      });
      vi.advanceTimersByTime(500);
      await waiting;
      expect(getEventListeners(controller.signal, "abort")).toEqual([
        unrelatedListener,
      ]);
    }
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(unrelatedListener).toHaveBeenCalledOnce();
  });

  it("releases both the timer and listener when canceled during a wait", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const waiting = waitForControlRuntimeDelay({
      delayMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();
    await waiting;
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not allocate a timer or listener for an already canceled wait", async () => {
    vi.useFakeTimers();
    const signal = AbortSignal.abort();
    await waitForControlRuntimeDelay({ delayMs: 60_000, signal });
    expect(getEventListeners(signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
