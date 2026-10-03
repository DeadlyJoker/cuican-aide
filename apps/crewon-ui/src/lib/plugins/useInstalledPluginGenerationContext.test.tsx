// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInstalledPluginGenerationContext } from "./useInstalledPluginGenerationContext";
import type {
  InstalledPluginGenerationContextInput,
  InstalledPluginGenerationContextState,
} from "./useInstalledPluginGenerationContext.types";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { deferred, flush } from "./pluginUiLoader.test-support";
import {
  taskContextError,
  taskContextJson,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";
import {
  generationContextFixture,
  generationContextLease,
  generationContextModule,
  generationContextRecord,
  generationContextRequest,
} from "./useInstalledPluginGenerationContext.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Host generation context, original Control client and account journal", () => {
  let root: Root, container: HTMLDivElement;
  let state: InstalledPluginGenerationContextState,
    input: InstalledPluginGenerationContextInput;
  let f: ReturnType<typeof generationContextFixture>;
  function Probe(props: InstalledPluginGenerationContextInput) {
    state = useInstalledPluginGenerationContext(props);
    return <output>{JSON.stringify(state.context)}</output>;
  }
  async function render(
    patch: Partial<InstalledPluginGenerationContextInput> = {},
    strict = false,
  ) {
    input = { ...input, ...patch };
    await act(async () => {
      root.render(
        strict ? (
          <StrictMode>
            <Probe {...input} />
          </StrictMode>
        ) : (
          <Probe {...input} />
        ),
      );
    });
  }
  async function change(action: () => void | Promise<void>) {
    await act(async () => {
      await action();
    });
  }
  async function phase(expected: string) {
    await act(async () => {
      await vi.waitFor(() => expect(state.context.phase).toBe(expected));
    });
  }
  const posts = () => f.requests.filter((value) => value.method === "POST");
  beforeEach(() => {
    f = generationContextFixture();
    input = {
      ports: f.ports,
      module: generationContextModule(),
      active: true,
      selectedThreadId: "thread-1",
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("opens with the original GET revision only and grants no extra task-service declaration or automatic creation", async () => {
    await render();
    await phase("ready");
    expect(state.context.thread).toEqual({
      threadId: "thread-1",
      revision: 17,
      provisional: false,
    });
    expect(state.context.threadReady).toBe(true);
    expect(
      input.module.plugin.descriptor.requires.map((item) => item.service),
    ).not.toContain("crewon.tasks");
    expect(f.requests.map((value) => value.path)).toEqual([
      "/api/v1/threads/thread-1",
    ]);
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it.each(["inactive", "noPorts", "noContexts", "wrongVersion"] as const)(
    "does no reads or preparation for %s",
    async (mode) => {
      const module = generationContextModule();
      const missing = {
        ...module,
        plugin: {
          ...module.plugin,
          descriptor: {
            ...module.plugin.descriptor,
            requires:
              mode === "wrongVersion"
                ? module.plugin.descriptor.requires.map((item) => ({
                    ...item,
                    apiVersion: "2",
                  }))
                : module.plugin.descriptor.requires.slice(0, 1),
          },
        },
      };
      await render(
        mode === "inactive"
          ? { active: false }
          : mode === "noPorts"
            ? { ports: null }
            : { module: missing },
      );
      await change(() => state.prepareThread());
      expect(state.context.phase).toBe("idle");
      expect(state.context.threadReady).toBe(false);
      expect(f.requests).toHaveLength(0);
    },
  );

  it("only an explicit click prepares one original Thread and obtains the usable CAS from GET", async () => {
    await render({ selectedThreadId: null });
    await phase("ready");
    expect(f.requests).toHaveLength(0);
    expect(state.context.threadReady).toBe(false);
    await change(() => state.prepareThread());
    await phase("ready");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body).toEqual({ title: null });
    expect(posts()[0].key).toMatch(/^plugin-generation-thread:/u);
    expect(state.context.thread).toEqual({
      threadId: "prepared-thread",
      revision: 23,
      provisional: true,
    });
    await change(() => state.prepareThread());
    await phase("ready");
    expect(posts()).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 409, 500])(
    "retains the exact sent creation intent after HTTP %s and refuses to switch to a newly selected Thread",
    async (status) => {
      let count = 0;
      f.setHandler((request) =>
        request.method === "POST" && ++count === 1
          ? taskContextError(status, "named_sent_unknown")
          : undefined,
      );
      await render({ selectedThreadId: null });
      await phase("ready");
      await change(() => state.prepareThread());
      await phase("uncertain");
      await render({ selectedThreadId: "thread-2" });
      await phase("uncertain");
      expect(state.context.thread).toBeNull();
      expect(f.requests.some((value) => value.path.endsWith("thread-2"))).toBe(
        false,
      );
      await change(() => state.prepareThread());
      await phase("ready");
      expect(posts()).toHaveLength(2);
      expect(posts()[1].body).toEqual(posts()[0].body);
      expect(posts()[1].key).toBe(posts()[0].key);
      // Once the original destination is confirmed, the caller's selected Thread may be read normally.
      expect(
        f.requests.some((value) => value.path.endsWith("prepared-thread")),
      ).toBe(true);
    },
  );

  it("keeps confirmed creation identity after a follow-up GET failure instead of creating another Thread", async () => {
    let reads = 0;
    f.setHandler((request) =>
      request.path.endsWith("prepared-thread") && ++reads === 1
        ? taskContextError(403, "named_read_denied")
        : undefined,
    );
    await render({ selectedThreadId: null });
    await phase("ready");
    await change(() => state.prepareThread());
    await phase("uncertain");
    await change(() => state.prepareThread());
    await phase("ready");
    expect(posts()).toHaveLength(1);
    expect(state.context.thread?.threadId).toBe("prepared-thread");
  });

  it("preserves a genuine late creation acknowledgement through StrictMode close and remount", async () => {
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.method === "POST" ? gate.promise : undefined,
    );
    await render({ selectedThreadId: null }, true);
    await phase("ready");
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
    });
    await act(async () => root.render(null));
    gate.resolve(
      taskContextJson({
        disposition: "committed",
        thread: taskContextThread("prepared-thread", 1),
      }),
    );
    await change(flush);
    await render({}, true);
    await phase("ready");
    expect(posts()).toHaveLength(1);
    expect(state.context.thread?.threadId).toBe("prepared-thread");
    expect(state.context.thread?.revision).toBe(23);
  });

  it("logical timeout preserves the physical acknowledgement and never allocates another creation key", async () => {
    await render({ selectedThreadId: null });
    await phase("ready");
    vi.useFakeTimers();
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.method === "POST" ? gate.promise : undefined,
    );
    await change(() => state.prepareThread());
    await change(flush);
    expect(posts()).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });
    expect(state.context.phase).toBe("uncertain");
    await change(() => state.prepareThread());
    expect(posts()).toHaveLength(1);
    gate.resolve(
      taskContextJson({
        disposition: "replayed",
        thread: taskContextThread("prepared-thread", 1),
      }),
    );
    await change(flush);
    vi.useRealTimers();
    await phase("ready");
    expect(posts()).toHaveLength(1);
    expect(state.context.thread?.threadId).toBe("prepared-thread");
  });

  it("an unresolved sent request survives remount and retries its original body and key after the physical failure", async () => {
    const gate = deferred<Response>();
    let count = 0;
    f.setHandler((request) =>
      request.method === "POST" && ++count === 1 ? gate.promise : undefined,
    );
    await render({ selectedThreadId: null });
    await phase("ready");
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
      root.render(null);
    });
    gate.resolve(taskContextError(409, "named_existing_key_unknown"));
    await change(flush);
    await render({
      module: generationContextModule(2),
      selectedThreadId: "thread-2",
    });
    await phase("uncertain");
    await change(() => state.prepareThread());
    await phase("ready");
    expect(posts()).toHaveLength(2);
    expect(posts()[1].key).toBe(posts()[0].key);
    expect(posts()[1].body).toEqual(posts()[0].body);
  });

  it("session invalidation discards the account owner and never rehydrates a late acknowledgement", async () => {
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.method === "POST" ? gate.promise : undefined,
    );
    await render({ selectedThreadId: null });
    await phase("ready");
    await change(() => state.prepareThread());
    await act(async () => {
      await vi.waitFor(() => expect(posts()).toHaveLength(1));
    });
    await change(() => {
      f.withdraw();
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    });
    gate.resolve(
      taskContextJson({
        disposition: "committed",
        thread: taskContextThread("prepared-thread", 1),
      }),
    );
    await change(flush);
    expect(state.context.phase).toBe("idle");
    expect(state.context.thread).toBeNull();
    expect(f.journal.snapshot()).toEqual([]);
    const next = generationContextFixture();
    await render({ ports: next.ports, selectedThreadId: null });
    await phase("ready");
    expect(state.context.thread).toBeNull();
    expect(next.requests).toHaveLength(0);
  });

  it.each(["pending", "uncertain"] as const)(
    "%s generation freezes the original Thread CAS across current revision and selection changes",
    async (status) => {
      if (status === "pending")
        f.journal.register({
          lease: generationContextLease(),
          input: generationContextRequest,
        });
      else await f.unknown();
      f.threads.set("thread-1", taskContextThread("thread-1", 99));
      await render({ selectedThreadId: "thread-2" });
      await phase(status === "pending" ? "preparing" : "uncertain");
      expect(state.context.thread).toEqual({
        threadId: "thread-1",
        revision: 17,
        provisional: false,
      });
      expect(state.context.threadReady).toBe(false);
      expect(state.context.intent?.request).toEqual(generationContextRequest);
      await change(() => state.prepareThread());
      expect(posts()).toHaveLength(0);
      expect(f.requests.every((value) => value.path.endsWith("thread-1"))).toBe(
        true,
      );
    },
  );

  it("a new source pin preserves the unknown hint and disables retries instead of replacing its input", async () => {
    await f.unknown();
    await render({ module: generationContextModule(2) });
    await phase("uncertain");
    expect(state.context.intent?.retryable).toBe(false);
    expect(state.context.intent?.request).toEqual(generationContextRequest);
    await change(() => state.refresh());
    await phase("uncertain");
    expect(posts()).toHaveLength(0);
  });

  it("a trusted pre-send refusal is only a non-retryable hint and never becomes a generation receipt", async () => {
    const abort = new AbortController();
    abort.abort();
    const send = vi.fn(async () => {
      throw new Error("must_not_send");
    });
    await f.journal
      .invoke({
        lease: generationContextLease(),
        input: generationContextRequest,
        signal: abort.signal,
        request: send,
      })
      .catch(() => undefined);
    await change(flush);
    await render();
    await phase("ready");
    expect(state.context.intent?.phase).toBe("refused");
    expect(state.context.intent?.retryable).toBe(false);
    expect(state.context.intent?.receipt).toBeNull();
    expect(state.canOpenTask).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("opens an accepted cross-plugin generation only after exact saved-source read verification and original runtime adoption", async () => {
    await f.accept();
    await render();
    await phase("ready");
    expect(state.canOpenTask).toBe(true);
    await change(() => state.openTask());
    expect(f.requests.at(-1)?.path).toBe(
      "/api/v1/creative-projects/project-1/concepts/asset-1/revisions/2/generation",
    );
    expect(
      f.requests.some((value) =>
        /extensions|tasks|runs|operation/u.test(value.path),
      ),
    ).toBe(false);
    expect(f.adopt).toHaveBeenCalledWith(
      { threadId: "thread-1", runId: "target-paid-run" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.open).toHaveBeenCalledWith("thread-1");
  });

  it.each(["null", "run", "thread", "configuration"] as const)(
    "keeps the accepted receipt but does not adopt a %s lookup mismatch",
    async (mismatch) => {
      await f.accept();
      const record = generationContextRecord();
      f.setRecord(
        mismatch === "null"
          ? { generation: null }
          : {
              generation: {
                ...record.generation!,
                task: {
                  ...record.generation!.task,
                  ...(mismatch === "run"
                    ? { runId: "other-run" }
                    : mismatch === "thread"
                      ? { threadId: "thread-2" }
                      : { configurationRevision: 4 }),
                },
              },
            },
      );
      await render();
      await phase("ready");
      await change(() => state.openTask());
      expect(f.adopt).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
      expect(state.error).toBe("plugin_generation_task_unavailable");
      expect(state.context.intent?.phase).toBe("accepted");
      expect(state.canOpenTask).toBe(true);
    },
  );

  it("closing during the authoritative lookup rejects late navigation without weakening accepted state", async () => {
    await f.accept();
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.path.endsWith("/generation") ? gate.promise : undefined,
    );
    await render();
    await phase("ready");
    let work!: Promise<void>;
    await change(() => {
      work = state.openTask();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          f.requests.some((value) => value.path.endsWith("/generation")),
        ).toBe(true),
      );
    });
    await render({ active: false });
    gate.resolve(taskContextJson(generationContextRecord()));
    await work;
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    await render({ active: true });
    await phase("ready");
    expect(state.context.intent?.phase).toBe("accepted");
  });

  it("same-account runtime reconnection uses current ports while retaining the accepted family receipt", async () => {
    await f.accept();
    await render();
    await phase("ready");
    const reconnect = vi.fn(async () => undefined),
      open = vi.fn();
    await render({
      module: generationContextModule(2),
      ports: {
        ...f.ports,
        runtime: { adoptExtensionTask: reconnect },
        onOpenTask: open,
      },
    });
    await phase("ready");
    await change(() => state.openTask());
    expect(f.adopt).not.toHaveBeenCalled();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("thread-1");
    expect(state.context.intent?.phase).toBe("accepted");
  });

  it("runtime replacement while adopting prevents the old runtime from navigating the new module", async () => {
    await f.accept();
    const gate = deferred<void>();
    f.adopt.mockImplementation(() => gate.promise);
    await render();
    await phase("ready");
    let work!: Promise<void>;
    await change(() => {
      work = state.openTask();
    });
    await act(async () => {
      await vi.waitFor(() => expect(f.adopt).toHaveBeenCalledTimes(1));
    });
    const next = vi.fn(async () => undefined),
      open = vi.fn();
    await render({
      ports: {
        ...f.ports,
        runtime: { adoptExtensionTask: next },
        onOpenTask: open,
      },
    });
    gate.resolve();
    await work;
    expect(f.open).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await phase("ready");
    await change(() => state.openTask());
    expect(next).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("thread-1");
  });
});
