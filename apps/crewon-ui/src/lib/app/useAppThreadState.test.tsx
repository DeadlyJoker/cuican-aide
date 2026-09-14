// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { RunEventView } from "@crewon/contracts";
import { useAppThreadState } from "./useAppThreadState";
import { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import { selectThreadAction } from "../thread/threadListActions";
import {
  detailThread,
  transcriptLabels,
} from "../thread/threadDetailCache.test-support";
import { upsertThread } from "../thread/threadModel";
import { Transcript } from "../../components/Transcript";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("App Thread detail lifecycle", () => {
  let state: ReturnType<typeof useAppThreadState>;
  let setDraft: (text: string) => void;
  let root: Root;
  let container: HTMLDivElement;
  const runtimes: ControlThreadRuntime[] = [];
  function Probe() {
    state = useAppThreadState();
    const [draft, updateDraft] = useState("");
    setDraft = updateDraft;
    const thread =
      state.threads.find((item) => item.id === state.selectedThreadId) ?? null;
    return (
      <>
        <input
          aria-label="Draft"
          value={draft}
          onChange={(event) => updateDraft(event.target.value)}
        />
        <Transcript
          {...transcriptLabels}
          thread={thread}
          locale="en"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
          streamingText={state.streamingTextByThread[thread?.id ?? ""] ?? ""}
        />
      </>
    );
  }
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
  });
  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("reloads an evicted conversation through the Control client and shows full canonical content", async () => {
    act(() => {
      state.setSelectedThreadId("thread-4");
      state.setThreads([4, 3, 2, 1].map((id) => detailThread(`thread-${id}`)));
      setDraft("Keep my unsent draft");
    });
    expect(
      state!.threads.find((thread) => thread.id === "thread-1")?.turns,
    ).toEqual([]);
    expect(state!.threadDetailCacheUsage.retainedThreads).toBe(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: { path: string; method: string }[] = [];
    const at = "2026-09-11T00:00:00Z";
    const thread = {
      threadId: "thread-1",
      title: "Restored title",
      status: "active",
      revision: 3,
      lastMessageSequence: 2,
      forkedFromThreadId: null,
      forkedThroughHistorySequence: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
    };
    const client = new ControlApiClient({
      baseUrl: "http://control.test",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push({ path, method: init?.method ?? "GET" });
        expect(init?.method).toBe("GET");
        if (path === "/api/v1/threads/thread-1") {
          await gate;
          return Response.json({ thread, eventSequence: 3 });
        }
        if (path.endsWith("/active-run"))
          return Response.json({
            schemaVersion: "crewon.thread-active-run.v0",
            threadId: thread.threadId,
            run: null,
          });
        if (path.endsWith("/transcript-window"))
          return Response.json({
            schemaVersion: "crewon.transcript-window.v0",
            messageWindow: {
              schemaVersion: "crewon.message-window.v0",
              threadId: thread.threadId,
              threadRevision: thread.revision,
              eventSequence: 3,
              headMessageSequence: 2,
              olderCursor: null,
              newerCursor: null,
              data: [
                {
                  messageId: "canonical-user",
                  threadId: thread.threadId,
                  sequence: 1,
                  role: "user",
                  content: "Canonical request",
                  proposedPlan: null,
                  createdAt: at,
                },
                {
                  messageId: "canonical-answer",
                  threadId: thread.threadId,
                  sequence: 2,
                  role: "assistant",
                  content: "Fresh **canonical answer**",
                  proposedPlan: null,
                  createdAt: at,
                },
              ],
            },
            runBindings: [
              {
                messageId: "canonical-user",
                runId: "run-1",
                source: "turnStartReceipt",
              },
              {
                messageId: "canonical-answer",
                runId: "run-1",
                source: "messageCompletedEvent",
              },
            ],
          });
        if (path === "/api/v1/runs/run-1")
          return Response.json({
            run: {
              runId: "run-1",
              threadId: thread.threadId,
              status: "completed",
              revision: 3,
              lastSequence: 3,
              cancelRequested: false,
              waitingApproval: null,
              collaborationMode: "default",
              purpose: "turn",
              workflowVersionBinding: null,
              goalBinding: null,
              outputRef: "message:canonical-answer",
              failure: null,
              createdAt: at,
              updatedAt: at,
              terminalAt: at,
            },
          });
        if (path === "/api/v1/runs/run-1/plan")
          return Response.json({
            runId: "run-1",
            eventSequence: 3,
            plan: null,
          });
        if (path.endsWith("/task-changes"))
          return Response.json({
            schemaVersion: "crewon.thread-task-change-ledger.v0",
            threadId: thread.threadId,
            threadRevision: 3,
            historySequence: 0,
            complete: true,
            summary: {
              schemaVersion: "crewon.workspace-change-summary.v0",
              paths: [],
              additions: 0,
              deletions: 0,
              statsComplete: true,
            },
            eventCount: 0,
            includedRunIds: ["run-1"],
          });
        throw new Error(`unexpected_read:${path}`);
      },
    });
    const runtime = new ControlThreadRuntime(
      {
        client,
        eventStream: async function* (): AsyncGenerator<RunEventView> {
          const event = { runId: "run-1", occurredAt: at };
          yield {
            ...event,
            eventId: "event-1",
            sequence: 1,
            type: "run.started",
            data: {},
          };
          yield {
            ...event,
            eventId: "event-2",
            sequence: 2,
            type: "segment.started",
            data: { segmentId: "segment-1", attempt: 1 },
          };
          yield {
            ...event,
            eventId: "event-3",
            sequence: 3,
            type: "run.completed",
            data: { outputRef: "message:canonical-answer" },
          };
        },
      },
      {
        onThread: (next) =>
          state.setThreads((current) => upsertThread(current, next)),
        onTextDelta: vi.fn(),
        onToolItem: vi.fn(),
        onRunSettled: vi.fn(),
        onStreamError: vi.fn(),
      },
    );
    runtimes.push(runtime);
    runtime.setThreadEventStreamFocus(null);
    const failed = vi.fn();
    const readErrors: unknown[] = [];
    let selected!: ReturnType<typeof selectThreadAction>;
    act(() => {
      selected = selectThreadAction({
        threadId: "thread-1",
        client: {
          readThread: async (id) => {
            try {
              return await runtime.readThread(id);
            } catch (error) {
              readErrors.push(error);
              throw error;
            }
          },
        },
        isConnected: true,
        locale: "en",
        preserveThreadsAfterConnectionLoss: failed,
        setAppView: vi.fn(),
        setInspectorOpen: vi.fn(),
        setNotice: vi.fn(),
        setSelectedThreadId: state.setSelectedThreadId,
        setSidebarOpen: vi.fn(),
        setThreads: state.setThreads,
        shouldAutoCloseSidebar: () => false,
      });
    });
    expect(
      container.querySelector('[role="status"][aria-label="Loading history"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Answer thread-1");
    await act(async () => {
      release();
      await selected;
    });
    expect(readErrors).toEqual([]);
    expect(failed).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Canonical request");
    expect(container.textContent).toContain("Fresh canonical answer");
    expect(
      container.querySelector('[role="status"][aria-label="Loading history"]'),
    ).toBeNull();
    expect(container.querySelector("input")?.value).toBe(
      "Keep my unsent draft",
    );
    expect(state!.selectedThreadId).toBe("thread-1");
    expect(state!.threads.find((item) => item.id === "thread-1")?.name).toBe(
      "Restored title",
    );
    expect(state!.threadDetailCacheUsage.retainedThreads).toBe(3);
    expect(
      requests.some((request) => request.path.endsWith("/transcript-window")),
    ).toBe(true);
    expect(
      requests.some((request) =>
        /\/(messages|runs|task-changes)$/u.test(request.path),
      ),
    ).toBe(false);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("keeps active and approval details through navigation and reclaims them after settlement", () => {
    const approval = {
      ...detailThread("approval"),
      status: {
        type: "active" as const,
        activeFlags: ["waitingOnApproval" as const],
      },
    };
    const running = detailThread("running");
    running.turns[0] = { ...running.turns[0]!, status: "inProgress" };
    act(() => {
      state.setSelectedThreadId("selected");
      state.setActiveTurnByThread({ running: "turn-running" });
      state.setThreads([
        detailThread("selected"),
        approval,
        running,
        detailThread("old"),
      ]);
    });
    for (const id of ["selected", "approval", "running"])
      expect(
        state!.threads.find((thread) => thread.id === id)?.turns,
      ).toHaveLength(1);
    act(() =>
      state.setThreads((current) =>
        upsertThread(current, detailThread("next")),
      ),
    );
    expect(
      state!.threads.find((thread) => thread.id === "next")?.turns,
    ).toEqual([]);
    expect(state!.activeTurnByThread.running).toBe("turn-running");
    act(() => {
      state.setActiveTurnByThread((current) => {
        const next = { ...current };
        delete next.running;
        return next;
      });
      state.setThreads((current) =>
        upsertThread(current, detailThread("running", "Completed output")),
      );
      state.setSelectedThreadId("next");
      state.setThreads((current) =>
        upsertThread(current, detailThread("next", "Opened next")),
      );
    });
    expect(
      state!.threads.find((thread) => thread.id === "approval")?.turns,
    ).toHaveLength(1);
    expect(
      state!.threads.find((thread) => thread.id === "next")?.turns,
    ).toHaveLength(1);
    expect(state!.threadDetailCacheUsage.retainedThreads).toBe(3);
    expect(state!.activeTurnByThread).toEqual({});
  });
});
