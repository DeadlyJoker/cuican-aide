// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEventView } from "@crewon/contracts";
import { useAppThreadState } from "../app/useAppThreadState";
import { useAppModelResponseTimeoutEffect } from "../app/effects/useAppModelResponseTimeoutEffect";
import {
  applyControlRunDraftEvent,
  createControlRunDraftProjectionState,
} from "../control-runtime/controlRunDraftProjection";
import { StreamingTextScope } from "../../components/StreamingTextScope";
import { Transcript } from "../../components/Transcript";
import { TranscriptStreamingMessage } from "../../components/TranscriptMessage";
import { CommandThreadRoom } from "../../components/app/CommandWorkspaceConversation";
import {
  detailThread,
  transcriptLabels,
} from "./threadDetailCache.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("App streaming preview lifecycle", () => {
  let state: ReturnType<typeof useAppThreadState>;
  let container: HTMLDivElement;
  let root: Root | null;
  let visibility: DocumentVisibilityState;
  let renders: number;
  let authority: "control" | "legacy";
  let interruptTurn: ReturnType<
    typeof vi.fn<(threadId: string, turnId: string) => Promise<void>>
  >;
  function Probe() {
    renders++;
    state = useAppThreadState();
    const thread =
      state.threads.find((thread) => thread.id === state.selectedThreadId) ??
      null;
    useAppModelResponseTimeoutEffect({
      ...state,
      activeTurnId:
        state.activeTurnByThread[state.selectedThreadId ?? ""] ?? null,
      client: { interruptTurn },
      isConnected: true,
      locale: "en",
      runtimeAuthority: authority,
      selectedThread: thread,
      streamingText: state.streamingTextByThread[thread?.id ?? ""] ?? "",
    });
    return (
      <StreamingTextScope presentation={state.streamingTextPresentation}>
        <Transcript
          {...transcriptLabels}
          locale="en"
          mode="code"
          onModeChange={() => {}}
          onStop={() => {}}
          thread={thread}
          streamingText={state.streamingTextByThread[thread?.id ?? ""] ?? ""}
        />
      </StreamingTextScope>
    );
  }
  beforeEach(() => {
    vi.useFakeTimers();
    authority = "legacy";
    interruptTurn = vi.fn(async () => {});
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    renders = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root!.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    act(() => {
      state.setSelectedThreadId("thread");
      const thread = detailThread("thread");
      thread.turns[0] = { ...thread.turns[0]!, status: "inProgress" };
      state.setThreads([thread]);
    });
  });
  afterEach(() => {
    if (root) act(() => root!.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const tick = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(32);
    });

  function beginWithoutOutput() {
    act(() => {
      const thread = detailThread("thread");
      thread.turns[0] = {
        ...thread.turns[0]!,
        status: "inProgress",
        startedAt: Math.floor(Date.now() / 1000),
        items: [],
      };
      state.setThreads([thread]);
      state.setActiveTurnByThread({ thread: "turn-thread" });
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
  }

  it("rechecks received hidden output before the legacy startup timer can interrupt it", async () => {
    beginWithoutOutput();
    act(() => state.appendStreamingTextDelta("thread", "模型正在输出"));
    expect(state!.streamingTextByThread.thread).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(state!.activeTurnByThread.thread).toBe("turn-thread");
  });

  it("does not infer no model output from an evicted preview after navigation", async () => {
    beginWithoutOutput();
    act(() => state.appendStreamingTextDelta("thread", "模型正在输出"));
    act(() => state.setSelectedThreadId("other"));
    act(() => {
      for (let index = 0; index < 50; index++)
        state.appendStreamingTextDelta(`other-${index}`, "output");
    });
    expect(state!.streamingTextActivity("thread")).toBe("unavailable");
    act(() => state.setSelectedThreadId("thread"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(121_000);
    });
    expect(interruptTurn).not.toHaveBeenCalled();
    expect(state!.activeTurnByThread.thread).toBe("turn-thread");
  });

  it.each(["legacy", "control"] as const)(
    "preserves %s deadline authority for a task with no output",
    async (mode) => {
      authority = mode;
      beginWithoutOutput();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(121_000);
      });
      if (mode === "legacy") {
        expect(interruptTurn).toHaveBeenCalledExactlyOnceWith(
          "thread",
          "turn-thread",
        );
        expect(state!.activeTurnByThread.thread).toBeUndefined();
      } else {
        expect(interruptTurn).not.toHaveBeenCalled();
        expect(state!.activeTurnByThread.thread).toBe("turn-thread");
      }
    },
  );

  it("preserves another task's pending output when a task finishes before the next frame", async () => {
    act(() => {
      state.appendStreamingTextDelta("finished", "discarded");
      state.appendStreamingTextDelta("thread", "keep😀");
      state.setStreamingTextByThread((current) => ({
        ...current,
        finished: "",
      }));
    });
    await tick();
    expect(state!.streamingTextByThread).toEqual({ thread: "keep😀" });
    expect(container.textContent).toContain("keep😀");
    expect(container.textContent).not.toContain("discarded");
  });

  it("applies actual retry/reset projections and retains canonical completion after preview release", async () => {
    let projection = createControlRunDraftProjectionState();
    let sequence = 0;
    const apply = (type: RunEventView["type"], data: RunEventView["data"]) => {
      const result = applyControlRunDraftEvent(projection, {
        type,
        data,
        eventId: `event-${++sequence}`,
        sequence,
        runId: "run",
        occurredAt: "2026-09-11T00:00:00Z",
      } as RunEventView);
      projection = result.state;
      if (result.reset) state.resetStreamingText("thread");
      if (result.delta) state.appendStreamingTextDelta("thread", result.delta);
    };
    act(() => {
      apply("segment.started", { segmentId: "segment", attempt: 1 });
      apply("model.output.delta", {
        segmentId: "segment",
        delta: "discarded draft",
      });
      apply("model.sampling.retry", {
        segmentId: "segment",
        samplingAttempt: 2,
        maxRetries: 3,
        code: "transient",
        discardedOutput: true,
      });
      apply("model.output.delta", { segmentId: "segment", delta: "fresh😀" });
    });
    await tick();
    expect(container.textContent).toContain("fresh😀");
    expect(container.textContent).not.toContain("discarded draft");
    await act(async () => {
      await state.waitForStreamingTextDrain("thread");
    });
    act(() => {
      state.setThreads([detailThread("thread")]);
      state.resetStreamingText("thread");
    });
    expect(state!.streamingTextByThread).toEqual({});
    expect(container.textContent).toContain("Answer thread");
    expect(container.textContent).not.toContain("fresh😀");
  });

  it("does not rerender hidden output and shows the latest bounded preview on return", async () => {
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const baseline = renders;
    act(() => {
      for (let index = 0; index < 100; index++)
        state.appendStreamingTextDelta(
          "thread",
          `片段${index}:` + "正文😀".repeat(2000),
        );
    });
    await act(async () => {
      await state.waitForStreamingTextDrain("thread");
    });
    expect(renders).toBe(baseline);
    act(() => {
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(state!.streamingTextByThread.thread?.length).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(container.textContent).toContain("片段99:");
    expect(container.textContent).toContain(
      "Showing the latest live content only",
    );
    expect(container.querySelector("pre")?.textContent).toBe(
      state!.streamingTextByThread.thread,
    );
  });

  it("removes the lifetime's visibility listener and settles pending drains on unmount", async () => {
    const remove = vi.spyOn(document, "removeEventListener");
    act(() => state.appendStreamingTextDelta("thread", "x".repeat(1000)));
    const drained = state!.waitForStreamingTextDrain("thread");
    act(() => root!.unmount());
    root = null;
    await drained;
    expect(
      remove.mock.calls.filter(([name]) => name === "visibilitychange"),
    ).toHaveLength(1);
    state!.appendStreamingTextDelta("thread", "late");
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
    expect(container.innerHTML).toBe("");
  });
});

describe("partial streaming preview presentation", () => {
  it("shows a clipped Markdown suffix as plain text with an explicit notice", () => {
    const markup = renderToStaticMarkup(
      <TranscriptStreamingMessage
        crewonLabel="CrewON"
        locale="zh"
        partial
        streamingText={"unclosed **Markdown**\n```\n<html>😀"}
      />,
    );
    expect(markup).not.toContain("<strong>");
    expect(markup).toContain("&lt;html&gt;");
    expect(markup).toMatchSnapshot();
  });

  it("shows reclaimed previews in Command and clears the notice after completion", () => {
    const thread = detailThread("thread");
    thread.turns[0] = { ...thread.turns[0]!, status: "inProgress" };
    const render = (running: boolean) =>
      renderToStaticMarkup(
        <StreamingTextScope presentation={{ previews: {}, reclaimed: true }}>
          <CommandThreadRoom
            activeTurnId={running ? "turn-thread" : null}
            cwd="/workspace"
            locale="en"
            selectedThread={{
              ...thread,
              turns: [
                {
                  ...thread.turns[0]!,
                  status: running ? "inProgress" : "completed",
                },
              ],
            }}
            streamingText=""
            workMode="code"
            onModeChange={() => {}}
          />
        </StreamingTextScope>,
      );
    const markup = render(true);
    expect(markup).toContain("Live preview is not retained");
    expect(render(false)).not.toContain("Live preview is not retained");
    const document = new DOMParser().parseFromString(markup, "text/html");
    expect(
      document.querySelector(".transcript-streaming-notice")?.outerHTML,
    ).toMatchSnapshot();
  });
});
