import { afterEach, describe, expect, it, vi } from "vitest";
import { installedPluginTaskRequest } from "./installedPluginTaskRequests";
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
    await vi.advanceTimersByTimeAsync(5_001);
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
    f.setHandler(() => late.promise);
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
    await expect(
      installedPluginTaskRequest(f.client, (signal) =>
        f.client.getThread("thread-2", { signal }),
      ),
    ).rejects.toThrow("plugin_task_request_capacity");
    late.resolve(
      taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
    );
  });
});
