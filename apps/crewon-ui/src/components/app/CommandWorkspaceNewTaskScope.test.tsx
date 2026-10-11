// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detailThread } from "../../lib/thread/threadDetailCache.test-support";
import { CommandWorkspace } from "./CommandWorkspace";
import {
  emptyAgentPlatformSnapshot,
  readThreadExecutionTarget,
  readThreadScene,
  writeThreadExecutionTarget,
  writeThreadScene,
} from "./commandWorkspaceState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type WorkspaceProps = ComponentProps<typeof CommandWorkspace>;
const noop = () => undefined;
const loadSnapshot = async () => emptyAgentPlatformSnapshot;
const base: WorkspaceProps = {
  composerValue: "",
  connectionState: "connected",
  cwd: "",
  isSending: false,
  locale: "zh",
  platform: "web",
  platformSnapshotLoader: loadSnapshot,
  workMode: "office",
  workspaceAuthority: "control",
  onAttachContext: noop,
  onChangeComposerValue: noop,
  onModeChange: noop,
  onRetryConnection: noop,
  onSend: noop,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T12:00:00+08:00"));
  window.history.replaceState(null, "", "/?surface=web#view-command");
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.classList.remove("modal-open");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(props: Partial<WorkspaceProps>) {
  await act(async () => root.render(<CommandWorkspace {...base} {...props} />));
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () =>
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}

function commandComposer() {
  return container.querySelector<HTMLFormElement>(
    '[data-od-id="shell-view-command"] form[data-command-composer]',
  )!;
}

function runningThread() {
  const thread = detailThread("background-thread", "已经输出的正文");
  thread.status = { type: "active", activeFlags: [] };
  thread.turns[0]!.status = "inProgress";
  thread.turns[0]!.completedAt = null;
  thread.turns[0]!.durationMs = null;
  return thread;
}

function selectedRunningProps(): Partial<WorkspaceProps> {
  const thread = runningThread();
  return {
    activeTurnId: thread.turns[0]!.id,
    backgroundRunActive: true,
    linkedThreads: [thread],
    selectedThread: thread,
    selectedThreadId: thread.id,
  };
}

describe("CommandWorkspace new-task execution scope", () => {
  it("keeps a retained background Run out of a blank draft and restores it when selected", async () => {
    const props = selectedRunningProps();
    const preservedThread = structuredClone(props.selectedThread);
    const stop = vi.fn();
    const select = vi.fn();
    await render({ ...props, onStop: stop, onSelectLinkedThread: select });
    expect(
      commandComposer().querySelector('[data-action="stop"]'),
    ).not.toBeNull();

    await click(container.querySelector('[data-action="new-task"]'));
    expect(select).toHaveBeenCalledWith(null);
    // The parent intentionally retains the original Thread/Run. A draft must
    // derive its own execution scope rather than relying on a parent refresh.
    await render({ ...props, onStop: stop, onSelectLinkedThread: select });
    expect(container.querySelector(".home-title")?.textContent).toContain(
      "让 CrewON 完成你的工作",
    );
    expect(commandComposer().querySelector('[data-action="stop"]')).toBeNull();
    expect(commandComposer().textContent).not.toContain("Agent 正在执行");
    const start = commandComposer().querySelector<HTMLButtonElement>(
      '[data-action="send"]',
    )!;
    expect(start.getAttribute("aria-label")).toBe("开始任务");
    expect(start.disabled).toBe(true);
    await click(start);
    expect(stop).not.toHaveBeenCalled();
    expect(props.selectedThread).toEqual(preservedThread);

    await click(
      container.querySelector('[data-linked-thread-id="background-thread"]'),
    );
    expect(select).toHaveBeenLastCalledWith("background-thread");
    expect(
      commandComposer().querySelector('[data-action="stop"]'),
    ).not.toBeNull();
    expect(props.selectedThread).toEqual(preservedThread);
  });

  it("hides the previous Run's approvals and changes in a draft and restores them on return", async () => {
    const props = selectedRunningProps();
    const approval = {
      approvalId: "background-approval",
      threadId: "background-thread",
      runId: props.activeTurnId!,
      toolName: "workspace_run_command",
      busy: false,
    };
    const decide = vi.fn();
    const renderProps = {
      ...props,
      toolApproval: approval,
      onToolApprovalDecision: decide,
      taskChanges: { additions: 5, deletions: 1, files: 2 },
    };
    await render(renderProps);
    const pane = () => container.querySelector('[data-shell-view="command"]')!;
    expect(
      pane().querySelector('[data-od-id="composer-tool-approval"]'),
    ).not.toBeNull();
    expect(
      pane().querySelector('[data-od-id="composer-progress-pill"]'),
    ).not.toBeNull();
    await click(container.querySelector('[data-action="new-task"]'));
    await render(renderProps);
    expect(
      pane().querySelector('[data-od-id="composer-tool-approval"]'),
    ).toBeNull();
    expect(
      pane().querySelector('[data-od-id="composer-progress-pill"]'),
    ).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    await click(
      container.querySelector('[data-linked-thread-id="background-thread"]'),
    );
    expect(
      pane().querySelector('[data-od-id="composer-tool-approval"]'),
    ).not.toBeNull();
    expect(
      pane().querySelector('[data-od-id="composer-progress-pill"]'),
    ).not.toBeNull();
    expect(props.selectedThread?.turns[0]?.status).toBe("inProgress");
  });

  it("keeps a new draft's execution-target selection out of the retained Thread binding", async () => {
    const props = selectedRunningProps();
    const officeControlClient: NonNullable<
      WorkspaceProps["officeControlClient"]
    > = {
      createOffice: async () => {
        throw new Error("not used");
      },
      getOffice: async () => {
        throw new Error("not used");
      },
      listOffices: async () => ({ data: [], nextCursor: null }),
      getActiveAgentVersionCatalog: async () => ({
        releaseId: "fixture-release",
        activatedAt: "2026-10-10T00:00:00.000Z",
        defaultAgentVersionId: "background-agent",
        data: ["background-agent", "draft-agent"].map((agentVersionId) => ({
          agentVersionId,
          contentDigest: `sha256:${"a".repeat(64)}`,
          runtimeGeneration: "fixture-runtime",
          policySnapshotId: "fixture-policy",
          model: {
            adapterName: "responses",
            adapterVersion: "v1",
            modelId: "gpt-6.1-sol",
          },
          createdAt: "2026-10-10T00:00:00.000Z",
        })),
      }),
    };
    writeThreadExecutionTarget(
      window.localStorage,
      "background-thread",
      "agent:background-agent",
    );
    const sendNew = vi.fn();
    const renderProps = {
      ...props,
      platform: "mac" as const,
      officeControlClient,
      onSendNewThread: sendNew,
    };
    await render(renderProps);
    expect(
      readThreadExecutionTarget(window.localStorage, "background-thread"),
    ).toBe("agent:background-agent");
    await click(container.querySelector('[data-action="new-task"]'));
    await render(renderProps);
    const trigger = commandComposer().querySelector(
      '[role="combobox"][aria-label="执行主体"]',
    )!;
    expect(trigger).not.toBeNull();
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    await click(
      document.querySelector('[role="option"][data-value="agent:draft-agent"]'),
    );
    expect(
      readThreadExecutionTarget(window.localStorage, "background-thread"),
    ).toBe("agent:background-agent");
    expect(window.location.search).not.toContain("executionTargetThread");
    expect(props.selectedThread?.turns[0]?.status).toBe("inProgress");
    await render({ ...renderProps, composerValue: "新草稿按所选智能体执行" });
    await act(async () =>
      commandComposer().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(sendNew).toHaveBeenCalledExactlyOnceWith(
      "新草稿按所选智能体执行",
      expect.objectContaining({
        scene: {
          sceneId: "office",
          mode: "auto",
          executionTarget: { kind: "agent", id: "draft-agent" },
        },
      }),
      null,
    );
    expect(
      readThreadExecutionTarget(window.localStorage, "background-thread"),
    ).toBe("agent:background-agent");
  });

  it("starts a new Thread while the previous Run is retained and still running", async () => {
    const props = selectedRunningProps();
    const preservedThread = structuredClone(props.selectedThread);
    const sendExisting = vi.fn();
    const sendNew = vi.fn();
    const stop = vi.fn();
    await render({
      ...props,
      onSend: sendExisting,
      onSendNewThread: sendNew,
      onStop: stop,
    });
    await click(container.querySelector('[data-action="new-task"]'));
    await render({
      ...props,
      composerValue: "独立的新会话请求",
      onSend: sendExisting,
      onSendNewThread: sendNew,
      onStop: stop,
    });
    await act(async () =>
      commandComposer().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    expect(sendNew).toHaveBeenCalledExactlyOnceWith(
      "独立的新会话请求",
      expect.objectContaining({
        scene: {
          sceneId: "office",
          mode: "auto",
          executionTarget: { kind: "crewon" },
        },
      }),
      null,
    );
    expect(sendExisting).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(props.selectedThread).toEqual(preservedThread);
  });

  it.each(["sidebar", "task-list"] as const)(
    "clears Thread-scoped URL keys from the %s draft without deleting persisted bindings",
    async (entry) => {
      const props = selectedRunningProps();
      writeThreadScene(window.localStorage, "background-thread", "office");
      writeThreadExecutionTarget(
        window.localStorage,
        "background-thread",
        "crewon",
      );
      window.history.replaceState(
        null,
        "",
        "/?surface=web&cwd=%2Fkeep&sceneThread=background-thread&scene=office&executionTargetThread=background-thread&executionTarget=crewon#view-command",
      );
      await render(props);
      if (entry === "sidebar") {
        await click(container.querySelector('[data-action="new-task"]'));
      } else {
        await click(container.querySelector('[data-nav-key="projects"]'));
        await click(
          container.querySelector(
            '[data-shell-view="projects"] .page-header button',
          ),
        );
      }
      const query = new URLSearchParams(window.location.search);
      for (const key of [
        "sceneThread",
        "scene",
        "executionTargetThread",
        "executionTarget",
      ]) {
        expect(query.has(key), key).toBe(false);
      }
      expect(query.get("surface")).toBe("web");
      expect(query.get("cwd")).toBe("/keep");
      expect(window.location.hash).toBe("#view-command");
      expect(readThreadScene(window.localStorage, "background-thread")).toBe(
        "office",
      );
      expect(
        readThreadExecutionTarget(window.localStorage, "background-thread"),
      ).toBe("crewon");
      expect(props.selectedThread?.turns[0]?.status).toBe("inProgress");
    },
  );
});
