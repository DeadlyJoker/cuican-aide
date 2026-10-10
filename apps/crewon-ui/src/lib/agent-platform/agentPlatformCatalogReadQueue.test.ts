import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlatformCatalogReadQueue } from "./agentPlatformCatalogReadQueue";

const settle = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

describe("background platform catalog read budget", () => {
  afterEach(() => vi.useRealTimers());

  it("shares two actual request slots across overlapping snapshots", async () => {
    const queue = new AgentPlatformCatalogReadQueue();
    const session = new AbortController();
    let active = 0,
      maximum = 0;
    const releases: (() => void)[] = [];
    const read = (value: number) =>
      queue.read({
        signal: session.signal,
        read: async () => {
          maximum = Math.max(maximum, ++active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active--;
          return value;
        },
      });
    const firstSnapshot = Promise.all(
      Array.from({ length: 7 }, (_, i) => read(i)),
    );
    const secondSnapshot = Promise.all(
      Array.from({ length: 7 }, (_, i) => read(i + 7)),
    );
    await settle();
    expect(releases).toHaveLength(2);
    for (let i = 0; i < 14; i++) {
      releases[i]!();
      await settle();
      expect(active).toBeLessThanOrEqual(2);
    }
    expect(await firstSnapshot).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(await secondSnapshot).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it("aborts only a timed-out read, retains the account and releases a settled request slot", async () => {
    vi.useFakeTimers();
    const queue = new AgentPlatformCatalogReadQueue({ maximumActive: 1 });
    const session = new AbortController();
    let requestSignal!: AbortSignal;
    const stalled = queue
      .read({
        signal: session.signal,
        read: (signal) => {
          requestSignal = signal;
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      })
      .catch((error: Error) => error.message);
    const next = queue.read({
      signal: session.signal,
      read: async () => "next",
    });
    await settle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requestSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stalled).toBe("agent_platform_catalog_read_timeout");
    expect(requestSignal.aborted).toBe(true);
    expect(session.signal.aborted).toBe(false);
    expect(await next).toBe("next");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace a physical request that ignores abort with another concurrent read", async () => {
    vi.useFakeTimers();
    const queue = new AgentPlatformCatalogReadQueue({ maximumActive: 1 });
    const session = new AbortController();
    let release!: () => void;
    const physical = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue
      .read({ signal: session.signal, read: () => physical })
      .catch((error: Error) => error.message);
    const nextRead = vi.fn(async () => "next");
    const next = queue.read({ signal: session.signal, read: nextRead });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toBe("agent_platform_catalog_read_timeout");
    expect(nextRead).not.toHaveBeenCalled();
    release();
    expect(await next).toBe("next");
    expect(nextRead).toHaveBeenCalledTimes(1);
  });

  it("withdraws both running and queued reads on account change before another account can run them", async () => {
    const queue = new AgentPlatformCatalogReadQueue({ maximumActive: 1 });
    const accountA = new AbortController();
    const read = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const a = queue
      .read({ signal: accountA.signal, read })
      .catch((e: Error) => e.message);
    const queued = queue
      .read({ signal: accountA.signal, read })
      .catch((e: Error) => e.message);
    await settle();
    accountA.abort(new Error("account changed"));
    expect(await a).toBe("account changed");
    expect(await queued).toBe("account changed");
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await queue.read({
        signal: new AbortController().signal,
        read: async () => "B",
      }),
    ).toBe("B");
  });
});
