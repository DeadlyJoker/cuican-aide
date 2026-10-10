// @vitest-environment happy-dom
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { act, useState, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAppThreadRuntimeHandlers,
  type AppThreadRuntimeHandlersParams,
} from "../../lib/app/handlers/appThreadRuntimeHandlers";
import { useAppThreadState } from "../../lib/app/useAppThreadState";
import type { ControlWindowedThread } from "../../lib/control-runtime/controlTranscriptWindow";
import { emptyTerminalOutputStream } from "../../lib/terminal/terminalOutputStream";
import { detailThread } from "../../lib/thread/threadDetailCache.test-support";
import { PendingThreadSubmissionScope } from "../messages/PendingThreadSubmissionScope";
import { AppCommandShellRoute } from "./AppCommandShellRoute";
import { emptyAgentPlatformSnapshot } from "./commandWorkspaceState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const request = "Show this request immediately, before starting the Agent";
const createdId = "created-thread";
const runId = "created-run";
const noop = () => undefined;
const loadSnapshot = async () => emptyAgentPlatformSnapshot;
type RouteProps = ComponentProps<typeof AppCommandShellRoute>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createdThread(): ControlWindowedThread {
  return {
    ...detailThread(createdId),
    status: { type: "idle" },
    turns: [],
    controlTranscriptWindow: {
      cursor: null,
      olderCursor: null,
      newerCursor: null,
      threadRevision: 1,
      firstSequence: null,
      lastSequence: null,
      rows: [],
    },
  };
}

function canonicalTurn(): Turn {
  return {
    id: runId,
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    items: [
      {
        type: "userMessage",
        id: "canonical-user",
        clientId: null,
        content: [{ type: "text", text: request, text_elements: [] }],
      },
    ],
  };
}

const capabilityDrawer: RouteProps["capabilityDrawer"] = {
  busyToolId: null,
  commandValue: "",
  disabled: false,
  locale: "en",
  open: false,
  panel: null,
  scene: "code",
  terminalCwd: "",
  terminalOutput: emptyTerminalOutputStream,
  terminalProcessId: null,
  onClose: noop,
  onCommandChange: noop,
  onCommandSubmit: noop,
  onFiles: noop,
  onOpen: noop,
  onPanelAction: noop,
  onPanelFieldChange: noop,
  onPanelItem: noop,
  onReview: noop,
  onSideChat: noop,
  onTerminal: noop,
  onTerminalResize: noop,
  onTerminalStart: noop,
  onTerminalStop: noop,
  onTerminalWrite: noop,
};

describe("Command shell submission through real Thread handlers", () => {
  let root: Root;
  let container: HTMLDivElement;
  let state: ReturnType<typeof useAppThreadState>;
  let setDisplay: (thread: Thread | null | undefined) => void;
  let renderProbe: () => void;
  let workspaceCurrent: boolean;
  let creation: ReturnType<typeof deferred<Thread>>;
  let run: ReturnType<typeof deferred<{ turn: Turn }>>;
  let task: Promise<void> | undefined;
  let startThread: ReturnType<typeof vi.fn>;
  let startTurn: ReturnType<typeof vi.fn>;
  let selectionFrame: { userMessages: number; requestVisible: boolean } | null;

  function Probe() {
    state = useAppThreadState();
    const [composerValue, setComposerValue] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [display, updateDisplay] = useState<Thread | null | undefined>();
    const [, rerender] = useState(0);
    setDisplay = updateDisplay;
    renderProbe = () => rerender((value) => value + 1);
    const canonical =
      state.threads.find((thread) => thread.id === state.selectedThreadId) ??
      null;
    const selectedThread = display === undefined ? canonical : display;
    const handlers = createAppThreadRuntimeHandlers({
      activeTurnByThread: state.activeTurnByThread,
      activeTurnId: state.selectedThreadId
        ? (state.activeTurnByThread[state.selectedThreadId] ?? null)
        : null,
      busyToolId: null,
      client: {
        turnUpdates: "runtime",
        startThread,
        startTurn,
        resumeThread: async (id: string) =>
          state.threads.find((thread) => thread.id === id)!,
        readThread: async (id: string) =>
          state.threads.find((thread) => thread.id === id)!,
      } as unknown as AppThreadRuntimeHandlersParams["client"],
      confirm: () => true,
      demoResponse: "",
      getShowArchivedThreads: () => false,
      isConnected: true,
      isDemo: false,
      isDemoPreview: false,
      isSending,
      locale: "en",
      newDraftPreview: "",
      newDraftThread: "New conversation",
      pendingComposerMentions: [],
      preserveThreadsAfterConnectionLoss: noop,
      prompt: () => null,
      recordShowArchivedThreads: noop,
      resolveBackendCwd: async () => undefined,
      selectedThread,
      selectedThreadId: state.selectedThreadId,
      setActiveTurnByThread: state.setActiveTurnByThread,
      setAppView: noop,
      setBusyToolId: noop,
      setCapabilityPanel: noop,
      setComposerFocusSignal: noop,
      setComposerValue,
      setInspectorOpen: noop,
      setIsSending,
      setNotice: noop,
      setPendingComposerMentions: noop,
      setSelectedThreadId: (id) => {
        if (id !== createdId) {
          state.setSelectedThreadId(id);
          return;
        }
        // The browser can commit this state before sendMessageAction resumes
        // its await createThread continuation and binds the pending submission.
        flushSync(() => state.setSelectedThreadId(id));
        selectionFrame ??= {
          userMessages: requestBubbles().length,
          requestVisible:
            conversation().textContent?.includes(request) ?? false,
        };
      },
      setShowArchivedThreads: noop,
      setSidebarOpen: noop,
      setThreadSearchTerm: noop,
      setThreads: state.setThreads,
      shouldAutoCloseSidebar: () => false,
      untitledThreadLabel: "Untitled",
      creationWorkspaceId: "workspace-a",
      isCreationWorkspaceCurrent: () => workspaceCurrent,
      beginMessageSubmission: state.beginMessageSubmission,
      selectedThreadIdRef: state.selectedThreadIdRef,
      selectionEpochRef: state.selectionEpochRef,
    });
    return (
      <PendingThreadSubmissionScope
        submissions={state.pendingThreadSubmissions}
        selectedThreadId={state.selectedThreadId}
        selectionEpoch={state.selectionEpochRef.current}
        onPresented={state.acknowledgePresentedSubmissions}
      >
        <AppCommandShellRoute
          activeTurnId={
            state.selectedThreadId
              ? (state.activeTurnByThread[state.selectedThreadId] ?? null)
              : null
          }
          capabilityDrawer={capabilityDrawer}
          composerValue={composerValue}
          confirmDialog={{
            locale: "en",
            request: null,
            onCancel: noop,
            onConfirm: noop,
          }}
          connectionState="connected"
          cwd=""
          isSending={isSending}
          linkedThreads={state.threads}
          locale="en"
          platform="web"
          platformSnapshotLoader={loadSnapshot}
          selectedThread={selectedThread}
          selectedThreadId={state.selectedThreadId}
          workMode="code"
          workspaceAuthority="control"
          onAttachContext={noop}
          onChangeComposerValue={setComposerValue}
          onModeChange={noop}
          onRetryConnection={noop}
          onSelectLinkedThread={(id) => {
            if (id === null) handlers.startDraftThread();
            else void handlers.selectThread(id);
          }}
          onSend={(...args) => {
            task = handlers.sendMessage(...args);
          }}
          onSendNewThread={(...args) => {
            task = handlers.sendMessageInNewThread(...args);
          }}
        />
      </PendingThreadSubmissionScope>
    );
  }

  function conversation() {
    return container.querySelector('[data-shell-view="command"]')!;
  }

  function requestBubbles() {
    return [
      ...conversation().querySelectorAll('[data-kind="userMessage"]'),
    ].filter((element) => element.textContent?.includes(request));
  }

  async function click(selector: string) {
    const element = container.querySelector<HTMLButtonElement>(selector);
    expect(element).not.toBeNull();
    await act(async () => element!.click());
  }

  async function submit() {
    const textarea = conversation().querySelector<HTMLTextAreaElement>(
      "form[data-command-composer] textarea",
    )!;
    expect(textarea).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(textarea, request);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = conversation().querySelector<HTMLButtonElement>(
      'form[data-command-composer] [data-action="send"]',
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(task).toBeDefined();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
    window.history.replaceState(null, "", "/?surface=web#view-command");
    window.localStorage.clear();
    creation = deferred<Thread>();
    run = deferred<{ turn: Turn }>();
    workspaceCurrent = true;
    task = undefined;
    selectionFrame = null;
    startThread = vi.fn(() => creation.promise);
    startTurn = vi.fn(() => run.promise);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.classList.remove("modal-open");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never drops the user bubble between Thread selection, Run receipt, and canonical hydration", async () => {
    await submit();
    expect(requestBubbles()).toHaveLength(1);
    expect(state.threads).toEqual([]);
    expect(state.activeTurnByThread).toEqual({});
    expect(startThread).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(
      conversation().querySelector('[data-od-id="command-thread-room"]')!
        .outerHTML,
    ).toMatchSnapshot("pending Thread creation in the command shell");

    await act(async () => creation.resolve(createdThread()));
    expect(selectionFrame).toEqual({ userMessages: 1, requestVisible: true });
    expect(requestBubbles()).toHaveLength(1);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(state.selectedThreadId).toBe(createdId);
    expect(state.threads[0]?.turns).toEqual([]);

    // Selection is committed before the conversation detail projection is
    // available; the bound pending submission still owns this command surface.
    await act(async () => setDisplay(null));
    expect(requestBubbles()).toHaveLength(1);

    const summary = createdThread();
    await act(async () => setDisplay(summary));
    await act(async () => {
      run.resolve({ turn: canonicalTurn() });
      await task;
    });
    expect(state.threads[0]?.turns[0]?.items[0]?.id).toBe("canonical-user");
    // The global cache can already contain the committed user item while the
    // selected presentation still displays the pre-hydration summary.
    expect(requestBubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toHaveLength(1);

    await act(async () => setDisplay(undefined));
    expect(requestBubbles()).toHaveLength(1);
    expect(
      conversation().querySelector("[data-pending-user-message]"),
    ).toBeNull();
    expect(state.pendingThreadSubmissions).toEqual([]);
    expect(startThread).toHaveBeenCalledOnce();
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("keeps the local bubble until the displayed transcript row includes the canonical user item", async () => {
    await submit();
    await act(async () => creation.resolve(createdThread()));
    const rowProjection: ControlWindowedThread = {
      ...createdThread(),
      controlTranscriptWindow: {
        ...createdThread().controlTranscriptWindow!,
        rows: [
          {
            kind: "run",
            runId,
            itemIds: [],
            firstFragment: true,
            continuation: true,
          },
        ],
      },
    };
    await act(async () => state.setThreads([rowProjection]));
    await act(async () => {
      run.resolve({ turn: canonicalTurn() });
      await task;
    });
    expect(state.threads[0]?.turns[0]?.items[0]?.id).toBe("canonical-user");
    expect(requestBubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toHaveLength(1);
    expect(
      conversation().querySelector("[data-pending-user-message]"),
    ).not.toBeNull();

    await act(async () => {
      state.setThreads((threads) =>
        threads.map((thread) => ({
          ...thread,
          controlTranscriptWindow: {
            ...rowProjection.controlTranscriptWindow!,
            threadRevision: 2,
            firstSequence: 1,
            lastSequence: 1,
            rows: [
              {
                kind: "run" as const,
                runId,
                itemIds: ["canonical-user"],
                firstFragment: true,
                continuation: false,
              },
            ],
          },
        })),
      );
    });
    expect(requestBubbles()).toHaveLength(1);
    expect(
      conversation().querySelector("[data-pending-user-message]"),
    ).toBeNull();
    expect(state.pendingThreadSubmissions).toEqual([]);
  });

  it("keeps the sent text after an accepted receipt until its canonical body is available", async () => {
    await submit();
    await act(async () => creation.resolve(createdThread()));
    const receipt = canonicalTurn();
    const user = receipt.items[0]!;
    if (user.type !== "userMessage") throw new Error("fixture");
    user.content = [];
    await act(async () => {
      run.resolve({ turn: receipt });
      await task;
    });
    expect(requestBubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toHaveLength(1);
    expect(
      conversation().querySelector("[data-pending-user-message]"),
    ).not.toBeNull();

    await act(async () => {
      state.setThreads((threads) =>
        threads.map((thread) => ({ ...thread, turns: [canonicalTurn()] })),
      );
    });
    expect(requestBubbles()).toHaveLength(1);
    expect(state.pendingThreadSubmissions).toEqual([]);
    expect(startTurn).toHaveBeenCalledOnce();
  });

  it("starts from a previous Thread across the new-draft epoch and hides pending work after navigation", async () => {
    const old = detailThread("old-thread", "Keep the previous answer");
    const other = detailThread("other-thread", "Different conversation");
    await act(async () => {
      state.setThreads([old, other]);
      state.setSelectedThreadId(old.id);
    });
    const oldEpoch = state.selectionEpochRef.current;
    await click('[data-action="new-task"]');
    expect(state.selectedThreadId).toBeNull();
    expect(state.selectionEpochRef.current).toBeGreaterThan(oldEpoch);
    await submit();
    expect(requestBubbles()).toHaveLength(1);
    expect(conversation().textContent).not.toContain(
      "Keep the previous answer",
    );

    await click('[data-linked-thread-id="other-thread"]');
    expect(state.selectedThreadId).toBe(other.id);
    expect(requestBubbles()).toHaveLength(0);
    expect(conversation().textContent).toContain("Different conversation");
    await act(async () => creation.resolve(createdThread()));
    expect(state.selectedThreadId).toBe(other.id);
    expect(requestBubbles()).toHaveLength(0);
    await act(async () => {
      run.resolve({ turn: canonicalTurn() });
      await task;
    });
    expect(state.selectedThreadId).toBe(other.id);
    expect(requestBubbles()).toHaveLength(0);
    expect(state.threads.find((thread) => thread.id === old.id)?.turns).toEqual(
      old.turns,
    );
  });

  it("does not reveal an unfinished submission after workspace authority changes", async () => {
    await submit();
    expect(requestBubbles()).toHaveLength(1);
    workspaceCurrent = false;
    await act(async () => renderProbe());
    expect(requestBubbles()).toHaveLength(0);
    await act(async () => {
      creation.reject(new Error("Creation canceled"));
      await task;
    });
    expect(state.selectedThreadId).toBeNull();
    expect(requestBubbles()).toHaveLength(0);
    expect(
      conversation().querySelector<HTMLTextAreaElement>("textarea")?.value,
    ).toBe("");
  });
});
