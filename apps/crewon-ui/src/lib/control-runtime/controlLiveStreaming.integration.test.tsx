// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ControlApiClient } from "@crewon/control-client";
import type { RunEventView } from "@crewon/contracts";
import { useAppThreadState } from "../app/useAppThreadState";
import { commandShellRuntimeState } from "../app/appCommandShellRuntime";
import { useControlThreadRuntime } from "./useControlThreadRuntime";
import { CommandThreadRoom } from "../../components/app/CommandWorkspaceConversation";
import { StreamingTextScope } from "../../components/StreamingTextScope";
import {
  settlementClient,
  settlementCompleted,
  settlementDelta,
  settlementThreadId,
  settlementTime,
} from "./controlRunSettlement.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Frames arrive independently of terminal history, including split UTF-8 bytes. */
function runFeed() {
  const events: RunEventView[] = [];
  const streams = new Set<{
    send: (event: RunEventView) => void;
    close: () => void;
  }>();
  let completed = false;
  const frame = (event: RunEventView) =>
    new TextEncoder().encode(
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  return {
    open(afterSequence: number, signal?: AbortSignal | null) {
      let close!: () => void;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          const stream = {
            send(event: RunEventView) {
              const bytes = frame(event);
              // SSE fields and multi-byte characters need not align with reads.
              for (let offset = 0; offset < bytes.length; offset += 13)
                controller.enqueue(bytes.slice(offset, offset + 13));
            },
            close() {
              if (closed) return;
              closed = true;
              streams.delete(stream);
              signal?.removeEventListener("abort", close);
              controller.close();
            },
          };
          close = stream.close;
          for (const event of events)
            if (event.sequence > afterSequence) stream.send(event);
          if (completed || signal?.aborted) close();
          else {
            streams.add(stream);
            signal?.addEventListener("abort", close, { once: true });
          }
        },
        cancel() {
          // Cancellation is idempotent after the reader closes its own body.
          close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    send(event: RunEventView) {
      events.push(event);
      for (const stream of streams) stream.send(event);
    },
    disconnect() {
      for (const stream of [...streams]) stream.close();
    },
    finish(event: RunEventView) {
      this.send(event);
      completed = true;
      this.disconnect();
    },
  };
}

function liveHttpFixture() {
  const durable = settlementClient();
  const feed = runFeed();
  const cursors: number[] = [];
  const streams: Array<() => void> = [];
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      headers: { "content-type": "application/json" },
    });
  const threadPath = `/api/v1/threads/${settlementThreadId}`;
  const client = new ControlApiClient({
    baseUrl: "http://live.fixture.invalid",
    accessToken: "live-owner-session",
    csrfToken: "live-owner-csrf",
    origin: "http://app.fixture.invalid",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer live-owner-session",
      );
      if (url.pathname === "/api/v1/agent-versions/active")
        return json(await durable.client.getActiveAgentVersionCatalog());
      if (url.pathname === "/api/v1/threads")
        return json({
          data: [(await durable.client.getThread(settlementThreadId)).thread],
          nextCursor: null,
        });
      if (url.pathname === threadPath)
        return json(await durable.client.getThread(settlementThreadId));
      if (url.pathname === `${threadPath}/active-run`)
        return json(
          await durable.client.getThreadActiveRun(settlementThreadId),
        );
      if (url.pathname === `${threadPath}/transcript-window`)
        return json(durable.transcript());
      if (url.pathname === `${threadPath}/goal`)
        return json({
          threadId: settlementThreadId,
          goal: null,
          eventSequence: 0,
        });
      if (
        url.pathname === `${threadPath}/events` ||
        url.pathname === `${threadPath}/goal/events`
      ) {
        let close!: () => void;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            close = () => {
              init?.signal?.removeEventListener("abort", close);
              try {
                controller.close();
              } catch {
                // The renderer may cancel before fixture shutdown.
              }
            };
            init?.signal?.addEventListener("abort", close, { once: true });
            streams.push(close);
          },
          cancel() {
            init?.signal?.removeEventListener("abort", close);
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname === `${threadPath}/turns` && init?.method === "POST")
        return json(
          await durable.client.startTurn(
            settlementThreadId,
            JSON.parse(String(init.body)),
            "fixture-turn",
          ),
        );
      const match = /^\/api\/v1\/runs\/([^/]+)(\/events|\/plan)?$/u.exec(
        url.pathname,
      );
      if (match) {
        const runId = match[1]!;
        if (match[2] === "/events") {
          const cursor = Number(
            new Headers(init?.headers).get("last-event-id") ?? 0,
          );
          cursors.push(cursor);
          return feed.open(cursor, init?.signal);
        }
        if (match[2] === "/plan")
          return json(await durable.client.getRunPlan(runId));
        return json(await durable.client.getRun(runId));
      }
      const boundRun = /^\/api\/v1\/threads\/[^/]+\/runs\/([^/]+)$/u.exec(
        url.pathname,
      );
      if (boundRun)
        return json(
          await durable.client.getRunInThread(settlementThreadId, boundRun[1]!),
        );
      throw new Error(`unexpected_live_stream_request:${url.pathname}`);
    },
  });
  return {
    client,
    cursors,
    feed,
    complete: durable.complete,
    transcript: durable.transcript,
    close() {
      feed.disconnect();
      streams.forEach((close) => close());
    },
  };
}

it("renders 500 live HTTP deltas including standalone spaces and newlines through reconnect before terminal history exists", async () => {
  const fixture = liveHttpFixture();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const notice = vi.fn();
  let state!: ReturnType<typeof useAppThreadState>;
  let authority!: ReturnType<typeof useControlThreadRuntime>;
  const commits: Array<{ received: string; displayed: string }> = [];
  function View() {
    state = useAppThreadState();
    authority = useControlThreadRuntime({
      ...state,
      client: fixture.client,
      manageThreads: true,
      setThreadGoal() {},
      setNotice: notice,
    });
    const shell = commandShellRuntimeState({
      ...state,
      activeTurnId: null,
      renderCommandShell: true,
      selectedThread:
        state.threads.find((thread) => thread.id === state.selectedThreadId) ??
        null,
    });
    useLayoutEffect(() => {
      if (shell.streamingText)
        commits.push({
          received: shell.streamingText,
          displayed: container.textContent ?? "",
        });
    });
    return shell.selectedThread ? (
      <StreamingTextScope presentation={state.streamingTextPresentation}>
        <CommandThreadRoom
          {...shell}
          selectedThread={shell.selectedThread}
          cwd=""
          locale="en"
          workMode="code"
          onModeChange={() => {}}
        />
      </StreamingTextScope>
    ) : null;
  }
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <View />
        </StrictMode>,
      ),
    );
    await vi.waitFor(() => expect(authority.connected).toBe(true));
    let runId!: string;
    await act(async () => {
      state.setSelectedThreadId(settlementThreadId);
      const thread = await authority.runtime!.readThread(settlementThreadId);
      state.setThreads([thread]);
      const started = await authority.runtime!.startTurn(
        settlementThreadId,
        "Write 100 numbered lines",
      );
      runId = started.turn.id;
    });
    await vi.waitFor(() => expect(fixture.cursors).toEqual([0]));
    expect(state.selectedThreadId).toBe(settlementThreadId);
    expect(state.threads.map((thread) => thread.id)).toEqual([
      settlementThreadId,
    ]);
    const deltas = Array.from(
      { length: 500 },
      (_, index) =>
        [
          "This is line",
          " ",
          `${Math.floor(index / 5) + 1}:片段😀`,
          "\n",
          "\t",
        ][index % 5]!,
    );
    let expected = "";
    async function publish(from: number, through: number) {
      await act(async () => {
        for (let index = from; index < through; index++) {
          expected += deltas[index]!;
          fixture.feed.send(settlementDelta(runId, index + 2, deltas[index]!));
        }
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(state.streamingTextByThread[settlementThreadId]).toBe(expected);
      });
    }
    await act(async () =>
      fixture.feed.send({
        eventId: `${runId}:segment`,
        runId,
        sequence: 1,
        occurredAt: settlementTime,
        type: "segment.started",
        data: { segmentId: `${runId}:segment`, attempt: 1 },
      }),
    );
    await publish(0, 1);
    expect(container.textContent).toContain("This is line");
    await publish(1, 2);
    expect(state.streamingTextByThread[settlementThreadId]).toBe(
      "This is line ",
    );
    await publish(2, 4);
    expect(state.streamingTextByThread[settlementThreadId]).toBe(
      "This is line 1:片段😀\n",
    );
    await publish(4, 250);
    expect(container.textContent).toContain("This is line 50:片段😀");
    await act(async () => fixture.feed.disconnect());
    await vi.waitFor(() => expect(fixture.cursors).toEqual([0, 251]), {
      timeout: 5_000,
    });
    await publish(250, 500);
    expect(container.textContent).toContain("This is line 100:片段😀");
    expect((await fixture.client.getRun(runId)).run.status).toBe("running");
    expect(
      fixture.transcript().messageWindow.data.map((message) => message.role),
    ).toEqual(["user"]);
    expect(
      commits.some(
        ({ received, displayed }) =>
          received === expected &&
          displayed.includes("This is line 100:片段😀"),
      ),
    ).toBe(true);
    expect(notice).not.toHaveBeenCalled();
    await act(async () => {
      const run = fixture.complete(runId, expected, 502);
      run.revision = 502;
      fixture.feed.finish(settlementCompleted(runId, 502));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(state.streamingTextByThread[settlementThreadId]).toBeUndefined();
      expect(state.threads[0]?.turns[0]?.status).toBe("completed");
    });
    expect(
      container.querySelectorAll('article[data-kind="agentMessage"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("This is line 100:片段😀");
  } finally {
    await act(async () => root.unmount());
    fixture.close();
    container.remove();
  }
}, 15_000);
