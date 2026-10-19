import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installedPluginTaskRequest,
  installedPluginTaskRead,
} from "./installedPluginTaskRequests";
import { PLUGIN_UI_CONTROL_DEADLINE_MS } from "./controlPluginUiSupport";
import {
  taskContextDeferred,
  taskContextFixture,
  taskContextJson,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";

afterEach(() => vi.useRealTimers());
describe("installed task HTTP physical ownership (real Control client)", () => {
  it("does not release a fetch that ignores timeout or let a replacement pin start another physical request", async () => {
    vi.useFakeTimers();
    const f = taskContextFixture(),
      late = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    const first = installedPluginTaskRequest(f.client, (signal) =>
      f.client.getThread("thread-1", { signal }),
    );
    const failed = expect(first).rejects.toThrow("plugin_ui_control_timeout");
    await vi.advanceTimersByTimeAsync(PLUGIN_UI_CONTROL_DEADLINE_MS + 1);
    await failed;
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.signal?.aborted).toBe(true);
    const replacement = installedPluginTaskRequest(f.client, (signal) =>
      f.client.getThread("thread-2", { signal }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(1);
    late.resolve(
      taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
    );
    const actual = await replacement;
    expect(actual.thread.threadId).toBe("thread-2");
    expect(f.requests).toHaveLength(2);
  });

  it("keeps physical ownership after cancellation, while a genuinely new session client has independent capacity", async () => {
    const old = taskContextFixture(),
      fresh = taskContextFixture();
    const late = taskContextDeferred<Response>(),
      controller = new AbortController();
    old.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    const first = installedPluginTaskRequest(
      old.client,
      (signal) => old.client.getThread("thread-1", { signal }),
      controller.signal,
    );
    const failed = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(old.requests).toHaveLength(1));
    controller.abort();
    await failed;
    const next = installedPluginTaskRequest(old.client, (signal) =>
      old.client.getThread("thread-2", { signal }),
    );
    const freshResult = await installedPluginTaskRequest(
      fresh.client,
      (signal) => fresh.client.getThread("thread-2", { signal }),
    );
    expect(freshResult.thread.revision).toBe(41);
    expect(old.requests).toHaveLength(1);
    late.resolve(
      taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
    );
    expect((await next).thread.revision).toBe(41);
  });

  it("bounds waiting owners without granting any additional physical capacity", async () => {
    const f = taskContextFixture(),
      late = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      installedPluginTaskRequest(
        f.client,
        (signal) => f.client.getThread("thread-1", { signal }),
        controller.signal,
      ).catch(() => undefined),
    );
    await expect(
      installedPluginTaskRequest(f.client, (signal) =>
        f.client.getThread("thread-2", { signal }),
      ),
    ).rejects.toThrow("plugin_task_request_capacity");
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    controllers.forEach((controller) => controller.abort());
    await Promise.all(pending);
    expect(f.requests).toHaveLength(1);
    const replacement = installedPluginTaskRequest(f.client, (signal) =>
      f.client.getThread("thread-2", { signal }),
    );
    await Promise.resolve();
    expect(f.requests).toHaveLength(1);
    late.resolve(
      taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
    );
    await replacement;
  });
});

describe("independent plugin reads", () => {
  it("lets query panels hydrate while another read is slow", async () => {
    const f = taskContextFixture();
    const late = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    const slow = installedPluginTaskRead(f.client, (signal) =>
      f.client.getThread("thread-1", { signal }),
    );
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const fast = await installedPluginTaskRead(f.client, (signal) =>
      f.client.getThread("thread-2", { signal }),
    );
    expect(fast.thread.threadId).toBe("thread-2");
    late.resolve(
      taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
    );
    await slow;
  });

  it("releases completed read capacity while another panel stays slow", async () => {
    const client = {},
      late = taskContextDeferred<void>();
    const started = vi.fn(() => late.promise);
    const slow = installedPluginTaskRead(client, started);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    try {
      for (let index = 0; index < 20; index++)
        await expect(
          installedPluginTaskRead(client, async () => index),
        ).resolves.toBe(index);
    } finally {
      late.resolve();
      await slow;
    }
  });

  it("bounds physical reads and keeps writes exclusive", async () => {
    const client = {};
    const late = taskContextDeferred<void>();
    const read = vi.fn(() => late.promise);
    const reads = Array.from({ length: 5 }, () =>
      installedPluginTaskRead(client, read),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    const write = vi.fn(async () => {
      expect(read).toHaveBeenCalledTimes(5);
    });
    const pendingWrite = installedPluginTaskRequest(client, write);
    expect(write).not.toHaveBeenCalled();
    late.resolve();
    await Promise.all([...reads, pendingWrite]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("runs a queued write before later reads without overlapping physical work", async () => {
    const client = {},
      late = taskContextDeferred<void>(),
      written = taskContextDeferred<void>();
    const order: string[] = [];
    const first = installedPluginTaskRead(client, () => late.promise);
    const write = installedPluginTaskRequest(client, async () => {
      order.push("write");
      await written.promise;
    });
    const later = installedPluginTaskRead(client, async () => {
      order.push("read");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    late.resolve();
    await first;
    await vi.waitFor(() => expect(order).toEqual(["write"]));
    written.resolve();
    await Promise.all([write, later]);
    expect(order).toEqual(["write", "read"]);
  });

  it("removes a cancelled queued writer so independent reads can continue", async () => {
    const client = {},
      late = taskContextDeferred<void>(),
      controller = new AbortController();
    const slow = installedPluginTaskRead(client, () => late.promise);
    const write = vi.fn(async () => {});
    const pending = installedPluginTaskRequest(
      client,
      write,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    await expect(
      installedPluginTaskRead(client, async () => "ready"),
    ).resolves.toBe("ready");
    expect(write).not.toHaveBeenCalled();
    late.resolve();
    await slow;
  });

  it("retains a cancelled physical read's slot while other read slots remain usable and writes stay fenced", async () => {
    const client = {},
      controller = new AbortController();
    const late = taskContextDeferred<void>();
    const started = vi.fn(() => late.promise);
    const first = installedPluginTaskRead(client, started, controller.signal);
    const failed = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort();
    await failed;
    const others = taskContextDeferred<void>();
    const read = vi.fn(() => others.promise);
    const concurrent = Array.from({ length: 3 }, () =>
      installedPluginTaskRead(client, read),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    const fifth = taskContextDeferred<void>();
    const fifthRead = vi.fn(() => fifth.promise);
    const queuedRead = installedPluginTaskRead(client, fifthRead);
    const write = vi.fn(async () => {});
    const queuedWrite = installedPluginTaskRequest(client, write);
    await Promise.resolve();
    expect(fifthRead).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    others.resolve();
    await Promise.all(concurrent);
    await vi.waitFor(() => expect(fifthRead).toHaveBeenCalledOnce());
    fifth.resolve();
    await queuedRead;
    expect(write).not.toHaveBeenCalled();
    late.resolve();
    await queuedWrite;
    expect(write).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled exclusive physical request as a barrier until it truly settles", async () => {
    const client = {},
      controller = new AbortController();
    const late = taskContextDeferred<void>();
    const started = vi.fn(() => late.promise);
    const first = installedPluginTaskRequest(
      client,
      started,
      controller.signal,
    );
    const failed = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort();
    await failed;
    const read = vi.fn(async () => "ready");
    const next = installedPluginTaskRead(client, read);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    late.resolve();
    await expect(next).resolves.toBe("ready");
    expect(read).toHaveBeenCalledOnce();
  });
});
