// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlApiClientError } from "@crewon/control-client";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { GetExtensionConfigurationResponse } from "@crewon/contracts";
import { BusinessExtensionController } from "./BusinessExtensionController";
import {
  BusinessExtensionPanel,
  type BusinessExtensionPanelProps,
} from "./BusinessExtensionPanel";
import { useBusinessExtension } from "./useBusinessExtension";
import {
  activation,
  client,
  configuration,
  deferred,
  entry,
  task,
  thread,
  timestamp,
} from "./businessExtension.test-support";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let container: HTMLDivElement;
let panel: Omit<
  BusinessExtensionPanelProps,
  "title" | "description" | "onOpenRun"
>;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
});
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function setup() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}
function harness(
  api = client(),
  options: { thread?: Thread | null; open?: boolean } = {},
) {
  setup();
  const runtime = {
    adoptExtensionTask: vi.fn(
      async (
        _receipt: Readonly<{ threadId: string; runId: string }>,
        _options?: Readonly<{ signal?: AbortSignal }>,
      ) => {},
    ),
  };
  const onCommitted = vi.fn();
  let currentApi = api;
  let currentThread = options.thread === undefined ? thread() : options.thread;
  let open = options.open ?? true;
  function Harness() {
    panel = useBusinessExtension({
      client: currentApi,
      runtime,
      entry,
      locale: "en",
      open,
      thread: currentThread,
      onCommitted,
    });
    return (
      <BusinessExtensionPanel
        {...panel}
        title={entry.title}
        description={entry.description}
      />
    );
  }
  return {
    api,
    runtime,
    onCommitted,
    async render(
      patch: {
        thread?: Thread | null;
        open?: boolean;
        client?: typeof api;
      } = {},
    ) {
      if ("thread" in patch) currentThread = patch.thread ?? null;
      if ("open" in patch) open = patch.open ?? false;
      if ("client" in patch) currentApi = patch.client!;
      await act(async () => {
        root!.render(<Harness />);
        await settle();
      });
    },
  };
}
async function change(callback: () => void) {
  await act(async () => {
    callback();
    await settle();
  });
}
async function generateThroughForm() {
  await change(() => {
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, "A ceramic teapot");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await change(() =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Generate image")!
      .click(),
  );
}
function error(status: number, code: string) {
  return new ControlApiClientError({
    status,
    code,
    category:
      status === 403
        ? "authorization"
        : status === 404
          ? "notFound"
          : "conflict",
    requestId: "fixture-request",
  });
}

describe("business extension entry and real client orchestration", () => {
  it("hides the entry when the disabled host returns the original 404", async () => {
    setup();
    const api = client();
    api.listExtensions.mockRejectedValue(error(404, "route_not_found"));
    await act(async () => {
      root!.render(
        <BusinessExtensionController
          client={api}
          runtime={{ adoptExtensionTask: vi.fn() }}
          thread={thread()}
          locale="en"
          onOpenThread={vi.fn()}
        />,
      );
      await settle();
    });
    expect(container.textContent).toBe("");
    expect(api.getExtensionConfiguration).not.toHaveBeenCalled();
  });
  it("hides an incompatible schema rather than guessing a form", async () => {
    setup();
    const api = client();
    api.listExtensions.mockResolvedValue({
      extensions: [
        {
          ...entry,
          configurationSchema: {
            ...entry.configurationSchema,
            required: ["baseUrl", "token"],
          },
        },
      ],
    });
    await act(async () => {
      root!.render(
        <BusinessExtensionController
          client={api}
          runtime={{ adoptExtensionTask: vi.fn() }}
          thread={thread()}
          locale="en"
          onOpenThread={vi.fn()}
        />,
      );
      await settle();
    });
    expect(container.textContent).toBe("");
  });
  it("shows the real catalog entry and opens the supported configuration", async () => {
    setup();
    const api = client();
    await act(async () => {
      root!.render(
        <BusinessExtensionController
          client={api}
          runtime={{ adoptExtensionTask: vi.fn() }}
          thread={thread()}
          locale="en"
          onOpenThread={vi.fn()}
        />,
      );
      await settle();
    });
    expect(container.textContent).toBe("Business plugins");
    await change(() => container.querySelector("button")!.click());
    expect(
      container.querySelector('input[type="url"]')?.getAttribute("value"),
    ).toBe(configuration.parameters.baseUrl);
    expect(container.textContent).toContain("Saved · revision 1");
  });
  it("returns focus to the business entry after Escape closes the dialog", async () => {
    setup();
    const api = client();
    await act(async () => {
      root!.render(
        <BusinessExtensionController
          client={api}
          runtime={{ adoptExtensionTask: vi.fn() }}
          thread={thread()}
          locale="en"
          onOpenThread={vi.fn()}
        />,
      );
      await settle();
    });
    const trigger = container.querySelector("button")!;
    await change(() => {
      trigger.focus();
      trigger.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await change(() =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await act(async () => {
      await settle();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves the task's focus when closing to open an accepted query Run", async () => {
    setup();
    const api = client();
    const operation = {
      sourceRunId: "generation-run",
      operationId: "11111111-1111-1111-1111-111111111111",
      status: "unknownOutcome" as const,
      observedAt: timestamp,
      images: [],
    };
    api.getExtensionTask.mockResolvedValue({
      task: task({ operations: [operation] }),
    });
    const existing = {
      ...thread(),
      turns: [
        {
          id: "image-run",
          status: "completed" as const,
          items: [],
          error: null,
          itemsView: "full" as const,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    const taskFocus = document.createElement("button");
    document.body.append(taskFocus);
    try {
      await act(async () => {
        root!.render(
          <BusinessExtensionController
            client={api}
            runtime={{ adoptExtensionTask: vi.fn(async () => {}) }}
            thread={existing}
            locale="en"
            onOpenThread={() => taskFocus.focus()}
          />,
        );
        await settle();
      });
      await change(() => container.querySelector("button")!.click());
      await change(() =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === "Query source task result")!
          .click(),
      );
      await act(async () => {
        await settle();
      });
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(taskFocus);
    } finally {
      taskFocus.remove();
    }
  });

  it("requires explicit selection and exact readiness before enabling, including for the default candidate", async () => {
    const api = client();
    api.getExtensionActivation.mockResolvedValue({
      activation: { ...activation, state: "disabled", target: null },
    });
    api.getExtensionRuntime.mockImplementation(async (_id, query) => ({
      pluginId: entry.pluginId,
      ...query,
      readiness:
        query.agentVersionId === "default-agent"
          ? {
              outcome: "unavailable",
              reasonCode: "extension_runtime_unavailable",
            }
          : { outcome: "ready", target: activation.target! },
    }));
    const view = harness(api);
    await view.render();
    expect(panel.selectedAgentVersionId).toBeNull();
    expect(api.getExtensionRuntime).not.toHaveBeenCalled();
    await change(() => panel.onEnable("default-agent"));
    expect(api.setExtensionActivation).not.toHaveBeenCalled();
    await change(() => panel.onAgentVersionChange("default-agent"));
    expect(panel.selectedAgentReady).toBe(false);
    await change(() => panel.onEnable("default-agent"));
    expect(api.setExtensionActivation).not.toHaveBeenCalled();
    await change(() => panel.onAgentVersionChange("image-agent"));
    expect(panel.selectedAgentReady).toBe(true);
    await change(() => panel.onEnable("image-agent"));
    expect(api.setExtensionActivation).toHaveBeenCalledWith(
      entry.pluginId,
      {
        state: "enabled",
        expectedRevision: 1,
        configurationRevision: 1,
        agentVersionId: "image-agent",
      },
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("saves a new revision without enabling it and checks that revision's runtime", async () => {
    const view = harness();
    await view.render();
    await change(() => panel.onBaseUrlChange("https://other.example.com/"));
    await change(() => panel.onEnable("image-agent"));
    expect(view.api.setExtensionActivation).not.toHaveBeenCalled();
    await change(() => panel.onSave());
    expect(panel.configuration?.revision).toBe(2);
    expect(view.api.setExtensionActivation).not.toHaveBeenCalled();
    expect(view.api.getExtensionRuntime).toHaveBeenLastCalledWith(
      entry.pluginId,
      { agentVersionId: "image-agent", configurationRevision: 2 },
      expect.any(Object),
    );
  });
  it("uses the existing Thread's current revision and adopts the accepted Run through the shared runtime", async () => {
    const view = harness();
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    expect(view.api.createThread).not.toHaveBeenCalled();
    expect(view.api.createExtensionTask).toHaveBeenCalledWith(
      entry.pluginId,
      {
        threadId: "thread-1",
        expectedThreadRevision: 3,
        intent: { kind: "generate", input: { prompt: "A ceramic teapot" } },
      },
      expect.any(String),
      expect.any(Object),
    );
    expect(view.runtime.adoptExtensionTask).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", runId: "image-run" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(view.onCommitted).toHaveBeenCalledWith("thread-1");
  });
  it("creates a Thread only when none is selected", async () => {
    const view = harness(client(), { thread: null });
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    expect(view.api.createThread).toHaveBeenCalledTimes(1);
    expect(view.onCommitted).toHaveBeenCalledWith("thread-1");
  });
  it("preserves a verified new Thread handoff while Runtime adoption is still pending", async () => {
    const view = harness(client(), { thread: null }),
      gate = deferred<void>();
    view.runtime.adoptExtensionTask.mockReturnValueOnce(gate.promise);
    await view.render();
    await generateThroughForm();
    const signal = view.runtime.adoptExtensionTask.mock.calls[0]![1]!.signal!;
    await view.render({ thread: thread("thread-1") });
    expect(signal.aborted).toBe(false);
    expect(panel.busy).toBe("generating");
    expect(view.onCommitted).not.toHaveBeenCalled();
    await change(() => gate.resolve(undefined));
    expect(view.onCommitted).toHaveBeenCalledExactlyOnceWith("thread-1");
    expect(panel.pendingTask).toBeNull();
    expect(view.api.createExtensionTask).toHaveBeenCalledTimes(1);
  });
  it("does not exempt a receipt Thread transition before its task read is verified", async () => {
    const api = client(),
      gate = deferred<Awaited<ReturnType<typeof api.getExtensionTask>>>();
    api.getExtensionTask.mockReturnValueOnce(gate.promise);
    const view = harness(api, { thread: null });
    await view.render();
    await generateThroughForm();
    const signal = api.createExtensionTask.mock.calls[0]![3]!.signal!;
    await view.render({ thread: thread("thread-1") });
    expect(signal.aborted).toBe(true);
    await change(() => gate.resolve({ task: task() }));
    expect(view.runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(view.onCommitted).not.toHaveBeenCalled();
  });
  it.each(["other Thread", "client", "close", "unmount"] as const)(
    "cancels a verified handoff after %s",
    async (transition) => {
      const view = harness(client(), { thread: null }),
        gate = deferred<void>();
      view.runtime.adoptExtensionTask.mockReturnValueOnce(gate.promise);
      await view.render();
      await generateThroughForm();
      const signal = view.runtime.adoptExtensionTask.mock.calls[0]![1]!.signal!;
      await view.render({ thread: thread("thread-1") });
      expect(signal.aborted).toBe(false);
      if (transition === "other Thread")
        await view.render({ thread: thread("thread-2") });
      else if (transition === "client") await view.render({ client: client() });
      else if (transition === "close") await view.render({ open: false });
      else {
        await act(async () => root!.unmount());
        root = null;
      }
      expect(signal.aborted).toBe(true);
      await change(() => gate.resolve(undefined));
      expect(view.onCommitted).not.toHaveBeenCalled();
    },
  );
  it("retains the accepted receipt after an early Thread handoff and failed adoption", async () => {
    const view = harness(client(), { thread: null }),
      gate = deferred<void>();
    view.runtime.adoptExtensionTask.mockReturnValueOnce(gate.promise);
    await view.render();
    await generateThroughForm();
    await view.render({ thread: thread("thread-1") });
    await change(() => gate.reject(new TypeError("transcript unavailable")));
    expect(panel.pendingTask).toBe("resumeAccepted");
    await change(() =>
      [...container.querySelectorAll("button")]
        .find(
          (button) => button.textContent?.trim() === "Resume submitted task",
        )!
        .click(),
    );
    expect(view.api.createThread).toHaveBeenCalledTimes(1);
    expect(view.api.createExtensionTask).toHaveBeenCalledTimes(1);
    expect(view.runtime.adoptExtensionTask).toHaveBeenCalledTimes(2);
    expect(view.onCommitted).toHaveBeenCalledExactlyOnceWith("thread-1");
  });
  it("rejects a receipt and task that agree on a Thread different from the submitted request", async () => {
    const api = client();
    api.createExtensionTask.mockImplementationOnce(async (_plugin, body) => ({
      disposition: "committed",
      threadId: "thread-2",
      threadRevision: body.expectedThreadRevision + 1,
      runId: "image-run",
      messageId: "message-1",
      configurationRevision: 1,
    }));
    api.getExtensionTask.mockResolvedValue({
      task: task({ threadId: "thread-2" }),
    });
    const view = harness(api, { thread: null });
    await view.render();
    await generateThroughForm();
    expect(view.runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(view.onCommitted).not.toHaveBeenCalled();
  });
  it("surfaces an active-Run conflict without switching to a new Thread", async () => {
    const api = client();
    api.createExtensionTask.mockRejectedValue(
      error(409, "thread_active_run_conflict"),
    );
    const view = harness(api);
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    expect(panel.error).toContain("unfinished work");
    expect(api.createThread).not.toHaveBeenCalled();
    expect(view.runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(panel.pendingTask).toBeNull();
  });
  it("retries an uncertain submission with the same frozen request and idempotency key after close/reopen", async () => {
    const api = client();
    api.createExtensionTask.mockRejectedValueOnce(
      new TypeError("network response lost"),
    );
    const view = harness(api);
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    const first = api.createExtensionTask.mock.calls[0]!;
    expect(panel.pendingTask).toBe("retrySubmission");
    await view.render({ open: false });
    await view.render({ open: true });
    expect(panel.pendingTask).toBe("retrySubmission");
    await change(() => panel.onGenerate());
    expect(api.createExtensionTask.mock.calls[1]!.slice(0, 3)).toEqual(
      first.slice(0, 3),
    );
    expect(api.getThread).toHaveBeenCalledTimes(1);
    expect(view.onCommitted).toHaveBeenCalledTimes(1);
  });
  it("resumes an accepted Run after adoption fails without a second task mutation", async () => {
    const view = harness();
    view.runtime.adoptExtensionTask.mockRejectedValueOnce(
      new TypeError("transcript unavailable"),
    );
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    expect(panel.pendingTask).toBe("resumeAccepted");
    await change(() => panel.onGenerate());
    expect(view.api.createExtensionTask).toHaveBeenCalledTimes(1);
    expect(view.runtime.adoptExtensionTask).toHaveBeenCalledTimes(2);
    expect(view.onCommitted).toHaveBeenCalledTimes(1);
  });
  it("does not adopt a task whose authoritative Thread differs from its receipt", async () => {
    const api = client();
    api.getExtensionTask.mockResolvedValue({
      task: task({ threadId: "other-thread" }),
    });
    const view = harness(api);
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    expect(view.runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(panel.pendingTask).toBe("resumeAccepted");
  });
  it("queries an operation using its original owner and treats refresh as a read", async () => {
    const operation = {
      operationId: "11111111-1111-1111-1111-111111111111",
      sourceRunId: "generation-run",
      status: "unknownOutcome" as const,
      observedAt: timestamp,
      images: [],
    };
    const api = client();
    api.getExtensionTask.mockResolvedValue({
      task: task({
        runId: "query-run",
        sourceRunId: "generation-run",
        operations: [operation],
      }),
    });
    const existing = {
      ...thread(),
      turns: [
        {
          id: "query-run",
          status: "completed" as const,
          items: [],
          error: null,
          itemsView: "full" as const,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    const view = harness(api, { thread: existing });
    await view.render();
    await change(() => panel.onRefresh());
    expect(api.createExtensionTask).not.toHaveBeenCalled();
    expect(api.getExtensionTask).toHaveBeenCalledTimes(2);
    await change(() =>
      panel.onQuery({
        sourceRunId: operation.sourceRunId,
        operationId: operation.operationId,
      }),
    );
    expect(api.createExtensionTask).toHaveBeenCalledWith(
      entry.pluginId,
      expect.objectContaining({
        intent: {
          kind: "query",
          sourceRunId: "generation-run",
          operationId: operation.operationId,
        },
      }),
      expect.any(String),
      expect.any(Object),
    );
  });
  it("freezes a query before its Thread preflight so recovery cannot become generation", async () => {
    const operation = {
      operationId: "11111111-1111-1111-1111-111111111111",
      sourceRunId: "generation-run",
      status: "unknownOutcome" as const,
      observedAt: timestamp,
      images: [],
    };
    const api = client();
    api.getExtensionTask.mockResolvedValue({
      task: task({ operations: [operation] }),
    });
    api.getThread.mockRejectedValueOnce(new TypeError("Thread response lost"));
    const existing = {
      ...thread(),
      turns: [
        {
          id: "image-run",
          status: "completed" as const,
          items: [],
          error: null,
          itemsView: "full" as const,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    const view = harness(api, { thread: existing });
    await view.render();
    await change(() => panel.onPromptChange("A completely new scene"));
    await change(() =>
      panel.onQuery({
        sourceRunId: operation.sourceRunId,
        operationId: operation.operationId,
      }),
    );
    expect(panel.pendingTask).toBe("retrySubmission");
    expect(api.createExtensionTask).not.toHaveBeenCalled();
    await change(() => panel.onGenerate());
    expect(api.createExtensionTask).toHaveBeenCalledWith(
      entry.pluginId,
      expect.objectContaining({
        intent: {
          kind: "query",
          sourceRunId: "generation-run",
          operationId: operation.operationId,
        },
      }),
      expect.any(String),
      expect.any(Object),
    );
    expect(view.onCommitted).toHaveBeenCalledTimes(1);
  });

  it("refreshes cached task results when the existing Run settles through SSE", async () => {
    const existing = {
      ...thread(),
      turns: [
        {
          id: "image-run",
          status: "inProgress" as const,
          items: [],
          error: null,
          itemsView: "full" as const,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    const view = harness(client(), { thread: existing });
    await view.render();
    view.api.getExtensionTask.mockResolvedValue({
      task: task({ runStatus: "completed" }),
    });
    await view.render({
      thread: {
        ...existing,
        turns: [{ ...existing.turns[0]!, status: "completed" }],
      },
    });
    expect(view.api.getExtensionTask).toHaveBeenCalledTimes(2);
    expect(panel.tasks[0]?.runStatus).toBe("completed");
  });
  it("clears stale results when the authoritative read is denied", async () => {
    const existing = {
      ...thread(),
      turns: [
        {
          id: "image-run",
          status: "completed" as const,
          items: [],
          error: null,
          itemsView: "full" as const,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    const view = harness(client(), { thread: existing });
    await view.render();
    expect(panel.tasks).toHaveLength(1);
    view.api.getExtensionTask.mockRejectedValue(
      error(403, "extension_forbidden"),
    );
    await change(() => panel.onRefresh());
    expect(panel.tasks).toHaveLength(0);
    expect(panel.error).toContain("not authorized");
  });
  it("aborts and discards an old configuration read when the Thread scope changes", async () => {
    const api = client(),
      old = deferred<GetExtensionConfigurationResponse>();
    api.getExtensionConfiguration.mockReturnValueOnce(old.promise);
    const view = harness(api);
    await view.render();
    const oldSignal = api.getExtensionConfiguration.mock.calls[0]![2]!.signal!;
    await view.render({ thread: thread("thread-2") });
    expect(oldSignal.aborted).toBe(true);
    await change(() =>
      old.resolve({ configuration: { ...configuration, revision: 99 } }),
    );
    expect(panel.configuration?.revision).toBe(1);
    expect(panel.tasks).toHaveLength(0);
  });
  it("aborts an in-flight task and rejects late adoption after switching Thread", async () => {
    const api = client(),
      late = deferred<Awaited<ReturnType<typeof api.createExtensionTask>>>();
    api.createExtensionTask.mockReturnValueOnce(late.promise);
    const view = harness(api);
    await view.render();
    await change(() => panel.onPromptChange("A ceramic teapot"));
    await change(() => panel.onGenerate());
    const signal = api.createExtensionTask.mock.calls[0]![3]!.signal!;
    await view.render({ thread: thread("thread-2") });
    expect(signal.aborted).toBe(true);
    await change(() =>
      late.resolve({
        disposition: "committed",
        threadId: "thread-1",
        threadRevision: 4,
        runId: "image-run",
        messageId: "message-1",
        configurationRevision: 1,
      }),
    );
    expect(view.runtime.adoptExtensionTask).not.toHaveBeenCalled();
    expect(view.onCommitted).not.toHaveBeenCalled();
    expect(panel.pendingTask).toBeNull();
  });
});
