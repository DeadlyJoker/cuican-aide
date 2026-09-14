import { afterEach, expect, it, vi } from "vitest";
import { ControlHistoryReadBudget } from "./controlHistoryReadBudget";

afterEach(() => vi.useRealTimers());
const drain = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

it("shares four historical slots and reserves capacity for terminal recovery", async () => {
  const budget = new ControlHistoryReadBudget();
  const lifetime = new AbortController();
  const started: string[] = [];
  const pending: Promise<unknown>[] = [];
  const read = (runId: string, kind: "history" | "settlement") =>
    budget
      .run({
        runId,
        kind,
        timeoutMs: 10_000,
        signal: lifetime.signal,
        read: async (signal) => {
          started.push(runId);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      })
      .catch((error: unknown) => error);
  try {
    for (let index = 0; index < 20; index++)
      pending.push(read(`thread-${index}:run`, "history"));
    await drain();
    expect(started).toHaveLength(4);
    pending.push(
      read("terminal-a", "settlement"),
      read("terminal-b", "settlement"),
    );
    await drain();
    expect(started.slice(-2)).toEqual(["terminal-a", "terminal-b"]);
    expect(budget.usage).toMatchObject({
      active: 6,
      activeHistory: 4,
      queued: 16,
    });
  } finally {
    lifetime.abort();
    await Promise.all(pending);
    await drain();
  }
  expect(budget.usage).toEqual({
    active: 0,
    activeHistory: 0,
    queued: 0,
    queuedBytes: 0,
  });
});

it("reserves queue capacity for final recovery when historical work saturates its queue", async () => {
  const budget = new ControlHistoryReadBudget();
  const lifetime = new AbortController();
  const pending: Promise<unknown>[] = [];
  const add = (kind: "history" | "settlement", runId: string) =>
    pending.push(
      budget
        .run({
          kind,
          runId,
          signal: lifetime.signal,
          timeoutMs: 1000,
          read: async (signal) =>
            new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            ),
        })
        .catch((error: unknown) => error),
    );
  try {
    for (let index = 0; index < 40; index++) add("history", `history-${index}`);
    await drain();
    expect(budget.usage).toMatchObject({ active: 4, queued: 24 });
    add("settlement", "terminal-1");
    add("settlement", "terminal-2");
    add("settlement", "terminal-3");
    await drain();
    expect(budget.usage).toMatchObject({ active: 6, queued: 25 });
  } finally {
    lifetime.abort();
    await Promise.all(pending);
    await drain();
  }
  expect(budget.usage.active).toBe(0);
});

it.each([20, 512])(
  "bounds queued count and descriptor bytes for %i-character identities",
  async (length) => {
    vi.useFakeTimers();
    const budget = new ControlHistoryReadBudget();
    const lifetime = new AbortController();
    const releases: (() => void)[] = [];
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 80; index++)
      pending.push(
        budget
          .run({
            kind: "history",
            runId: "r".repeat(length),
            signal: lifetime.signal,
            timeoutMs: 100,
            read: () => new Promise<void>((resolve) => releases.push(resolve)),
          })
          .catch((error: unknown) => error),
      );
    await drain();
    expect(releases).toHaveLength(4);
    expect(budget.usage.queued).toBeLessThanOrEqual(32);
    expect(budget.usage.queuedBytes).toBeLessThanOrEqual(32 * 1024);
    await vi.advanceTimersByTimeAsync(100);
    const results = await Promise.all(pending);
    expect(
      results.some(
        (result) =>
          result instanceof Error &&
          result.message === "control_tool_history_capacity",
      ),
    ).toBe(true);
    expect(budget.usage).toEqual({
      active: 4,
      activeHistory: 4,
      queued: 0,
      queuedBytes: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
    let laterStarted = false;
    const later = budget.run({
      kind: "history",
      runId: "later",
      signal: lifetime.signal,
      timeoutMs: 100,
      read: async () => {
        laterStarted = true;
      },
    });
    const timedOut = expect(later).rejects.toThrow(
      "control_tool_history_timeout",
    );
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(laterStarted).toBe(false);
    for (const release of releases) release();
    await drain();
    expect(budget.usage.active).toBe(0);
    lifetime.abort();
  },
);

it("cleans one shared parent listener, queued cancellations, thrown reads and completed deadlines", async () => {
  vi.useFakeTimers();
  const budget = new ControlHistoryReadBudget();
  const lifetime = new AbortController();
  const add = vi.spyOn(lifetime.signal, "addEventListener");
  const remove = vi.spyOn(lifetime.signal, "removeEventListener");
  const pending: Promise<unknown>[] = [];
  for (let index = 0; index < 30; index++)
    pending.push(
      budget
        .run({
          kind: "history",
          runId: `r-${index}`,
          signal: lifetime.signal,
          timeoutMs: 1000,
          read: async (signal) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          },
        })
        .catch((error: unknown) => error),
    );
  await drain();
  expect(add).toHaveBeenCalledTimes(1);
  lifetime.abort();
  await Promise.all(pending);
  await drain();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const next = new AbortController();
  await expect(
    budget.run({
      kind: "history",
      runId: "throws",
      signal: next.signal,
      timeoutMs: 1000,
      read: async () => {
        throw new Error("disconnected");
      },
    }),
  ).rejects.toThrow("disconnected");
  await expect(
    budget.run({
      kind: "history",
      runId: "works",
      signal: next.signal,
      timeoutMs: 1000,
      read: async () => 42,
    }),
  ).resolves.toBe(42);
  await drain();
  expect(budget.usage.active).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
