import { describe, expect, it, vi } from "vitest";
import type { ControlApiClient } from "@crewon/control-client";
import {
  catalogThread as thread,
  catalogClientFixture as clientFixture,
} from "./controlThreadCatalog.test-support";
import { ControlThreadCatalog } from "./controlThreadCatalog";

describe("bounded Control catalog", () => {
  it("replaces its working page while navigating more than 1,000 threads in both directions", async () => {
    const catalog = new ControlThreadCatalog(clientFixture());
    try {
      let page = await catalog.load({ status: "active", search: "" });
      let count = page.threads.length;
      while (page.olderCursor !== null) {
        page = await catalog.navigate("older");
        expect(catalog.getSnapshot().threads.length).toBeLessThanOrEqual(50);
        count += page.threads.length;
      }
      expect(count).toBe(1_301);
      while (page.newerCursor !== null) page = await catalog.navigate("newer");
      expect(page.threads[0]?.threadId).toBe(thread(1300).threadId);
      expect(page.threads.length).toBeLessThanOrEqual(50);
    } finally {
      catalog.close();
    }
  });
  it("continues sparse searches after a bounded empty batch without a lifetime page limit", async () => {
    const client = clientFixture();
    const catalog = new ControlThreadCatalog(client);
    try {
      let page = await catalog.load({ status: "active", search: "needle" });
      expect(page.threads).toEqual([]);
      expect(client.getThreadCatalog).toHaveBeenCalledTimes(4);
      expect(page.olderCursor).not.toBeNull();
      for (let index = 0; index < 10 && page.threads.length === 0; index++) {
        const before = client.getThreadCatalog.mock.calls.length;
        page = await catalog.navigate("older");
        expect(
          client.getThreadCatalog.mock.calls.length - before,
        ).toBeLessThanOrEqual(4);
      }
      expect(page.threads.map((record) => record.threadId)).toEqual([
        thread(0).threadId,
      ]);
      expect(client.getThreadCatalog.mock.calls.length).toBeGreaterThan(20);
    } finally {
      catalog.close();
    }
  });
  it("deduplicates identical reads, aborts superseded work and never publishes a late response", async () => {
    const client = clientFixture();
    let resolveOld!: (
      value: Awaited<ReturnType<ControlApiClient["getThreadCatalog"]>>,
    ) => void;
    let oldSignal: AbortSignal | undefined;
    client.getThreadCatalog.mockImplementationOnce((_query, options) => {
      oldSignal = options?.signal;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    });
    const catalog = new ControlThreadCatalog(client);
    try {
      const old = catalog.load({ status: "active", search: "old" });
      const rejected = expect(old).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(catalog.load({ status: "active", search: "old" })).toBe(old);
      const current = await catalog.load({
        status: "active",
        search: "Task 1300",
      });
      await rejected;
      expect(oldSignal?.aborted).toBe(true);
      resolveOld({
        schemaVersion: "crewon.thread-catalog.v0",
        data: [thread(1)],
        scannedCount: 1,
        olderCursor: null,
        newerCursor: null,
      });
      await Promise.resolve();
      expect(catalog.getSnapshot()).toBe(current);
      expect(current.threads.map((record) => record.threadId)).toEqual([
        thread(1300).threadId,
      ]);
    } finally {
      catalog.close();
    }
  });
  it("times out an uncooperative request and clears its owned timers and subscriptions", async () => {
    vi.useFakeTimers();
    const client = {
      getThreadCatalog: vi.fn<ControlApiClient["getThreadCatalog"]>(
        () => new Promise(() => {}),
      ),
    };
    const catalog = new ControlThreadCatalog(client, 100);
    try {
      const listener = vi.fn();
      catalog.subscribe(listener);
      const request = catalog.load({ status: "active", search: "" });
      const failed = expect(request).rejects.toThrow("control_catalog_timeout");
      await vi.advanceTimersByTimeAsync(100);
      await failed;
      expect(catalog.getSnapshot().loading).toBe(false);
      expect(catalog.getSnapshot().error).toBeInstanceOf(Error);
      catalog.close();
      expect(vi.getTimerCount()).toBe(0);
      const count = listener.mock.calls.length;
      catalog.cancel();
      expect(listener).toHaveBeenCalledTimes(count);
      expect(catalog.getSnapshot().threads).toEqual([]);
    } finally {
      catalog.close();
      vi.useRealTimers();
    }
  });
});
