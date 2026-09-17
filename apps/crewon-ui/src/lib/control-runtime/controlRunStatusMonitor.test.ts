// @ts-expect-error Vitest runs in Node; browser code has no Node runtime types.
import { getEventListeners } from "node:events";
import type { GetRunResponse } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlRunStatusMonitor } from "./controlRunStatusMonitor";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const response = {
  run: { runId: "run-1", threadId: "thread-1" },
} as GetRunResponse;

function fixture(
  getRun: ControlApiClient["getRun"] = vi.fn(async () => response),
) {
  const controller = new AbortController();
  const monitor = new ControlRunStatusMonitor({
    client: { getRun },
    runId: "run-1",
    threadId: "thread-1",
    signal: controller.signal,
  });
  return { controller, monitor, getRun };
}

describe("Run status reconciliation", () => {
  it("shares one in-flight request between polling and stream recovery", async () => {
    let finish!: (value: GetRunResponse) => void;
    const getRun = vi.fn(
      () =>
        new Promise<GetRunResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { monitor, controller } = fixture(getRun);
    const polling = monitor.read();
    const recovering = monitor.read();
    expect(polling).toBe(recovering);
    expect(getRun).toHaveBeenCalledOnce();
    finish(response);
    await expect(polling).resolves.toEqual(response);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    controller.abort();
  });

  it("uses sparse checks during a healthy stream and bounded jitter after failure", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { monitor, controller } = fixture(
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    let settled = false;
    let waiting = monitor.waitForPoll().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    monitor.observeStreamEvent();
    settled = false;
    waiting = monitor.waitForPoll().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    monitor.observeStreamDisconnected();
    for (let attempt = 0; attempt < 3; attempt += 1)
      await expect(monitor.read()).rejects.toThrow("offline");
    settled = false;
    waiting = monitor.waitForPoll().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    controller.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels stalled fetches on deadline and releases parent listeners", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    const { monitor, controller } = fixture(
      vi.fn<ControlApiClient["getRun"]>(
        (_runId, options) =>
          new Promise<GetRunResponse>((_resolve, reject) => {
            fetchSignal = options?.signal;
            fetchSignal?.addEventListener(
              "abort",
              () => reject(fetchSignal?.reason),
              { once: true },
            );
          }),
      ),
    );
    const result = expect(monitor.read()).rejects.toThrow(
      "control_run_status_timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetchSignal?.aborted).toBe(true);
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an uncooperative fetch single-flight after cancellation", async () => {
    vi.useFakeTimers();
    let finish!: (value: GetRunResponse) => void;
    const { monitor, controller, getRun } = fixture(
      vi.fn(
        () =>
          new Promise<GetRunResponse>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = monitor.read();
    const rejected = expect(pending).rejects.toThrow(
      "control_run_status_timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(monitor.read()).toBe(pending);
    expect(getRun).toHaveBeenCalledOnce();
    finish(response);
    await rejected;
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
  });

  it("aborts a read with its Run and rejects cross-thread responses", async () => {
    const { monitor, controller } = fixture(
      vi.fn<ControlApiClient["getRun"]>(
        (_runId, options) =>
          new Promise<GetRunResponse>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(options?.signal?.reason),
              { once: true },
            );
          }),
      ),
    );
    const result = expect(monitor.read()).rejects.toThrow("closed");
    controller.abort(new Error("closed"));
    await result;
    expect(getEventListeners(controller.signal, "abort")).toEqual([]);
    const wrong = fixture(
      vi.fn(async () => ({ run: { ...response.run, threadId: "other" } })),
    );
    await expect(wrong.monitor.read()).rejects.toThrow(
      "control_run_status_identity_invalid",
    );
    wrong.controller.abort();
  });
});
