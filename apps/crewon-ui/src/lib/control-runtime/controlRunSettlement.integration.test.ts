import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
} from "@crewon/contracts";
import {
  ControlThreadRuntime,
  type ControlThreadRuntimeConfig,
} from "./controlThreadRuntime";
import { synchronizeControlRun } from "./controlRunSettlement";
import {
  applyControlToolEvent,
  createControlToolProjectionState,
} from "./controlRunToolProjection";
import { waitForControlTranscriptRead } from "./controlTranscriptReads";
import {
  settlementCallbacks,
  settlementClient,
  settlementCompleted,
  settlementDeferred,
  settlementDelta,
  settlementFeed,
  settlementThreadId,
  settlementTime,
  settlementToolCompleted,
  settlementToolRequested,
  waitForSettlementAbort,
} from "./controlRunSettlement.test-support";

const runtimes: ControlThreadRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
});

function fixture(
  options: Partial<ControlThreadRuntimeConfig> = {},
  presentation: { beforePublish?: () => Promise<void> } = {},
) {
  const state = settlementClient();
  const callbacks = settlementCallbacks();
  const feeds = new Map<string, ReturnType<typeof settlementFeed>>();
  const feed = (runId: string) => {
    let value = feeds.get(runId);
    if (!value) {
      value = settlementFeed();
      feeds.set(runId, value);
    }
    return value;
  };
  const runtime = new ControlThreadRuntime(
    {
      client: state.client,
      eventStream: (_client, input) => feed(input.runId).stream(input.signal),
      threadEventStream: async function* (_client, input) {
        await waitForSettlementAbort(input.signal);
      },
      runStatusPollDelay: waitForSettlementAbort,
      canonicalSyncRetryDelay: async (_attempt, signal) => {
        if (!signal.aborted)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      reconnectDelay: async (_attempt, signal) => {
        if (!signal.aborted)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },
      ...options,
    },
    { ...callbacks, onBeforeRunSettled: presentation.beforePublish },
  );
  runtimes.push(runtime);
  return { state, callbacks, runtime, feed };
}

async function tick() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function hasCanonicalAnswer(thread: Thread, runId: string, text: string) {
  return thread.turns.some(
    (turn) =>
      turn.id === runId &&
      turn.items.some(
        (item) => item.type === "agentMessage" && item.text === text,
      ),
  );
}

describe("Run terminal receipt and canonical transcript settlement", () => {
  it("publishes the terminal receipt while canonical HTTP is pending and keeps received text", async () => {
    const { state, callbacks, runtime, feed } = fixture();
    const release = settlementDeferred<ReturnType<typeof state.snapshot>>();
    state.client.getThreadTranscriptSnapshot.mockImplementation(
      () => release.promise,
    );
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "First question",
    );
    state.complete(turn.id);
    feed(turn.id).emit(settlementDelta(turn.id, 1, "Received draft"));
    feed(turn.id).emit(settlementCompleted(turn.id));

    await vi.waitFor(() =>
      expect(callbacks.onRunTerminal).toHaveBeenCalledExactlyOnceWith(
        settlementThreadId,
        turn.id,
        expect.objectContaining({
          status: "completed",
          lastSequence: 2,
          terminalAt: settlementTime,
        }),
      ),
    );
    expect(state.client.getThreadTranscriptSnapshot).toHaveBeenCalledOnce();
    expect(callbacks.onTextDelta).toHaveBeenCalledWith(
      settlementThreadId,
      "Received draft",
    );
    expect(callbacks.onTextReset).not.toHaveBeenCalled();
    expect(callbacks.onRunSettled).not.toHaveBeenCalled();

    release.resolve(state.snapshot());
    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledExactlyOnceWith(
        settlementThreadId,
        turn.id,
      ),
    );
    expect(
      callbacks.onThread.mock.calls.some(([thread]) =>
        hasCanonicalAnswer(thread, turn.id, "Canonical answer"),
      ),
    ).toBe(true);
    expect(callbacks.onTextReset).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
    );
    expect(state.client.getRunPlan).not.toHaveBeenCalled();
  });

  it("retries a failed canonical read without restarting the model or repeating the terminal receipt", async () => {
    const { state, callbacks, runtime, feed } = fixture();
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Retry only the read",
    );
    state.complete(turn.id);
    state.client.getThread.mockRejectedValueOnce(
      new Error("temporary canonical read failure"),
    );
    feed(turn.id).emit(settlementDelta(turn.id, 1, "Retained answer"));
    feed(turn.id).emit(settlementCompleted(turn.id));

    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledExactlyOnceWith(
        settlementThreadId,
        turn.id,
      ),
    );
    expect(callbacks.onRunTerminal).toHaveBeenCalledOnce();
    expect(state.client.startTurn).toHaveBeenCalledOnce();
    expect(state.client.getThread.mock.calls.length).toBeGreaterThan(2);
    expect(callbacks.onTextDelta).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
      "Retained answer",
    );
    expect(callbacks.onTextReset).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
    );
  });

  it("publishes one terminal receipt when polling and SSE complete the same Run together", async () => {
    const poll = settlementDeferred<void>();
    const { state, callbacks, runtime, feed } = fixture({
      runStatusPollDelay: (signal) =>
        Promise.race([poll.promise, waitForSettlementAbort(signal)]),
    });
    const canonical = settlementDeferred<ReturnType<typeof state.snapshot>>();
    state.client.getThreadTranscriptSnapshot.mockImplementation(
      () => canonical.promise,
    );
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Complete once",
    );
    state.complete(turn.id, "One durable answer", 1);
    feed(turn.id).emit(settlementCompleted(turn.id, 1));
    poll.resolve();

    await vi.waitFor(() =>
      expect(callbacks.onRunTerminal).toHaveBeenCalledOnce(),
    );
    canonical.resolve(state.snapshot());
    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledOnce(),
    );
    await tick();
    expect(callbacks.onRunTerminal).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
      turn.id,
      expect.objectContaining({ status: "completed", lastSequence: 1 }),
    );
    expect(state.client.startTurn).toHaveBeenCalledOnce();
  });

  it("aborts the live SSE reader before terminal polling opens a recovery stream", async () => {
    const poll = settlementDeferred<void>();
    const live = settlementDeferred<void>();
    let liveSignal: AbortSignal | undefined;
    let streams = 0;
    const order: string[] = [];
    const { state, callbacks, runtime } = fixture({
      runStatusPollDelay: (signal) =>
        Promise.race([poll.promise, waitForSettlementAbort(signal)]),
      eventStream: async function* (_client, input) {
        streams += 1;
        if (streams === 1) {
          liveSignal = input.signal;
          input.signal?.addEventListener(
            "abort",
            () => order.push("live aborted"),
            { once: true },
          );
          yield settlementDelta(input.runId, 1, "A");
          live.resolve();
          await waitForSettlementAbort(input.signal);
          return;
        }
        order.push("backfill started");
        expect(liveSignal?.aborted).toBe(true);
        expect(input.afterSequence).toBe(1);
        yield settlementDelta(input.runId, 2, "B");
        yield settlementCompleted(input.runId, 3);
      },
    });
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Recover missing events",
    );
    await live.promise;
    state.complete(turn.id, "AB", 3);
    poll.resolve();

    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledOnce(),
    );
    expect(order).toEqual(["live aborted", "backfill started"]);
    expect(streams).toBe(2);
    expect(callbacks.onRunTerminal).toHaveBeenCalledOnce();
    expect(callbacks.onTextDelta.mock.calls).toEqual([
      [settlementThreadId, "A"],
      [settlementThreadId, "B"],
    ]);
    expect(state.client.startTurn).toHaveBeenCalledOnce();
  });

  it("settles an older Run without replacing the newer Run presentation", async () => {
    const { state, callbacks, runtime, feed } = fixture();
    const releaseOld =
      settlementDeferred<ReturnType<typeof state.snapshot>>();
    state.client.getThreadTranscriptSnapshot.mockImplementationOnce(
      () => releaseOld.promise,
    );
    const first = await runtime.startTurn(settlementThreadId, "Older question");
    state.complete(first.turn.id, "Older durable answer");
    const oldTranscript = state.snapshot();
    feed(first.turn.id).emit(settlementDelta(first.turn.id, 1, "Older draft"));
    feed(first.turn.id).emit(settlementCompleted(first.turn.id));
    await vi.waitFor(() =>
      expect(callbacks.onRunTerminal).toHaveBeenCalledOnce(),
    );
    expect(callbacks.onRunTerminal).toHaveBeenCalledWith(
      settlementThreadId,
      first.turn.id,
      expect.objectContaining({
        draftPreview: {
          localId: `pending-reply:${first.turn.id}`,
          text: "Older draft",
          partial: false,
        },
      }),
    );
    await vi.waitFor(() =>
      expect(state.client.getThreadTranscriptSnapshot).toHaveBeenCalledOnce(),
    );

    const second = await runtime.startTurn(
      settlementThreadId,
      "Newer question",
    );
    feed(second.turn.id).emit(
      settlementDelta(second.turn.id, 1, "Newer draft"),
    );
    await vi.waitFor(() =>
      expect(callbacks.onTextDelta).toHaveBeenCalledWith(
        settlementThreadId,
        "Newer draft",
      ),
    );
    callbacks.onThread.mockClear();
    callbacks.onTextReset.mockClear();
    releaseOld.resolve(oldTranscript);

    await vi.waitFor(() =>
      expect(callbacks.onTurnSettled).toHaveBeenCalledWith(
        settlementThreadId,
        expect.objectContaining({ id: first.turn.id, status: "completed" }),
      ),
    );
    expect(callbacks.onThread).not.toHaveBeenCalled();
    expect(callbacks.onTextReset).not.toHaveBeenCalled();
    expect(callbacks.onRunSettled).toHaveBeenCalledWith(
      settlementThreadId,
      first.turn.id,
    );
    expect(callbacks.onRunSettled).not.toHaveBeenCalledWith(
      settlementThreadId,
      second.turn.id,
    );
    expect(state.client.startTurn).toHaveBeenCalledTimes(2);
  });

  it("publishes canonical output without waiting for an optional history stream and aborts that stream", async () => {
    const poll = settlementDeferred<void>();
    const live = settlementDeferred<void>();
    const replay = settlementDeferred<void>();
    const replayAborted = settlementDeferred<void>();
    let liveSignal: AbortSignal | undefined;
    let replaySignal: AbortSignal | undefined;
    let streams = 0;
    const order: string[] = [];
    const { state, callbacks, runtime } = fixture({
      runStatusPollDelay: (signal) =>
        Promise.race([poll.promise, waitForSettlementAbort(signal)]),
      eventStream: async function* (_client, input) {
        streams += 1;
        if (streams === 1) {
          liveSignal = input.signal;
          input.signal?.addEventListener(
            "abort",
            () => order.push("live aborted"),
            { once: true },
          );
          yield settlementDelta(input.runId, 1, "Received draft");
          live.resolve();
          await waitForSettlementAbort(input.signal);
          return;
        }
        replaySignal = input.signal;
        order.push("replay started");
        expect(liveSignal?.aborted).toBe(true);
        expect(input.afterSequence).toBe(1);
        replay.resolve();
        await waitForSettlementAbort(input.signal);
        order.push("replay aborted");
        replayAborted.resolve();
      },
    });
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Durable output is independent of optional event history",
    );
    await live.promise;
    state.complete(turn.id, "Immediate durable answer", 3);
    poll.resolve();

    await replay.promise;
    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledExactlyOnceWith(
        settlementThreadId,
        turn.id,
      ),
    );
    await replayAborted.promise;
    expect(order).toEqual(["live aborted", "replay started", "replay aborted"]);
    expect(replaySignal?.aborted).toBe(true);
    expect(callbacks.onRunTerminal).toHaveBeenCalledOnce();
    expect(
      callbacks.onThread.mock.calls.some(([thread]) =>
        hasCanonicalAnswer(thread, turn.id, "Immediate durable answer"),
      ),
    ).toBe(true);
    expect(callbacks.onTextReset).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
    );
    expect(state.client.getRunPlan).not.toHaveBeenCalled();
    expect(state.client.startTurn).toHaveBeenCalledOnce();
    expect(streams).toBe(2);
  });

  it("keeps the draft and canonical actions pending when completed outputRef has no durable message", async () => {
    const retry = settlementDeferred<void>();
    const retryRequested = vi.fn();
    const { state, callbacks, runtime, feed } = fixture({
      canonicalSyncRetryDelay: (attempt, signal) => {
        retryRequested(attempt);
        return Promise.race([retry.promise, waitForSettlementAbort(signal)]);
      },
    });
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Wait for the referenced durable message",
    );
    state.complete(turn.id, "Referenced durable answer");
    const incomplete = state.transcript();
    incomplete.messageWindow.data = incomplete.messageWindow.data.filter(
      (message) => message.role === "user",
    );
    incomplete.runBindings = incomplete.runBindings.filter(
      (binding) => binding.messageId === `${turn.id}:user`,
    );
    state.client.getThreadTranscriptSnapshot.mockResolvedValueOnce({ ...state.snapshot(), transcriptWindow: incomplete });
    state.client.getThreadTranscriptWindow.mockResolvedValueOnce(incomplete);
    feed(turn.id).emit(
      settlementDelta(turn.id, 1, "Preserve this received text"),
    );
    feed(turn.id).emit(settlementCompleted(turn.id));

    await vi.waitFor(() => expect(retryRequested).toHaveBeenCalledOnce());
    expect(callbacks.onRunTerminal).toHaveBeenCalledOnce();
    expect(callbacks.onThread).not.toHaveBeenCalled();
    expect(callbacks.onTurnSettled).not.toHaveBeenCalled();
    expect(callbacks.onTextReset).not.toHaveBeenCalled();
    expect(callbacks.onRunSettled).not.toHaveBeenCalled();
    expect(callbacks.onTextDelta).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
      "Preserve this received text",
    );

    retry.resolve();
    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledExactlyOnceWith(
        settlementThreadId,
        turn.id,
      ),
    );
    expect(
      callbacks.onThread.mock.calls.some(([thread]) =>
        hasCanonicalAnswer(thread, turn.id, "Referenced durable answer"),
      ),
    ).toBe(true);
    expect(callbacks.onTextReset).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
    );
    expect(state.client.startTurn).toHaveBeenCalledOnce();
  });

  it("keeps a recovered successful tool when canonical publication resumes after the drain gate", async () => {
    const poll = settlementDeferred<void>();
    const live = settlementDeferred<void>();
    const recovery = settlementDeferred<void>();
    const releaseRecovery = settlementDeferred<void>();
    const drain = settlementDeferred<void>();
    const releaseDrain = settlementDeferred<void>();
    let streams = 0;
    const { state, callbacks, runtime } = fixture(
      {
        runStatusPollDelay: (signal) =>
          Promise.race([poll.promise, waitForSettlementAbort(signal)]),
        eventStream: async function* (_client, input) {
          streams += 1;
          if (streams === 1) {
            yield settlementToolRequested(input.runId, 1);
            yield settlementDelta(input.runId, 2, "Received answer");
            live.resolve();
            await waitForSettlementAbort(input.signal);
            return;
          }
          recovery.resolve();
          await releaseRecovery.promise;
          yield settlementToolCompleted(input.runId, 3);
          yield settlementCompleted(input.runId, 4);
        },
      },
      {
        beforePublish: async () => {
          drain.resolve();
          await releaseDrain.promise;
        },
      },
    );
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Do not overwrite a recovered successful tool",
    );
    await live.promise;
    state.complete(turn.id, "Canonical answer after workspace verification", 4);
    poll.resolve();
    await recovery.promise;
    await drain.promise;
    expect(callbacks.onRunSettled).not.toHaveBeenCalled();

    releaseRecovery.resolve();
    await vi.waitFor(() =>
      expect(callbacks.onToolItem).toHaveBeenCalledWith(
        settlementThreadId,
        turn.id,
        expect.objectContaining({
          id: `${turn.id}:tool`,
          status: "completed",
          success: true,
        }),
      ),
    );
    releaseDrain.resolve();
    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledOnce(),
    );

    const finalThread = callbacks.onThread.mock.calls.at(-1)?.[0] as Thread;
    expect(
      finalThread.turns.find((item) => item.id === turn.id)?.items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${turn.id}:tool`,
          type: "dynamicToolCall",
          status: "completed",
          success: true,
          contentItems: [{ type: "inputText", text: "Workspace verified" }],
        }),
      ]),
    );
    expect(
      hasCanonicalAnswer(
        finalThread,
        turn.id,
        "Canonical answer after workspace verification",
      ),
    ).toBe(true);
    expect(callbacks.onRunTerminal).toHaveBeenCalledOnce();
    expect(state.client.startTurn).toHaveBeenCalledOnce();
    expect(streams).toBe(2);
  });

  it("settles an older Run outside the latest 50 through an independent older output window", async () => {
    const retryWaiting = settlementDeferred<void>();
    const releaseRetry = settlementDeferred<void>();
    const { state, callbacks, runtime, feed } = fixture({
      canonicalSyncRetryDelay: (_attempt, signal) => {
        retryWaiting.resolve();
        return Promise.race([
          releaseRetry.promise,
          waitForSettlementAbort(signal),
        ]);
      },
    });
    state.client.getThreadTranscriptWindow.mockImplementation(
      async (_threadId, query = {}) => {
        const full = state.transcript();
        const position = parseThreadMessageWindowQuery(
          query,
          settlementThreadId,
        ).position;
        const candidates = full.messageWindow.data.filter(
          (message) =>
            !position ||
            (position.direction === "older"
              ? message.sequence < position.messageSequence
              : message.sequence > position.messageSequence),
        );
        const selected =
          position?.direction === "newer"
            ? candidates.slice(0, query.limit ?? 100)
            : candidates.slice(-(query.limit ?? 100));
        const edgeCursor = (direction: "older" | "newer") => {
          const edge = direction === "older" ? selected[0] : selected.at(-1);
          if (
            !edge ||
            !full.messageWindow.data.some((message) =>
              direction === "older"
                ? message.sequence < edge.sequence
                : message.sequence > edge.sequence,
            )
          )
            return null;
          return formatThreadMessageWindowCursor(settlementThreadId, {
            direction,
            threadRevision: full.messageWindow.threadRevision,
            messageSequence: edge.sequence,
          });
        };
        return {
          ...full,
          messageWindow: {
            ...full.messageWindow,
            data: selected,
            olderCursor: edgeCursor("older"),
            newerCursor: edgeCursor("newer"),
          },
          runBindings: selected.map(
            (message) =>
              full.runBindings.find(
                (binding) => binding.messageId === message.messageId,
              )!,
          ),
        };
      },
    );
    const first = await runtime.startTurn(
      settlementThreadId,
      "Older delayed synchronization",
    );
    state.complete(first.turn.id, "Located durable old output");
    state.client.getThread.mockRejectedValueOnce(
      new Error("hold the older canonical attempt"),
    );
    feed(first.turn.id).emit(
      settlementDelta(first.turn.id, 1, "Retain older preview"),
    );
    feed(first.turn.id).emit(settlementCompleted(first.turn.id));
    await retryWaiting.promise;

    // These are fake server receipts; no models or network requests execute.
    for (let index = 0; index < 51; index++) {
      const next = await runtime.startTurn(
        settlementThreadId,
        `Later question ${index}`,
      );
      state.complete(next.turn.id, `Later durable answer ${index}`, 1);
      feed(next.turn.id).emit(settlementCompleted(next.turn.id, 1));
      await vi.waitFor(
        () =>
          expect(callbacks.onRunSettled).toHaveBeenCalledWith(
            settlementThreadId,
            next.turn.id,
          ),
        { interval: 1 },
      );
    }
    expect(callbacks.onRunSettled).not.toHaveBeenCalledWith(
      settlementThreadId,
      first.turn.id,
    );
    expect(callbacks.onRunTerminal).toHaveBeenCalledWith(
      settlementThreadId,
      first.turn.id,
      expect.objectContaining({
        draftPreview: expect.objectContaining({
          text: "Retain older preview",
          partial: false,
        }),
      }),
    );
    callbacks.onThread.mockClear();
    callbacks.onTurnSettled.mockClear();
    const firstLookupCall =
      state.client.getThreadTranscriptWindow.mock.calls.length;
    releaseRetry.resolve();

    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledWith(
        settlementThreadId,
        first.turn.id,
      ),
    );
    const oldTurn = callbacks.onTurnSettled.mock.calls.find(
      ([_threadId, turn]) => turn.id === first.turn.id,
    )?.[1];
    expect(oldTurn?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agentMessage",
          id: `${first.turn.id}:assistant`,
          text: "Located durable old output",
        }),
      ]),
    );
    const lookupCalls =
      state.client.getThreadTranscriptWindow.mock.calls.slice(firstLookupCall);
    expect(
      lookupCalls.some(
        ([_id, query]) =>
          query?.limit === 100 && typeof query.cursor === "string",
      ),
    ).toBe(true);
    expect(callbacks.onThread).not.toHaveBeenCalled();
  });

  it("does not mutate requested tool sequence on optional recovery timeout so a later completion can succeed", async () => {
    const state = settlementClient();
    const controller = new AbortController();
    const toolState = createControlToolProjectionState();
    applyControlToolEvent(
      toolState,
      settlementToolRequested("timed-out-run", 1),
    );
    const canonical = settlementDeferred<Thread>();
    const onToolItem = vi.fn();
    const synchronized = synchronizeControlRun({
      client: state.client,
      eventStream: async function* (_client, input) {
        await waitForSettlementAbort(input.signal);
      },
      threadId: settlementThreadId,
      runId: "timed-out-run",
      terminal: {
        status: "completed",
        lastSequence: 3,
        terminalAt: settlementTime,
      },
      signal: controller.signal,
      toolHistoryTimeoutMs: 5,
      toolState,
      taskChangeState: undefined,
      sequence: () => 1,
      advanceSequence: vi.fn(),
      isCurrent: () => !controller.signal.aborted,
      presentsThread: () => true,
      onDraftEvent: vi.fn(),
      onToolItem,
      onCoverage: vi.fn(),
      readCanonical: () =>
        waitForControlTranscriptRead(canonical.promise, controller.signal),
      beforePublish: async () => {},
      publish: vi.fn(),
      onSynchronized: vi.fn(),
    });
    try {
      await vi.waitFor(
        () =>
          expect(onToolItem).toHaveBeenCalledWith(
            expect.objectContaining({ status: "failed" }),
          ),
        { interval: 1 },
      );
      expect(toolState.get("timed-out-run:tool")).toMatchObject({
        lastSequence: 1,
        item: { status: "inProgress" },
      });
      const completed = applyControlToolEvent(
        toolState,
        settlementToolCompleted("timed-out-run", 2),
      );
      expect(completed).toMatchObject({ status: "completed", success: true });
      expect(toolState.get("timed-out-run:tool")?.lastSequence).toBe(2);
    } finally {
      controller.abort();
      await synchronized;
    }
  });

  it("cancels a pending canonical read at rollback and never revives its removed Run", async () => {
    const { state, callbacks, runtime, feed } = fixture();
    const releaseOld =
      settlementDeferred<ReturnType<typeof state.snapshot>>();
    let pendingSignal: AbortSignal | undefined;
    state.client.getThreadTranscriptSnapshot.mockImplementationOnce(
      (_threadId, _query, request) => {
        pendingSignal = request?.signal;
        return releaseOld.promise;
      },
    );
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Will be rolled back",
    );
    state.complete(turn.id);
    const removedTranscript = state.snapshot();
    feed(turn.id).emit(settlementDelta(turn.id, 1, "Removed draft"));
    feed(turn.id).emit(settlementCompleted(turn.id));
    await vi.waitFor(() =>
      expect(callbacks.onRunTerminal).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(state.client.getThreadTranscriptSnapshot).toHaveBeenCalledOnce(),
    );

    const rolledBack = await runtime.rollbackThread(settlementThreadId);
    expect(rolledBack.turns).toEqual([]);
    expect(pendingSignal?.aborted).toBe(true);
    callbacks.onThread.mockClear();
    callbacks.onTurnSettled.mockClear();
    callbacks.onRunSettled.mockClear();
    releaseOld.resolve(removedTranscript);
    await tick();
    await tick();

    expect(callbacks.onThread).not.toHaveBeenCalled();
    expect(callbacks.onTurnSettled).not.toHaveBeenCalled();
    expect(callbacks.onRunSettled).not.toHaveBeenCalled();
    expect(state.client.rollbackThread).toHaveBeenCalledOnce();
    expect(state.client.startTurn).toHaveBeenCalledOnce();
  });

  it("replaces the provisional draft with the validated durable message before clearing text", async () => {
    const { state, callbacks, runtime, feed } = fixture();
    const { turn } = await runtime.startTurn(
      settlementThreadId,
      "Canonical replacement",
    );
    state.complete(turn.id, "Validated durable message");
    feed(turn.id).emit(
      settlementDelta(turn.id, 1, "Provisional transport text"),
    );
    feed(turn.id).emit(settlementCompleted(turn.id));

    await vi.waitFor(() =>
      expect(callbacks.onRunSettled).toHaveBeenCalledOnce(),
    );
    const threads = callbacks.onThread.mock.calls.map(
      ([thread]) => thread as Thread,
    );
    expect(threads.at(-1)?.turns).toEqual([
      expect.objectContaining({
        id: turn.id,
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({
            id: `${turn.id}:assistant`,
            type: "agentMessage",
            text: "Validated durable message",
          }),
        ]),
      }),
    ]);
    expect(callbacks.onRunTerminal.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.onThread.mock.invocationCallOrder.at(-1)!,
    );
    expect(callbacks.onThread.mock.invocationCallOrder.at(-1)).toBeLessThan(
      callbacks.onTextReset.mock.invocationCallOrder[0]!,
    );
    expect(callbacks.onTextReset.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.onRunSettled.mock.invocationCallOrder[0]!,
    );
    expect(callbacks.onTextDelta).toHaveBeenCalledExactlyOnceWith(
      settlementThreadId,
      "Provisional transport text",
    );
    expect(state.client.getRunPlan).not.toHaveBeenCalled();
  });
});
