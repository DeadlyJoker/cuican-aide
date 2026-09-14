import { expect, it, vi } from "vitest";
import type { RunEventView } from "@crewon/contracts";
import { ControlThreadRuntime } from "./controlThreadRuntime";
import {
  backfillControlToolProjection,
  createControlToolProjectionState,
  type ControlRunEventStream,
} from "./controlRunToolProjection";
import { controlHistoryReadBudget } from "./controlHistoryReadBudget";
import {
  transcriptFixture,
  transcriptRun,
} from "./controlTranscriptWindow.test-support";
import { transcriptWindow } from "./controlTranscriptWindow";

it("cancels abandoned page history while the authoritative live Run keeps streaming", async () => {
  const f = transcriptFixture(8);
  f.runtime.close();
  f.setActive(transcriptRun("run-live", true));
  const historySignals: AbortSignal[] = [];
  const liveSignals: AbortSignal[] = [];
  const onTextDelta = vi.fn();
  const runtime = new ControlThreadRuntime(
    {
      client: f.client,
      eventStream: async function* (_client, input) {
        const signal = input.signal!;
        if (input.runId === "run-live") {
          liveSignals.push(signal);
          yield {
            eventId: "live-output",
            runId: input.runId,
            sequence: 1,
            occurredAt: "2026-09-11T00:00:00Z",
            type: "model.output.delta",
            data: { segmentId: "segment-live", delta: "Still running" },
          } as RunEventView;
        } else historySignals.push(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
    {
      onThread() {},
      onTextDelta,
      onToolItem() {},
      onRunSettled() {},
      onStreamError() {},
    },
  );
  runtime.setThreadEventStreamFocus(null);
  const caller = new AbortController();
  const read = runtime.readThread("thread-1", { signal: caller.signal });
  const result = read.catch((error: unknown) => error);
  try {
    await vi.waitFor(() => {
      expect(historySignals).toHaveLength(4);
      expect(onTextDelta).toHaveBeenCalledWith("thread-1", "Still running");
    });
    caller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(historySignals.every((signal) => signal.aborted)).toBe(true);
      expect(controlHistoryReadBudget.usage.active).toBe(0);
    });
    expect(liveSignals).toHaveLength(1);
    expect(liveSignals[0]!.aborted).toBe(false);
    expect(f.mutations).toHaveLength(0);
  } finally {
    runtime.close();
    await result;
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage.active).toBe(0),
    );
  }
});

it("removes abandoned queued history without canceling unrelated admitted reads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = new AbortController();
  const occupying = Array.from({ length: 4 }, (_, index) =>
    controlHistoryReadBudget.run({
      kind: "history",
      runId: `occupied-${index}`,
      signal: owner.signal,
      timeoutMs: 5000,
      read: () => gate,
    }),
  );
  const f = transcriptFixture(8);
  f.runtime.setThreadEventStreamFocus(null);
  const caller = new AbortController();
  const result = f.runtime
    .readThread("thread-1", { signal: caller.signal })
    .catch((error: unknown) => error);
  try {
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage.queued).toBe(4),
    );
    caller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage).toEqual({
        active: 4,
        activeHistory: 4,
        queued: 0,
        queuedBytes: 0,
      }),
    );
    expect(owner.signal.aborted).toBe(false);
    expect(f.streamSignals.size).toBe(0);
  } finally {
    f.runtime.close();
    release();
    await Promise.allSettled([...occupying, result]);
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage.active).toBe(0),
    );
  }
});

it("bounds history across real runtimes while live output and final recovery continue", async () => {
  const fixtures = [transcriptFixture(8), transcriptFixture(8)];
  fixtures.forEach((f) => f.runtime.close());
  fixtures[0]!.setActive(transcriptRun("run-live", true));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = 0,
    peak = 0;
  const onTextDelta = vi.fn();
  const liveSignals: AbortSignal[] = [];
  const stream: ControlRunEventStream = async function* (_client, input) {
    const event = {
      eventId: input.runId,
      runId: input.runId,
      sequence: 1,
      occurredAt: "2026-09-11T00:00:00Z",
    };
    if (input.runId === "run-live") {
      liveSignals.push(input.signal!);
      yield {
        ...event,
        type: "model.output.delta",
        data: { segmentId: "segment-1", delta: "Still progressing" },
      } as RunEventView;
      await new Promise<void>((resolve) =>
        input.signal!.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return;
    }
    if (input.runId !== "terminal-recovery") {
      reading++;
      peak = Math.max(peak, reading);
      try {
        await gate;
      } finally {
        reading--;
      }
    }
    yield {
      ...event,
      type: "run.completed",
      data: { outputRef: null },
    } as RunEventView;
  };
  const runtimes = fixtures.map(
    (f) =>
      new ControlThreadRuntime(
        {
          client: f.client,
          eventStream: stream,
          threadEventStream: async function* (_client, input) {
            await new Promise<void>((resolve) =>
              input.signal!.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
          },
        },
        {
          onThread() {},
          onToolItem() {},
          onRunSettled() {},
          onStreamError() {},
          onTextDelta,
        },
      ),
  );
  const reads = runtimes.map((runtime) => runtime.readThread("thread-1"));
  try {
    await vi.waitFor(() => {
      expect(reading).toBe(4);
      expect(onTextDelta).toHaveBeenCalledWith("thread-1", "Still progressing");
    });
    expect(controlHistoryReadBudget.usage).toMatchObject({
      active: 4,
      queued: 4,
    });
    const terminal = await backfillControlToolProjection({
      client: fixtures[0]!.client,
      eventStream: stream,
      runId: "terminal-recovery",
      afterSequence: 0,
      throughSequence: 1,
      state: createControlToolProjectionState(),
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(terminal.lastSequence).toBe(1);
    expect(liveSignals[0]!.aborted).toBe(false);
    release();
    const threads = await Promise.all(reads);
    expect(threads.map((thread) => thread.turns.length)).toEqual([5, 4]);
    expect(peak).toBe(4);
    expect(liveSignals).toHaveLength(1);
  } finally {
    release();
    runtimes.forEach((runtime) => runtime.close());
    await Promise.allSettled(reads);
  }
  await vi.waitFor(() =>
    expect(controlHistoryReadBudget.usage).toEqual({
      active: 0,
      activeHistory: 0,
      queued: 0,
      queuedBytes: 0,
    }),
  );
  expect(liveSignals[0]!.aborted).toBe(true);
});

it("returns canonical messages with partial coverage after the whole optional hydration deadline", async () => {
  vi.useFakeTimers();
  const f = transcriptFixture(2);
  f.runtime.close();
  let release!: () => void;
  let started!: () => void;
  let historySignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = new ControlThreadRuntime(
    {
      client: f.client,
      eventStream: async function* (_client, input) {
        historySignal = input.signal;
        started();
        await gate;
        yield {
          eventId: "late",
          runId: input.runId,
          sequence: 1,
          occurredAt: "2026-09-11T00:00:00Z",
          type: "run.completed",
          data: { outputRef: null },
        };
      },
    },
    {
      onThread() {},
      onTextDelta() {},
      onToolItem() {},
      onRunSettled() {},
      onStreamError() {},
    },
  );
  runtime.setThreadEventStreamFocus(null);
  const read = runtime.readThread("thread-1");
  try {
    await entered;
    await vi.advanceTimersByTimeAsync(10_000);
    const page = await read;
    expect(page.turns[0]!.items).toContainEqual(
      expect.objectContaining({ type: "agentMessage", text: "Answer 2" }),
    );
    expect(transcriptWindow(page)?.toolHistory).toBe("partial");
    expect(historySignal?.aborted).toBe(true);
    expect(controlHistoryReadBudget.usage.active).toBe(1);
  } finally {
    runtime.close();
    release();
    await Promise.allSettled([read]);
    await vi.advanceTimersByTimeAsync(0);
    expect(controlHistoryReadBudget.usage.active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
