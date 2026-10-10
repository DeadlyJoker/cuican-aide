// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { Turn } from "@crewon/app-server-protocol/v2/Turn";
import { useAppThreadState } from "../../lib/app/useAppThreadState";
import { sendMessageAction } from "../../lib/thread/threadMessageActions";
import { visiblePendingThreadSubmissions } from "../../lib/thread/threadPendingSubmission";
import {
  detailThread,
  transcriptLabels,
} from "../../lib/thread/threadDetailCache.test-support";
import { PendingThreadSubmissionScope } from "../messages/PendingThreadSubmissionScope";
import { Transcript } from "../Transcript";
import { PendingCommandThreadRoom } from "./CommandWorkspaceConversation";
import { CommandWorkspace } from "./CommandWorkspace";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function canonicalTurn(
  text = "Immediate request",
  id = "canonical-turn",
): Turn {
  return {
    id,
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: 1,
    completedAt: null,
    durationMs: null,
    items: [
      {
        type: "userMessage",
        id: `canonical-user-${id}`,
        clientId: null,
        content: [{ type: "text", text, text_elements: [] }],
      },
    ],
  };
}

function responseGate() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Immediate user message submission", () => {
  let state: ReturnType<typeof useAppThreadState>;
  let root: Root;
  let container: HTMLDivElement;
  let send: (options?: {
    activeTurnId?: string;
    settings?: boolean;
    omitCanonical?: boolean;
  }) => Promise<void>;
  let draft: string;
  let workspaceCurrent: boolean;
  let gates: Map<string, ReturnType<typeof responseGate>>;
  let requests: string[];

  function Probe() {
    state = useAppThreadState();
    const thread =
      state.threads.find((thread) => thread.id === state.selectedThreadId) ??
      null;
    send = (options = {}) => {
      let targetId = state.selectedThreadId;
      const currentSelection = () =>
        workspaceCurrent && state.selectedThreadIdRef.current === targetId;
      const post = async (path: string) => {
        requests.push(path);
        return (
          await fetch(`http://control.test${path}`, { method: "POST" })
        ).json();
      };
      return sendMessageAction({
        activeTurnId: options.activeTurnId ?? null,
        client: {
          turnUpdates: "runtime",
          resumeThread: async () => thread!,
          updateThreadSettings: async () => {
            await post("/settings");
          },
          startTurn: async () => {
            await post("/runs");
            return {
              turn: options.omitCanonical
                ? { ...canonicalTurn(), items: [] }
                : canonicalTurn(),
            };
          },
          steerTurn: async () => {
            await post("/guidance");
            return { turnId: "running-turn" };
          },
        },
        createThread: async () => {
          await post("/threads");
          const created = detailThread("created");
          created.turns = [];
          state.setThreads((current) => [...current, created]);
          if (currentSelection()) state.setSelectedThreadId(created.id);
          return created;
        },
        onSubmission: () => {
          const observer = state.beginMessageSubmission({
            text: "Immediate request",
            images: [],
            thread,
            threadId: state.selectedThreadId,
            isWorkspaceCurrent: () => workspaceCurrent,
          });
          return {
            ...observer,
            bindThread: (id) => {
              targetId = id;
              observer.bindThread(id);
            },
          };
        },
        isSubmissionSelectionCurrent: currentSelection,
        demoResponse: "",
        isConnected: true,
        isDemoPreview: false,
        isSending: false,
        locale: "en",
        pendingComposerMentions: [],
        preserveThreadsAfterConnectionLoss: () => {},
        selectedThread: thread,
        selectedThreadId: state.selectedThreadId,
        setActiveTurnByThread: state.setActiveTurnByThread,
        setComposerFocusSignal: () => {},
        setComposerValue: (value) => {
          draft = value;
        },
        setIsSending: () => {},
        setNotice: () => {},
        setPendingComposerMentions: () => {},
        setSelectedThreadId: (id) => {
          if (currentSelection()) state.setSelectedThreadId(id);
        },
        setThreads: state.setThreads,
        text: "Immediate request",
        threadSettings: options.settings ? { model: "gpt-6.1-sol" } : undefined,
      });
    };
    return (
      <PendingThreadSubmissionScope
        submissions={visiblePendingThreadSubmissions(
          state.pendingThreadSubmissions,
          thread,
          state.selectedThreadId,
          state.selectionEpochRef.current,
        )}
      >
        <Transcript
          {...transcriptLabels}
          thread={thread}
          locale="en"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
          streamingText=""
        />
      </PendingThreadSubmissionScope>
    );
  }

  beforeEach(() => {
    draft = "";
    workspaceCurrent = true;
    gates = new Map();
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const path = new URL(input).pathname;
        const gate = gates.get(path);
        return gate ? gate.promise : Response.json({ ok: true });
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const userMessages = () =>
    container.querySelectorAll('[data-kind="userMessage"]');

  it("shows the user bubble before delayed thread creation without a fake thread or run", async () => {
    const gate = responseGate();
    gates.set("/threads", gate);
    let task!: Promise<void>;
    act(() => {
      task = send();
    });
    expect(userMessages()).toHaveLength(1);
    expect(container.textContent).toContain("Immediate request");
    expect(container.textContent).toContain("Sending");
    expect(state.threads).toEqual([]);
    expect(state.selectedThreadId).toBeNull();
    expect(state.activeTurnByThread).toEqual({});
    expect(requests).toEqual(["/threads"]);
    await act(async () => {
      gate.resolve(Response.json({ ok: true }));
      await task;
    });
    expect(state.selectedThreadId).toBe("created");
    expect(userMessages()).toHaveLength(1);
    expect(container.querySelector("[data-pending-user-message]")).toBeNull();
    expect(state.threads[0]?.turns[0]?.id).toBe("canonical-turn");
  });

  it("shows an existing-thread message while settings and Run creation are both pending", async () => {
    act(() => {
      state.setThreads([detailThread("existing")]);
      state.setSelectedThreadId("existing");
    });
    const settings = responseGate();
    const run = responseGate();
    gates.set("/settings", settings);
    gates.set("/runs", run);
    let task!: Promise<void>;
    act(() => {
      task = send({ settings: true });
    });
    expect(userMessages()).toHaveLength(2);
    expect(requests).toEqual(["/settings"]);
    await act(async () => {
      settings.resolve(Response.json({ ok: true }));
      await Promise.resolve();
    });
    expect(requests).toEqual(["/settings", "/runs"]);
    expect(userMessages()).toHaveLength(2);
    await act(async () => {
      run.resolve(Response.json({ ok: true }));
      await task;
    });
    expect(userMessages()).toHaveLength(2);
    expect(container.querySelector("[data-pending-user-message]")).toBeNull();
  });

  it("echoes steering guidance immediately and reconciles the later canonical user item", async () => {
    const existing = detailThread("existing");
    existing.turns = [canonicalTurn("Original", "running-turn")];
    act(() => {
      state.setThreads([existing]);
      state.setSelectedThreadId(existing.id);
    });
    const gate = responseGate();
    gates.set("/guidance", gate);
    let task!: Promise<void>;
    act(() => {
      task = send({ activeTurnId: "running-turn" });
    });
    expect(userMessages()).toHaveLength(2);
    expect(requests).toEqual(["/guidance"]);
    await act(async () => {
      gate.resolve(Response.json({ ok: true }));
      await task;
    });
    expect(userMessages()).toHaveLength(2);
    act(() =>
      state.setThreads((threads) =>
        threads.map((thread) => ({
          ...thread,
          turns: thread.turns.map((turn) => ({
            ...turn,
            items: [...turn.items, canonicalTurn().items[0]!],
          })),
        })),
      ),
    );
    expect(userMessages()).toHaveLength(2);
    expect(container.querySelector("[data-pending-user-message]")).toBeNull();
  });

  it("retains a failed bubble and restores the retry draft without a fake durable turn", async () => {
    const gate = responseGate();
    gates.set("/threads", gate);
    let task!: Promise<void>;
    act(() => {
      task = send();
    });
    await act(async () => {
      gate.reject(new Error("Connection closed"));
      await task;
    });
    expect(userMessages()).toHaveLength(1);
    expect(
      container.querySelector('[data-pending-user-message="failed"]'),
    ).not.toBeNull();
    expect(draft).toBe("Immediate request");
    expect(state.threads).toEqual([]);
  });

  it("keeps pending work out of another conversation and does not replace its selection or draft", async () => {
    const gate = responseGate();
    gates.set("/threads", gate);
    let task!: Promise<void>;
    act(() => {
      task = send();
    });
    act(() => {
      state.setThreads([detailThread("other")]);
      state.setSelectedThreadId("other");
    });
    expect(container.textContent).not.toContain("Immediate request");
    await act(async () => {
      gate.resolve(Response.json({ ok: true }));
      await task;
    });
    expect(state.selectedThreadId).toBe("other");
    expect(container.textContent).not.toContain("Immediate request");
    expect(draft).toBe("");
  });

  it("hides an unfinished draft after workspace authority changes", async () => {
    const gate = responseGate();
    gates.set("/threads", gate);
    let task!: Promise<void>;
    act(() => {
      task = send();
    });
    workspaceCurrent = false;
    act(() => state.setSelectedThreadId(null));
    expect(container.textContent).not.toContain("Immediate request");
    await act(async () => {
      gate.reject(new Error("Connection closed"));
      await task;
    });
    expect(draft).toBe("");
    expect(container.textContent).not.toContain("Immediate request");
  });

  it("matches the new-conversation user bubble snapshot before a task exists", () => {
    act(() => {
      void state.beginMessageSubmission({
        text: "An idea",
        images: [],
        thread: null,
        threadId: null,
        isWorkspaceCurrent: () => true,
      });
    });
    const markup = renderToStaticMarkup(
      <PendingThreadSubmissionScope
        submissions={state.pendingThreadSubmissions}
      >
        <PendingCommandThreadRoom
          locale="en"
          workMode="code"
          onModeChange={() => {}}
        />
      </PendingThreadSubmissionScope>,
    );
    expect(markup).toMatchSnapshot();
    expect(markup).not.toContain("Agent running");
    expect(markup).not.toContain("data-run-id");
  });

  it("opens the real command conversation area during creation without duplicating a hidden assistant bubble", () => {
    act(() => {
      state.beginMessageSubmission({ text: "Visible immediately", images: [], thread: null,
        threadId: null, isWorkspaceCurrent: () => true });
    });
    const markup = renderToStaticMarkup(
      <PendingThreadSubmissionScope submissions={state.pendingThreadSubmissions}>
        <CommandWorkspace composerValue="" connectionState="connected" cwd="" isSending
          locale="en" selectedThread={null} selectedThreadId={null} workMode="code"
          onAttachContext={() => {}} onChangeComposerValue={() => {}} onModeChange={() => {}}
          onRetryConnection={() => {}} onSend={() => {}} />
      </PendingThreadSubmissionScope>,
    );
    const dom = document.createElement("div"); dom.innerHTML = markup;
    expect(dom.querySelector('[data-shell-view="command"]')?.getAttribute("data-has-thread")).toBe("true");
    expect(dom.querySelectorAll('[data-kind="userMessage"]')).toHaveLength(1);
    expect(dom.querySelector('[data-pending-user-message="sending"]')?.textContent).toContain("Visible immediately");
    expect(state.selectedThreadId).toBeNull();
    expect(state.threads).toEqual([]);
  });
});
