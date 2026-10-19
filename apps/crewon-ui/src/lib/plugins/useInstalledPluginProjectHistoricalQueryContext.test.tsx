// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useInstalledPluginProjectHistoricalQueryContext,
  type InstalledPluginProjectHistoricalQueryContextState,
} from "./useInstalledPluginProjectHistoricalQueryContext";
import { publishControlThreadRevision } from "../control-runtime/controlThreadRevisionSubscriptions";
import { AGENT_PLATFORM_SESSION_CHANGED_EVENT } from "../agent-platform/agentPlatformClient";
import { deferred, flush } from "./pluginUiLoader.test-support";
import {
  taskContextError,
  taskContextJson,
  taskContextThread,
} from "./installedPluginTaskContext.test-support";
import {
  queryContextGeneration,
  queryContextTask,
} from "./installedPluginProjectQuery.test-support";
import { generationJournalInput } from "./installedPluginGenerationJournal.test-support";
import {
  historicalQueryContextFixture,
  historicalQueryContextLease,
  historicalQueryContextModule,
  historicalQueryInput,
  historicalQueryLease,
  historicalQueryReceipt,
} from "./installedPluginProjectHistoricalQuery.test-support";

type Input = Parameters<
  typeof useInstalledPluginProjectHistoricalQueryContext
>[0];
describe("installed project query host context", () => {
  let f: ReturnType<typeof historicalQueryContextFixture>,
    input: Input,
    state: InstalledPluginProjectHistoricalQueryContextState;
  let root: Root, container: HTMLDivElement;
  function Probe(props: Input) {
    state = useInstalledPluginProjectHistoricalQueryContext(props);
    return null;
  }
  async function render(patch: Partial<Input> = {}, strict = false) {
    input = { ...input, ...patch };
    await act(async () =>
      root.render(
        strict ? (
          <StrictMode>
            <Probe {...input} />
          </StrictMode>
        ) : (
          <Probe {...input} />
        ),
      ),
    );
  }
  async function change(action: () => void | Promise<void>) {
    await act(async () => {
      await action();
    });
  }
  async function phase(value: string) {
    await act(async () => {
      await vi.waitFor(() => expect(state.context.phase).toBe(value));
    });
  }
  beforeEach(() => {
    f = historicalQueryContextFixture();
    input = {
      ports: f.ports,
      module: historicalQueryContextModule(),
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

  it("reads the existing real Thread CAS without implicit creation, query or task-service grants", async () => {
    await render();
    await phase("ready");
    expect(state.context.thread).toEqual({
      threadId: "thread-1",
      revision: 17,
      provisional: false,
    });
    expect(state.context.threadReady).toBe(true);
    expect(state.context.recovery).toBe("session-only");
    expect(state.context.intent).toBeNull();
    expect(
      input.module.plugin.descriptor.requires.map((item) => item.service),
    ).not.toContain("crewon.tasks");
    expect(f.requests.map((item) => [item.method, item.path])).toEqual([
      ["GET", "/api/v1/threads/thread-1"],
    ]);
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("refreshes the canonical CAS after another lane completes, ignoring foreign threads and inactive views", async () => {
    await render();
    await phase("ready");
    f.threads.set("thread-1", taskContextThread("thread-1", 18));
    await change(() =>
      publishControlThreadRevision(f.ports.runtime, "thread-other"),
    );
    expect(state.context.thread?.revision).toBe(17);
    expect(f.requests).toHaveLength(1);
    await change(() =>
      publishControlThreadRevision(f.ports.runtime, "thread-1"),
    );
    await phase("ready");
    expect(state.context.thread?.revision).toBe(18);
    expect(f.requests.map((r) => [r.method, r.path])).toEqual([
      ["GET", "/api/v1/threads/thread-1"],
      ["GET", "/api/v1/threads/thread-1"],
    ]);
    expect(f.adopt).not.toHaveBeenCalled();
    await render({ active: false });
    await change(() =>
      publishControlThreadRevision(f.ports.runtime, "thread-1"),
    );
    expect(f.requests).toHaveLength(2);
  });

  it("ignores unrelated query families while retaining current-family refreshes", async () => {
    await render();
    await phase("ready");
    const ready = state.context;
    await change(() =>
      f.accept(
        historicalQueryInput(),
        historicalQueryLease("example.other-workbench"),
      ),
    );
    expect(state.context).toBe(ready);
    expect(f.requests).toHaveLength(1);
    expect(state.context.intent).toBeNull();

    f.threads.set("thread-1", taskContextThread("thread-1", 99));
    await change(() => f.accept());
    await phase("ready");
    expect(state.context.intent?.phase).toBe("accepted");
    expect(state.context.thread?.revision).toBe(99);
    expect(f.requests.length).toBeGreaterThan(1);
  });

  it("no selected or prepared Thread remains empty and never creates a conversation", async () => {
    await render({ selectedThreadId: null });
    await phase("ready");
    expect(state.context.thread).toBeNull();
    expect(state.context.threadReady).toBe(false);
    await change(() => state.refresh());
    await phase("ready");
    await change(() => state.openTask());
    expect(f.requests).toHaveLength(0);
  });

  it("an existing generation-prepared Thread is re-read and never treated as a new query creation", async () => {
    await render({ selectedThreadId: null, preparedThreadId: "thread-2" });
    await phase("ready");
    expect(state.context.thread).toEqual({
      threadId: "thread-2",
      revision: 41,
      provisional: false,
    });
    expect(f.requests.map((item) => [item.method, item.path])).toEqual([
      ["GET", "/api/v1/threads/thread-2"],
    ]);
    await render({ selectedThreadId: "thread-1" });
    await phase("ready");
    expect(state.context.thread?.threadId).toBe("thread-1");
    expect(f.requests.every((item) => item.method === "GET")).toBe(true);
  });

  it.each(["inactive", "noPorts", "missingService", "wrongVersion"] as const)(
    "%s performs no reads or adoption",
    async (mode) => {
      const module = historicalQueryContextModule();
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
                : [],
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
      expect(state.context.phase).toBe("idle");
      await change(() => {
        state.refresh();
      });
      await change(() => state.openTask());
      expect(f.requests).toHaveLength(0);
      expect(f.adopt).not.toHaveBeenCalled();
    },
  );

  it("explicit refresh obtains the current CAS rather than recycling an accepted receipt revision", async () => {
    await f.accept();
    await render();
    await phase("ready");
    expect(state.context.intent?.receipt?.threadRevision).toBe(18);
    f.threads.set("thread-1", taskContextThread("thread-1", 99));
    await change(() => state.refresh());
    await phase("ready");
    expect(state.context.thread?.revision).toBe(99);
    expect(state.context.intent?.request.expectedThreadRevision).toBe(17);
    expect(state.context.intent?.receipt?.threadRevision).toBe(18);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((item) => item.method === "GET")).toBe(true);
  });

  it.each(["pending", "uncertain"] as const)(
    "%s keeps the exact original query destination and body despite selection and current CAS changes",
    async (status) => {
      if (status === "pending")
        f.journal.register({
          lease: historicalQueryContextLease(),
          input: historicalQueryInput(),
        });
      else await f.unknown();
      f.threads.set("thread-1", taskContextThread("thread-1", 99));
      await render({
        selectedThreadId: "thread-2",
        preparedThreadId: "thread-2",
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(state.context.thread?.threadId).toBe("thread-1"),
        );
      });
      expect(state.context.phase).toBe(
        status === "pending" ? "loading" : "uncertain",
      );
      expect(state.context.threadReady).toBe(false);
      expect(state.context.intent?.request).toEqual(historicalQueryInput());
      expect(state.context.intent?.request.expectedThreadRevision).toBe(17);
      expect(
        f.requests.every(
          (item) => item.path.endsWith("thread-1") && item.method === "GET",
        ),
      ).toBe(true);
      expect(state.canOpenTask).toBe(false);
    },
  );

  it("a pending generation journal cannot freeze or replace this independent query context", async () => {
    f.generationJournal.register({
      lease: historicalQueryContextLease(),
      input: generationJournalInput(historicalQueryInput().idempotencyKey),
    });
    await render();
    await phase("ready");
    expect(state.context.intent).toBeNull();
    expect(state.context.threadReady).toBe(true);
    await change(() => f.unknown());
    await change(flush);
    expect(f.generationJournal.snapshot()[0].phase).toBe("pending");
    expect(f.generationJournal.snapshot()[0].input.idempotencyKey).toBe(
      historicalQueryInput().idempotencyKey,
    );
  });

  it("opens the query Run only through saved generation lookup and original execution plugin proof", async () => {
    await f.accept();
    await render();
    await phase("ready");
    expect(state.canOpenTask).toBe(true);
    await change(() => state.openTask());
    expect(f.requests.map((item) => item.path)).toEqual([
      "/api/v1/threads/thread-1",
      "/api/v1/creative-projects/project-1/concepts/asset-1/revisions/2/generation",
      "/api/v1/extensions/example.original-execution/tasks/target-query-run",
    ]);
    expect(
      f.requests.some((item) =>
        item.path.includes("extensions/example.business-workbench"),
      ),
    ).toBe(false);
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(f.adopt.mock.calls[0][0]).toEqual({
      threadId: "thread-1",
      runId: "target-query-run",
    });
    expect(f.open).toHaveBeenCalledWith("thread-1");
    expect(state.error).toBeNull();
  });

  it.each([
    "missingGeneration",
    "wrongSourceRun",
    "wrongThread",
    "wrongConfiguration",
    "wrongQueryRun",
  ] as const)("%s cannot be adopted or navigated", async (mode) => {
    await f.accept();
    if (mode === "missingGeneration") f.setRecord({ generation: null });
    else
      f.setTask({
        ...queryContextTask(),
        ...(mode === "wrongSourceRun"
          ? { sourceRunId: "unrelated-paid-run" }
          : mode === "wrongThread"
            ? { threadId: "thread-2" }
            : mode === "wrongConfiguration"
              ? { configurationRevision: 4 }
              : { runId: "unrelated-query-run" }),
      });
    await render();
    await phase("ready");
    await change(() => state.openTask());
    expect(state.error).toBe(
      "plugin_project_historical_query_task_unavailable",
    );
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("historical configuration is checked against both the accepted receipt and the original generation", async () => {
    await f.accept();
    const record = queryContextGeneration();
    f.setRecord({
      generation: {
        ...record.generation!,
        task: { ...record.generation!.task, configurationRevision: 4 },
      },
    });
    await render();
    await phase("ready");
    await change(() => state.openTask());
    expect(state.error).toBe(
      "plugin_project_historical_query_task_unavailable",
    );
    expect(f.adopt).not.toHaveBeenCalled();
  });

  it("a denied original source lookup never falls back to the business UI plugin or directly opens the claimed Run", async () => {
    await f.accept();
    f.setHandler((request) =>
      request.path.includes("/generation")
        ? taskContextError(403, "source-read-denied")
        : undefined,
    );
    await render();
    await phase("ready");
    await change(() => state.openTask());
    expect(f.requests).toHaveLength(2);
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });

  it("concurrent open clicks join one source read, query read and adoption", async () => {
    await f.accept();
    await render();
    await phase("ready");
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.path.endsWith("/generation") ? gate.promise : undefined,
    );
    const first = state.openTask(),
      second = state.openTask();
    await change(flush);
    expect(
      f.requests.filter((item) => item.path.endsWith("/generation")),
    ).toHaveLength(1);
    gate.resolve(taskContextJson(queryContextGeneration()));
    await change(() => Promise.all([first, second]).then(() => undefined));
    expect(f.adopt).toHaveBeenCalledTimes(1);
    expect(f.open).toHaveBeenCalledTimes(1);
  });

  it("changed full module pin withholds retry and adoption while retaining the original saved receipt", async () => {
    await f.unknown();
    await render({ module: historicalQueryContextModule(2) });
    await phase("uncertain");
    expect(state.context.intent?.retryable).toBe(false);
    expect(state.context.intent?.request).toEqual(historicalQueryInput());
    expect(state.canOpenTask).toBe(false);
    const next = historicalQueryContextFixture();
    await next.accept();
    await render({
      ports: next.ports,
      module: historicalQueryContextModule(2),
    });
    await phase("ready");
    await change(() => state.openTask());
    expect(next.adopt).not.toHaveBeenCalled();
    expect(next.journal.snapshot()[0].receipt).toEqual(
      historicalQueryReceipt(),
    );
    expect(
      next.requests.every((item) => item.path.startsWith("/api/v1/threads/")),
    ).toBe(true);
  });

  it.each([
    "inactive",
    "pinChanged",
    "selectedThreadChanged",
    "preparedThreadChanged",
  ] as const)(
    "%s during source lookup cancels old navigation",
    async (mode) => {
      await f.accept();
      await render();
      await phase("ready");
      const gate = deferred<Response>();
      f.setHandler((request) =>
        request.path.endsWith("/generation") ? gate.promise : undefined,
      );
      const pending = state.openTask();
      await change(flush);
      await render(
        mode === "inactive"
          ? { active: false }
          : mode === "pinChanged"
            ? { module: historicalQueryContextModule(2) }
            : mode === "selectedThreadChanged"
              ? { selectedThreadId: "thread-2" }
              : { preparedThreadId: "thread-2" },
      );
      gate.resolve(taskContextJson(queryContextGeneration()));
      await change(() => pending);
      expect(f.adopt).not.toHaveBeenCalled();
      expect(f.open).not.toHaveBeenCalled();
    },
  );

  it("session event alone invalidates account ownership and ignores an old source acknowledgement", async () => {
    await f.accept();
    await render();
    await phase("ready");
    const gate = deferred<Response>();
    f.setHandler((request) =>
      request.path.endsWith("/generation") ? gate.promise : undefined,
    );
    const pending = state.openTask();
    await change(flush);
    await change(() => {
      window.dispatchEvent(new Event(AGENT_PLATFORM_SESSION_CHANGED_EVENT));
    });
    expect(state.context.phase).toBe("idle");
    expect(state.context.thread).toBeNull();
    expect(f.journal.snapshot()).toEqual([]);
    gate.resolve(taskContextJson(queryContextGeneration()));
    await change(() => pending);
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    const count = f.requests.length;
    await change(() => state.refresh());
    await change(() => state.openTask());
    expect(f.requests).toHaveLength(count);
    const next = historicalQueryContextFixture();
    await render({ ports: next.ports, selectedThreadId: null });
    await phase("ready");
    expect(state.context.intent).toBeNull();
    expect(state.context.thread).toBeNull();
    expect(next.requests).toHaveLength(0);
  });

  it("an invalidated journal or asynchronous session guard cannot publish a usable Thread CAS", async () => {
    f.journal.invalidate();
    await render();
    await change(flush);
    expect(state.context.threadReady).toBe(false);
    expect(f.requests).toHaveLength(0);
    const next = historicalQueryContextFixture();
    const ports = {
      ...next.ports,
      assertSessionCurrent: (() => Promise.resolve()) as unknown as () => void,
    };
    await render({ ports });
    await change(flush);
    expect(state.context.threadReady).toBe(false);
    expect(next.requests).toHaveLength(0);
  });

  it("an invalid thread response cannot supply a query CAS", async () => {
    f.setHandler((request) =>
      request.path.endsWith("thread-1")
        ? taskContextJson({
            thread: taskContextThread("thread-1", 17),
            eventSequence: 18,
          })
        : undefined,
    );
    await render();
    await phase("error");
    expect(state.context.threadReady).toBe(false);
    expect(state.context.thread).toBeNull();
  });

  it("StrictMode close and same-pin remount retain a genuine physical late query acknowledgement", async () => {
    const gate = deferred<{
        output: ReturnType<typeof historicalQueryReceipt>;
      }>(),
      caller = new AbortController();
    const request = vi.fn(() => gate.promise);
    const pending = f.journal.invoke({
      lease: historicalQueryContextLease(),
      input: historicalQueryInput(),
      signal: caller.signal,
      request,
    });
    const rejected = expect(pending).rejects.toThrow(
      "plugin_ui_operation_aborted",
    );
    await render({}, true);
    await change(flush);
    await change(() => {
      root.render(null);
      caller.abort();
    });
    await rejected;
    gate.resolve({ output: historicalQueryReceipt() });
    await change(flush);
    await render({ module: historicalQueryContextModule(1, 2) }, true);
    await phase("ready");
    expect(state.context.intent?.phase).toBe("accepted");
    expect(state.context.intent?.receipt).toEqual(historicalQueryReceipt());
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.requests.every((item) => item.method === "GET")).toBe(true);
  });
});
