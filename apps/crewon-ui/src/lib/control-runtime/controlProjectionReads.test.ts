import { describe, expect, it, vi } from "vitest";
import { ControlProjectionReads } from "./controlProjectionReads";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ControlProjectionReads", () => {
  it("retains ownership only until its deferred stream start runs", async () => {
    vi.useFakeTimers();
    try {
      const reads = new ControlProjectionReads();
      const start = vi.fn();
      await reads.run("thread-1", async ({ defer }) => {
        defer(start);
      });
      expect(reads.activeThreadCount).toBe(1);
      expect(start).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(start).toHaveBeenCalledTimes(1);
      expect(reads.activeThreadCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels obsolete, failed and closed deferred stream starts", async () => {
    vi.useFakeTimers();
    try {
      const reads = new ControlProjectionReads();
      const stale = vi.fn();
      const current = vi.fn();
      await reads.run("thread-1", async ({ defer }) => {
        defer(stale);
      });
      await reads.run("thread-1", async ({ defer }) => {
        defer(current);
      });
      expect(vi.getTimerCount()).toBe(1);
      await vi.runAllTimersAsync();
      expect(stale).not.toHaveBeenCalled();
      expect(current).toHaveBeenCalledTimes(1);
      await expect(
        reads.run("thread-2", async ({ defer }) => {
          defer(stale);
          throw new Error("snapshot_changed");
        }),
      ).rejects.toThrow("snapshot_changed");
      expect(vi.getTimerCount()).toBe(0);
      expect(reads.activeThreadCount).toBe(0);
      await reads.run("thread-3", async ({ defer }) => {
        defer(stale);
      });
      reads.close();
      expect(vi.getTimerCount()).toBe(0);
      expect(reads.activeThreadCount).toBe(0);
      await vi.runAllTimersAsync();
      expect(stale).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases metadata after 10,000 distinct completed or failed reads", async () => {
    const reads = new ControlProjectionReads();
    for (let index = 0; index < 10_000; index++) {
      if (index % 2 === 0) {
        expect(
          await reads.run(`thread-${index}`, async ({ assertCurrent }) => {
            assertCurrent();
            expect(reads.activeThreadCount).toBe(1);
            return index;
          }),
        ).toBe(index);
      } else {
        await expect(
          reads.run(`thread-${index}`, async () => {
            throw new Error("read_failed");
          }),
        ).rejects.toThrow("read_failed");
      }
      expect(reads.activeThreadCount).toBe(0);
    }
  });

  it("does not revive a stale read after newer reads finish and restart", async () => {
    const reads = new ControlProjectionReads();
    const slow = deferred<void>();
    const latest = deferred<void>();
    const stale = reads.run("thread-1", async ({ assertCurrent }) => {
      await slow.promise;
      assertCurrent();
    });
    const rejected = expect(stale).rejects.toThrow(
      "control_thread_projection_superseded",
    );
    await reads.run("thread-1", async () => "newer");
    expect(reads.activeThreadCount).toBe(0);
    const current = reads.run("thread-1", async ({ assertCurrent }) => {
      await latest.promise;
      assertCurrent();
      return "latest";
    });
    slow.resolve();
    await rejected;
    expect(reads.activeThreadCount).toBe(1);
    latest.resolve();
    await expect(current).resolves.toBe("latest");
    expect(reads.activeThreadCount).toBe(0);
  });

  it("isolates different Threads and invalidates all late results on close", async () => {
    const reads = new ControlProjectionReads();
    const gate = deferred<void>();
    const publish = vi.fn();
    const first = reads.run("thread-1", async ({ assertCurrent }) => {
      await gate.promise;
      assertCurrent();
      publish();
    });
    const rejected = expect(first).rejects.toThrow(
      "control_thread_projection_superseded",
    );
    await reads.run("thread-2", async ({ assertCurrent }) => {
      expect(reads.activeThreadCount).toBe(2);
      assertCurrent();
    });
    expect(reads.activeThreadCount).toBe(1);
    reads.close();
    expect(reads.activeThreadCount).toBe(0);
    gate.resolve();
    await rejected;
    await expect(reads.run("thread-3", async () => publish())).rejects.toThrow(
      "control_thread_projection_superseded",
    );
    expect(publish).not.toHaveBeenCalled();
  });
});
