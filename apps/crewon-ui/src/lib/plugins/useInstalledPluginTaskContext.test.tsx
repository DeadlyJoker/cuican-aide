// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstalledPluginTaskContext } from "./useInstalledPluginTaskContext";
import { installedPluginTaskRequest } from "./installedPluginTaskRequests";
import type {
  InstalledPluginTaskContextInput,
  InstalledPluginTaskContextState,
} from "./useInstalledPluginTaskContext.types";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import {
  taskContextDeferred,
  taskContextError,
  taskContextFixture,
  taskContextJson,
  taskContextModule,
  taskContextReceipt,
  taskContextRun,
  taskContextTask,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("installed plugin task context (actual Control client, named HTTP fixtures)", () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: InstalledPluginTaskContextState;
  let input: InstalledPluginTaskContextInput;
  let f: ReturnType<typeof taskContextFixture>;
  function Probe(props: InstalledPluginTaskContextInput) {
    state = useInstalledPluginTaskContext(props);
    return <output>{JSON.stringify(state.data)}</output>;
  }
  async function render(patch: Partial<InstalledPluginTaskContextInput> = {}) {
    input = { ...input, ...patch };
    await act(async () => {
      root.render(<Probe {...input} />);
    });
  }
  async function change(action: () => void) {
    await act(async () => {
      action();
    });
  }
  async function ready() {
    await act(async () => {
      await vi.waitFor(() => expect(state.phase).toBe("ready"));
    });
  }
  beforeEach(() => {
    f = taskContextFixture();
    input = {
      ports: f.ports,
      module: taskContextModule(),
      active: true,
      selectedThreadId: "thread-1",
      runIds: [],
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("opens using actual GET revision, skips ordinary Runs and never implicitly creates a Thread", async () => {
    f.runs.set("thread-1", [
      taskContextRun("ordinary-run"),
      taskContextRun("run-1"),
    ]);
    f.tasks.set("run-1", taskContextTask());
    await render();
    await ready();
    expect(state.thread).toEqual({
      threadId: "thread-1",
      revision: 17,
      provisional: false,
    });
    expect(state.data).toMatchObject({
      threadId: "thread-1",
      expectedThreadRevision: 17,
    });
    expect(state.tasks.map((task) => task.runId)).toEqual(["run-1"]);
    expect(state.source).toBeNull();
    expect(f.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it.each(["inactive", "noPorts", "uiOnly"] as const)(
    "does no task reads for %s",
    async (mode) => {
      await render(
        mode === "inactive"
          ? { active: false }
          : mode === "noPorts"
            ? { ports: null }
            : { module: taskContextModule(1, false) },
      );
      expect(state.phase).toBe("idle");
      expect(state.thread).toBeNull();
      expect(f.requests).toHaveLength(0);
    },
  );

  it("keeps a new module read-only until explicit preparation and uses GET, not creation receipt, for revision", async () => {
    await render({ selectedThreadId: null });
    await ready();
    expect(state.thread).toBeNull();
    expect(f.requests).toHaveLength(0);
    await change(() => state.prepareThread());
    await ready();
    expect(state.thread).toEqual({
      threadId: "prepared-thread",
      revision: 23,
      provisional: true,
    });
    const posts = f.requests.filter(({ method }) => method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ title: null });
    expect(posts[0]?.key).toMatch(/^plugin-thread:/u);
    expect(input.selectedThreadId).toBeNull();
    await change(() => state.prepareThread());
    await ready();
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
  });

  it("preserves exact body and key after an unknown create response, and retries without new metadata prerequisites", async () => {
    let attempt = 0;
    f.setHandler((request) => {
      if (request.method !== "POST") return;
      return ++attempt === 1
        ? taskContextError(500, "named_unknown_creation")
        : taskContextJson({
            disposition: "replayed",
            thread: taskContextThread("prepared-thread", 1),
          });
    });
    await render({ selectedThreadId: null });
    await ready();
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.waitFor(() => expect(state.phase).toBe("uncertain"));
    });
    expect(state.error).toBe("plugin_task_thread_creation_uncertain");
    await change(() => state.prepareThread());
    await ready();
    const posts = f.requests.filter(({ method }) => method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]?.key).toBe(posts[0]?.key);
    expect(posts[1]?.body).toEqual(posts[0]?.body);
    expect(
      f.requests.filter(({ path }) =>
        /agent|package|configuration|quote|operation/u.test(path),
      ),
    ).toHaveLength(0);
  });

  it("retains a known creation receipt when its follow-up GET fails instead of creating another Thread", async () => {
    let reads = 0;
    f.setHandler((request) =>
      request.path === "/api/v1/threads/prepared-thread" && ++reads === 1
        ? taskContextError(500, "named_followup_failure")
        : undefined,
    );
    await render({ selectedThreadId: null });
    await ready();
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.waitFor(() => expect(state.phase).toBe("uncertain"));
    });
    await change(() => state.prepareThread());
    await ready();
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
    expect(state.thread?.revision).toBe(23);
  });

  it("waits for a timed-out create's actual fetch before retrying the identical command", async () => {
    vi.useFakeTimers();
    const late = taskContextDeferred<Response>();
    let posts = 0;
    f.setHandler((request) =>
      request.method === "POST" && ++posts === 1 ? late.promise : undefined,
    );
    await render({ selectedThreadId: null });
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(state.phase).toBe("uncertain");
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
    await change(() => state.prepareThread());
    expect(state.phase).toBe("preparing");
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
    await change(() =>
      late.resolve(
        taskContextJson({
          disposition: "committed",
          thread: taskContextThread("prepared-thread", 1),
        }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state.phase).toBe("ready");
    const actual = f.requests.filter(({ method }) => method === "POST");
    expect(actual).toHaveLength(2);
    expect(actual[1]?.key).toBe(actual[0]?.key);
    expect(actual[1]?.body).toEqual(actual[0]?.body);
  });

  it.each(["navigation", "session"] as const)(
    "does not dispatch a queued create after %s withdraws its original owner",
    async (withdrawal) => {
      const blocked = taskContextDeferred<Response>();
      f.setHandler((request) =>
        request.path === "/api/v1/threads/thread-1"
          ? blocked.promise
          : undefined,
      );
      const physical = installedPluginTaskRequest(f.client, (signal) =>
        f.client.getThread("thread-1", { signal }),
      );
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      await render({ selectedThreadId: null });
      await ready();
      await change(() => state.prepareThread());
      expect(state.phase).toBe("preparing");
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        0,
      );
      if (withdrawal === "navigation")
        await render({ selectedThreadId: "thread-2" });
      else
        await change(() => {
          f.withdraw();
          window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
        });
      await change(() =>
        blocked.resolve(
          taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
        ),
      );
      await physical;
      if (withdrawal === "navigation") await ready();
      else expect(state.phase).toBe("idle");
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        0,
      );
      expect(
        f.requests.some(
          ({ path }) => path === "/api/v1/threads/prepared-thread",
        ),
      ).toBe(false);
    },
  );

  it("does not dispatch a queued confirmation GET after navigation, retaining the already-dispatched create only", async () => {
    const creation = taskContextDeferred<Response>(),
      blockingGet = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.method === "POST"
        ? creation.promise
        : request.path === "/api/v1/threads/thread-1"
          ? blockingGet.promise
          : undefined,
    );
    await render({ selectedThreadId: null });
    await ready();
    await change(() => state.prepareThread());
    await vi.waitFor(() =>
      expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
        1,
      ),
    );
    const physical = installedPluginTaskRequest(f.client, (signal) =>
      f.client.getThread("thread-1", { signal }),
    );
    await change(() =>
      creation.resolve(
        taskContextJson({
          disposition: "committed",
          thread: taskContextThread("prepared-thread", 1),
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(
        f.requests.some(({ path }) => path === "/api/v1/threads/thread-1"),
      ).toBe(true),
    );
    expect(
      f.requests.some(({ path }) => path === "/api/v1/threads/prepared-thread"),
    ).toBe(false);
    await render({ selectedThreadId: "thread-2" });
    await change(() =>
      blockingGet.resolve(
        taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
      ),
    );
    await physical;
    await ready();
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(
      1,
    );
    expect(
      f.requests.some(({ path }) => path === "/api/v1/threads/prepared-thread"),
    ).toBe(false);
    expect(state.thread?.threadId).toBe("thread-2");
  });

  it("verifies a same-pin HTTP receipt, adopts the actual task and refreshes revision without selecting App navigation", async () => {
    f.tasks.set("run-1", taskContextTask());
    await render();
    await ready();
    f.threads.set("thread-1", taskContextThread("thread-1", 29));
    await change(() => f.emit(taskContextReceipt()));
    await ready();
    await act(async () => {
      await vi.waitFor(() => expect(f.adopt).toHaveBeenCalledTimes(1));
    });
    expect(f.adopt.mock.calls[0]?.[0]).toMatchObject({
      runId: "run-1",
      threadRevision: 8,
    });
    expect(state.thread?.revision).toBe(29);
    expect(state.tasks[0]?.configurationRevision).toBe(3);
    expect(input.selectedThreadId).toBe("thread-1");
    await change(() =>
      f.emit(taskContextReceipt(input.module, { disposition: "replayed" })),
    );
    await ready();
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(state.thread?.revision).toBe(29);
  });

  it.each(["thread", "configuration"] as const)(
    "withholds adoption for an authoritative task whose %s differs from its receipt",
    async (kind) => {
      f.tasks.set(
        "run-1",
        taskContextTask(
          "run-1",
          kind === "thread"
            ? { threadId: "different-thread" }
            : { configurationRevision: 4 },
        ),
      );
      await render();
      await ready();
      await change(() => f.emit(taskContextReceipt()));
      await act(async () => {
        await vi.waitFor(() => expect(state.phase).toBe("error"));
      });
      expect(state.error).toBe("plugin_task_context_unavailable");
      expect(state.thread?.revision).toBe(17);
      expect(f.adopt).not.toHaveBeenCalled();
    },
  );

  it("recovers old-package metadata under a new selection without adopting the old lease, and requires explicit original operation selection", async () => {
    f.events.push(
      taskContextReceipt(taskContextModule(1), { runId: "query-run" }),
    );
    f.tasks.set(
      "query-run",
      taskContextTask("query-run", {
        sourceRunId: "original-generation",
        operations: [
          {
            operationId: "22222222-2222-2222-2222-222222222222",
            sourceRunId: "original-generation",
            status: "succeeded",
            observedAt: "2026-10-03T00:00:00.000Z",
            images: [],
          },
        ],
      }),
    );
    await render({ module: taskContextModule(2) });
    await ready();
    expect(state.tasks[0]?.pluginVersion).toBe("1.0.1");
    expect(f.adopt).not.toHaveBeenCalled();
    expect(state.source).toBeNull();
    await change(() =>
      state.selectSource({
        sourceRunId: "query-run",
        operationId: "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect(state.source).toBeNull();
    expect(state.error).toBe("plugin_task_source_unavailable");
    await change(() =>
      state.selectSource({
        sourceRunId: "original-generation",
        operationId: "22222222-2222-2222-2222-222222222222",
      }),
    );
    expect(state.data).toMatchObject({
      sourceRunId: "original-generation",
      operationId: "22222222-2222-2222-2222-222222222222",
    });
    expect(f.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("ignores other contribution or publisher receipts", async () => {
    await render();
    await ready();
    const event = taskContextReceipt();
    await change(() => {
      f.emit({
        ...event,
        lease: { ...event.lease, contributionId: "other-contribution" },
      });
      f.emit({
        ...event,
        lease: {
          ...event.lease,
          descriptor: {
            ...event.lease.descriptor,
            publisherId: "other.publisher",
          },
        },
      });
    });
    await ready();
    expect(state.tasks).toHaveLength(0);
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("preserves this owner's verified thread/source through a metadata failure, disabling new intents until a fresh GET", async () => {
    f.tasks.set("run-1", taskContextTask());
    await render({ runIds: ["run-1"] });
    await ready();
    const source = {
      sourceRunId: "run-1",
      operationId: "11111111-1111-1111-1111-111111111111",
    };
    await change(() => state.selectSource(source));
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1"
        ? taskContextError(500, "named_read_failure")
        : undefined,
    );
    await change(() => state.refresh());
    await act(async () => {
      await vi.waitFor(() => expect(state.phase).toBe("error"));
    });
    expect(state.data).toMatchObject({
      threadId: "thread-1",
      expectedThreadRevision: 17,
      ...source,
      taskContextReady: false,
    });
    expect(state.tasks).toHaveLength(1);
    f.setHandler(null);
    f.threads.set("thread-1", taskContextThread("thread-1", 33));
    await change(() => state.refresh());
    await ready();
    expect(state.data).toMatchObject({
      expectedThreadRevision: 33,
      ...source,
      taskContextReady: true,
    });
  });

  it("fences a late read when thread navigation changes, while retaining only the new owner's actual revision", async () => {
    const late = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    await render();
    await render({ selectedThreadId: "thread-2" });
    expect(state.thread).toBeNull();
    expect(f.requests).toHaveLength(1);
    await change(() =>
      late.resolve(
        taskContextJson({
          thread: taskContextThread("thread-1", 999),
          eventSequence: 999,
        }),
      ),
    );
    await ready();
    expect(state.thread).toEqual({
      threadId: "thread-2",
      revision: 41,
      provisional: false,
    });
  });

  it("withdraws immediately on session invalidation and does not publish a late task or receipt", async () => {
    const late = taskContextDeferred<Response>();
    f.runs.set("thread-1", [taskContextRun("run-1")]);
    f.setHandler((request) =>
      request.path.endsWith("/tasks/run-1") ? late.promise : undefined,
    );
    await render();
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          f.requests.some(({ path }) => path.endsWith("/tasks/run-1")),
        ).toBe(true),
      );
    });
    await change(() => {
      f.withdraw();
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    });
    expect(state.phase).toBe("idle");
    expect(state.thread).toBeNull();
    await change(() => {
      late.resolve(taskContextJson({ task: taskContextTask() }));
      f.emit(taskContextReceipt());
    });
    expect(state.tasks).toHaveLength(0);
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("serializes repeated refreshes within one owner and performs metadata GETs only", async () => {
    const late = taskContextDeferred<Response>();
    f.setHandler((request) =>
      request.path === "/api/v1/threads/thread-1" ? late.promise : undefined,
    );
    await render();
    await change(() => {
      state.refresh();
      state.refresh();
      state.refresh();
    });
    expect(
      f.requests.filter(({ path }) => path === "/api/v1/threads/thread-1"),
    ).toHaveLength(1);
    f.setHandler(null);
    await change(() =>
      late.resolve(
        taskContextJson({ thread: taskContextThread(), eventSequence: 17 }),
      ),
    );
    await ready();
    expect(f.requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("bounds restored tasks to eight and does not swallow permission or non-task-not-found failures", async () => {
    for (let index = 0; index < 12; index++) {
      const runId = `historical-${index}`;
      f.events.push(taskContextReceipt(input.module, { runId }));
      f.tasks.set(runId, taskContextTask(runId));
    }
    await render();
    await ready();
    expect(state.tasks).toHaveLength(8);
    f.setHandler((request) =>
      request.path.includes("/tasks/")
        ? taskContextError(403, "named_private_policy_reason")
        : undefined,
    );
    await change(() => state.refresh());
    await act(async () => {
      await vi.waitFor(() => expect(state.phase).toBe("error"));
    });
    expect(state.error).toBe("plugin_task_context_unavailable");
    expect(JSON.stringify(state.data)).not.toContain(
      "named_private_policy_reason",
    );
    expect(state.tasks).toHaveLength(8);
    expect(state.data).toMatchObject({ taskContextReady: false });
  });
});
