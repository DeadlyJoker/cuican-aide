// @vitest-environment happy-dom
import { act, StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { RunEventView } from "@crewon/contracts";
import { useControlThreadRuntime } from "./useControlThreadRuntime";
import { controlThreadHasPendingCanonicalSync } from "./controlRunTerminalPresentation";
import {
  transcriptFixture,
  transcriptRun,
} from "./controlTranscriptWindow.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it.each(["terminal event", "closed stream"])(
  "shows the terminal receipt before drain and publishes canonical output once after a %s",
  async (source) => {
    const h = await harness();
    try {
      await h.open();
      expect(h.deltas).toHaveBeenCalledWith("thread-1", "Answer");
      await act(async () => {
        h.complete();
        if (source === "terminal event") h.sendTerminal();
        else h.closeStream();
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(h.drain).toHaveBeenCalledOnce();
      });
      expect(h.read).toHaveBeenCalledTimes(2);
      // A trusted terminal receipt ends execution immediately. Only delivery of
      // the canonical assistant Message waits for the existing text drain.
      expect(h.shown()[0]!.turns[0]!.status).toBe("completed");
      expect(h.active()).toEqual({ other: "run-other" });
      expect(controlThreadHasPendingCanonicalSync(h.shown()[0]!)).toBe(true);
      expect(
        h
          .shown()[0]!
          .turns[0]!.items.filter((item) => item.type === "agentMessage"),
      ).toHaveLength(0);
      const resetsBeforeDrain = h.reset.mock.calls.length;
      await act(async () => h.releaseDrain());
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(h.active()).toEqual({ other: "run-other" });
        expect(controlThreadHasPendingCanonicalSync(h.shown()[0]!)).toBe(false);
        expect(
          h
            .shown()[0]!
            .turns[0]!.items.filter((item) => item.type === "agentMessage"),
        ).toHaveLength(1);
      });
      expect(h.shown()[0]!.turns[0]).toMatchObject({
        id: "run-1",
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: "Answer" }),
        ]),
      });
      expect(h.shown()[0]!.turns[0]).not.toHaveProperty("controlCanonicalSyncPending", true);
      expect(h.shown()[0]!.turns[0]).not.toHaveProperty("controlPendingReplyDraft");
      expect(h.read).toHaveBeenCalledTimes(2);
      expect(h.reset).toHaveBeenCalledTimes(resetsBeforeDrain + 1);
      expect(h.notice).not.toHaveBeenCalled();
      expect(h.fixture.mutations).toHaveLength(0);
    } finally {
      await h.dispose();
    }
  },
);

it.each(["canonical read", "startTurn"])(
  "keeps a successor from %s visible when the previous text drain finishes late",
  async (source) => {
    const h = await harness();
    const successorId =
      source === "canonical read" ? "run-2" : "run-replacement";
    try {
      await h.open();
      const previousSignal = h.streamSignal();
      await act(async () => {
        h.complete();
        h.sendTerminal();
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(h.drain).toHaveBeenCalledOnce();
      });
      await act(async () => {
        if (source === "canonical read") {
          h.advanceRun();
          await h.runtime().readThread("thread-1");
        } else await h.startSuccessor();
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(h.deltas).toHaveBeenCalledWith("thread-1", "Next answer");
      });
      const resetsBeforeDrain = h.reset.mock.calls.length;
      expect(h.shown()[0]!.turns.map((turn) => turn.id)).toEqual([
        "run-1",
        successorId,
      ]);
      await act(async () => h.releaseDrain());
      expect(h.shown()[0]!.turns.map((turn) => turn.id)).toEqual([
        "run-1",
        successorId,
      ]);
      expect(h.shown()[0]!.turns[0]).toMatchObject({
        status: "completed",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "agentMessage", text: "Answer" }),
        ]),
      });
      expect(h.shown()[0]!.turns[1]!.status).toBe("inProgress");
      expect(h.active()).toEqual({
        "thread-1": successorId,
        "other": "run-other",
      });
      expect(h.reset).toHaveBeenCalledTimes(resetsBeforeDrain);
      expect(previousSignal.aborted).toBe(true);
      expect(h.streamSignal().aborted).toBe(false);
      expect(h.fixture.mutations).toHaveLength(
        source === "canonical read" ? 0 : 1,
      );
    } finally {
      await h.dispose();
    }
  },
);

it("adopts a successor first discovered by the previous Run's final read", async () => {
  const h = await harness();
  try {
    await h.open();
    await act(async () => {
      h.complete();
      h.advanceRun();
      h.sendTerminal();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(h.deltas).toHaveBeenCalledWith("thread-1", "Next answer");
    });
    expect(h.shown()[0]!.turns.map((turn) => [turn.id, turn.status])).toEqual([
      ["run-1", "completed"],
      ["run-2", "inProgress"],
    ]);
    expect(h.active()).toEqual({ "thread-1": "run-2", "other": "run-other" });
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.notice).not.toHaveBeenCalled();
    expect(h.fixture.mutations).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it.each(["active Run", "optional Plan"])(
  "rejects an old %s read when a new compaction Run is adopted without changing the Thread revision",
  async (phase) => {
    const h = await harness();
    let release!: () => void;
    try {
      await h.open();
      h.complete();
      let captured = false;
      async function hold<T>(promise: Promise<T>): Promise<T> {
        const response = await promise;
        captured = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return response;
      }
      if (phase === "active Run") {
        const original = h.fixture.client.getThreadTranscriptSnapshot.bind(
          h.fixture.client,
        );
        vi.spyOn(h.fixture.client, "getThreadTranscriptSnapshot").mockImplementationOnce(
          (...args) => hold(original(...args)),
        );
      } else {
        const original = h.fixture.client.getRunPlan.bind(h.fixture.client);
        vi.spyOn(h.fixture.client, "getRunPlan").mockImplementationOnce(
          (...args) => hold(original(...args)),
        );
      }
      const stale = h
        .runtime()
        .readThread("thread-1")
        .then(
          (thread) => ({ thread }),
          (error: unknown) => ({ error }),
        );
      await vi.waitFor(() => expect(captured).toBe(true));
      const revision = h.fixture.thread.revision;
      vi.spyOn(h.fixture.client, "compactThread").mockImplementation(
        async () => {
          const run = {
            ...transcriptRun("run-compact", true),
            purpose: "manualCompaction" as const,
            status: "queued" as const,
          };
          h.fixture.setActive(run);
          return { disposition: "committed" as const, run };
        },
      );
      await act(async () => {
        await h.runtime().compactThread("thread-1");
      });
      expect(h.fixture.thread.revision).toBe(revision);
      let outcome: Awaited<typeof stale> | undefined;
      await act(async () => {
        release();
        outcome = await stale;
      });
      expect(outcome).toMatchObject({
        error: { message: "control_thread_projection_superseded" },
      });
      expect(h.streamSignal().aborted).toBe(false);
      await act(async () => {
        await h.runtime().readThread("thread-1");
      });
      expect(h.streamSignal().aborted).toBe(false);
    } finally {
      release?.();
      await h.dispose();
    }
  },
);

it("ignores old draft frames after a new start while still settling the old durable Turn", async () => {
  const h = await harness();
  try {
    await h.open();
    const old = h.captureStream();
    let resetsAfterHandoff = 0;
    await act(async () => {
      h.complete(3);
      await h.startSuccessor();
      resetsAfterHandoff = h.reset.mock.calls.length;
      old.delta(2, "Late old text");
      old.terminal(3);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(h.shown()[0]!.turns[0]!.status).toBe("completed");
    });
    expect(h.deltas.mock.calls).toEqual([
      ["thread-1", "Answer"],
      ["thread-1", "Next answer"],
    ]);
    expect(h.shown()[0]!.turns.map((turn) => turn.id)).toEqual([
      "run-1",
      "run-replacement",
    ]);
    expect(h.active()).toEqual({
      "thread-1": "run-replacement",
      "other": "run-other",
    });
    expect(h.reset).toHaveBeenCalledTimes(resetsAfterHandoff);
    expect(old.signal.aborted).toBe(true);
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.notice).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it.each(["stream", "status"])(
  "recovers %s failures without canceling a foreground refresh or replaying output",
  async (source) => {
    const h = await harness();
    let releasePlan!: () => void;
    try {
      await h.open();
      const plan = { runId: "run-1", eventSequence: 1, plan: null };
      let planSignal: AbortSignal | undefined;
      vi.spyOn(h.fixture.client, "getRunPlan").mockImplementationOnce(
        (_runId, options) => {
          planSignal = options?.signal;
          return new Promise((resolve) => {
            releasePlan = () => resolve(plan);
          });
        },
      );
      const foreground = h
        .runtime()
        .readThread("thread-1")
        .then(
          (thread) => ({ thread }),
          (error: unknown) => ({ error }),
        );
      await vi.waitFor(() => expect(planSignal).toBeDefined());
      for (
        let attempt = 1;
        attempt <= (source === "stream" ? 3 : 1);
        attempt++
      ) {
        await act(async () => {
          if (source === "stream") h.failStream();
          else
            vi.mocked(h.fixture.client.getRun).mockRejectedValueOnce(
              new Error("fixture_status_offline"),
            );
        });
        await vi.waitFor(async () => {
          await act(async () => {});
          expect(h.notice).toHaveBeenCalledTimes(attempt);
        });
        expect(planSignal!.aborted).toBe(false);
        expect(h.read).toHaveBeenCalledTimes(2);
        if (source === "stream") {
          await vi.waitFor(
            async () => {
              await act(async () => {});
              expect(h.fixture.client.openRunEventStream).toHaveBeenCalledTimes(
                attempt + 1,
              );
            },
            { timeout: 2000 },
          );
        }
      }
      expect(
        vi
          .mocked(h.fixture.client.openRunEventStream)
          .mock.calls.map(([input]) => input.afterSequence),
      ).toEqual(source === "stream" ? [0, 1, 1, 1] : [0]);
      expect(h.deltas).toHaveBeenCalledTimes(1);
      let result: Awaited<typeof foreground> | undefined;
      await act(async () => {
        releasePlan();
        result = await foreground;
      });
      expect(result).toMatchObject({ thread: { id: "thread-1" } });
      await act(async () => {
        h.complete();
        h.sendTerminal();
        h.releaseDrain();
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(h.shown()[0]!.turns[0]!.status).toBe("completed");
      });
      expect(h.read).toHaveBeenCalledTimes(3);
      expect(h.active()).toEqual({ other: "run-other" });
      expect(h.fixture.mutations).toHaveLength(0);
    } finally {
      releasePlan?.();
      await h.dispose();
    }
  },
);

it("does not supersede the canonical refresh that retires an old Run stream", async () => {
  const h = await harness();
  try {
    await h.open();
    h.complete();
    let refreshed: Thread | undefined;
    await act(async () => {
      refreshed = await h
        .runtime()
        .readThread("thread-1", { toolHistoryMode: "skip" });
    });
    expect(refreshed!.turns[0]!.status).toBe("completed");
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.active()).toEqual({ other: "run-other" });
    expect(h.streamSignal().aborted).toBe(true);
    expect(h.notice).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

it("keeps incomplete final history visible without immediately retrying the whole Thread", async () => {
  const h = await harness({ finalHistory: "unavailable" });
  try {
    await h.open();
    await act(async () => {
      h.complete();
      h.closeStream();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(h.drain).toHaveBeenCalledOnce();
    });
    await act(async () => h.releaseDrain());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(h.active()).toEqual({ other: "run-other" });
    });
    expect(h.shown()[0]).toMatchObject({
      controlTranscriptWindow: { toolHistory: "partial" },
      turns: [
        expect.objectContaining({ status: "completed", itemsView: "summary" }),
      ],
    });
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.fixture.client.openRunEventStream).toHaveBeenCalledTimes(2);
    expect(h.fixture.mutations).toHaveLength(0);
  } finally {
    await h.dispose();
  }
});

it("uses the rollback owner's refresh after stopping its Run stream", async () => {
  const h = await harness();
  try {
    await h.open();
    h.complete();
    let rolledBack: Thread | undefined;
    await act(async () => {
      rolledBack = await h.runtime().rollbackThread("thread-1", 1);
    });
    expect(rolledBack!.turns).toEqual([]);
    expect(h.shown()[0]!.turns).toEqual([]);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.fixture.mutations).toHaveLength(1);
    expect(h.fixture.mutations[0]!.path).toMatch(/:rollback$/);
    expect(h.active()).toEqual({ other: "run-other" });
    expect(h.streamSignal().aborted).toBe(true);
    expect(h.notice).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

async function harness(options: { finalHistory?: "unavailable" } = {}) {
  const fixture = transcriptFixture(1);
  fixture.runtime.close();
  let run = transcriptRun("run-1", true);
  fixture.setActive(run);
  vi.spyOn(fixture.client, "getRun").mockImplementation(async (runId) => ({
    run: runId === run.runId ? run : transcriptRun(runId, true),
  }));
  vi.spyOn(fixture.client, "listThreads").mockResolvedValue({
    data: [fixture.thread],
    nextCursor: null,
  });
  const readWindow = fixture.client.getThreadTranscriptWindow.bind(
    fixture.client,
  );
  vi.spyOn(fixture.client, "getThreadTranscriptWindow").mockImplementation(
    async (...args) => {
      const window = await readWindow(...args);
      return {
        ...window,
        runBindings: window.runBindings.map((binding) =>
          binding.messageId === "replacement-user"
            ? { ...binding, runId: "run-replacement" }
            : binding,
        ),
      };
    },
  );
  const readSnapshot = fixture.client.getThreadTranscriptSnapshot.bind(fixture.client);
  vi.spyOn(fixture.client, "getThreadTranscriptSnapshot").mockImplementation(async (...args) => {
    const snapshot = await readSnapshot(...args);
    const transcriptWindow = { ...snapshot.transcriptWindow, runBindings: snapshot.transcriptWindow.runBindings.map((binding) => binding.messageId === "replacement-user" ? { ...binding, runId: "run-replacement" } : binding) };
    const rows = new Map(snapshot.runs.map((r) => [r.runId, r]));
    rows.set(run.runId, run);
    const ids = new Set(transcriptWindow.runBindings.flatMap((binding) => binding.runId === null ? [] : [binding.runId]));
    if (snapshot.activeRunId) ids.add(snapshot.activeRunId);
    return { ...snapshot, transcriptWindow, runs: [...ids].map((id) => rows.get(id)!) };
  });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let streamRunId!: string;
  let signal!: AbortSignal;
  let closeStream!: () => void;
  let failStream!: () => void;
  const terminal: RunEventView = {
    eventId: "completed-1",
    runId: "run-1",
    sequence: 2,
    occurredAt: "2026-09-11T00:00:01.000Z",
    type: "run.completed",
    data: { outputRef: null },
  };
  const delta: RunEventView = {
    ...terminal,
    eventId: "delta-1",
    sequence: 1,
    type: "model.output.delta",
    data: { segmentId: "segment-1", delta: "Answer" },
  };
  const frame = (event: RunEventView) =>
    new TextEncoder().encode(
      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  vi.spyOn(fixture.client, "openRunEventStream").mockImplementation(
    async (input) => {
      if (
        input.runId === run.runId &&
        run.status === "completed" &&
        options.finalHistory === "unavailable"
      )
        return new Response(null, { status: 503 });
      if (input.runId === run.runId && run.status === "completed")
        return new Response(frame(terminal), {
          headers: { "content-type": "text/event-stream" },
        });
      signal = input.signal!;
      const currentSignal = signal;
      let closed = false;
      let abort!: () => void;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            streamRunId = input.runId;
            if ((input.afterSequence ?? 0) < delta.sequence)
              controller.enqueue(
                frame(
                  input.runId === run.runId
                    ? delta
                    : {
                        ...delta,
                        runId: input.runId,
                        eventId: "delta-next",
                        data: {
                          segmentId: "segment-next",
                          delta: "Next answer",
                        },
                      },
                ),
              );
            const finish = (error?: Error) => {
              if (closed) return;
              closed = true;
              currentSignal.removeEventListener("abort", abort);
              if (error) controller.error(error);
              else controller.close();
            };
            closeStream = abort = () => finish();
            failStream = () => finish(new Error("fixture_stream_disconnected"));
            currentSignal.addEventListener("abort", abort, { once: true });
          },
          cancel() {
            closed = true;
            currentSignal.removeEventListener("abort", abort);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  let releaseDrain!: () => void;
  const drainGate = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const drain = vi.fn(() => drainGate),
    notice = vi.fn(),
    reset = vi.fn(),
    deltas = vi.fn();
  let shown: Thread[] = [],
    active: Record<string, string> = {};
  let authority!: ReturnType<typeof useControlThreadRuntime>;
  let setActiveRun!: (runId: string) => void;
  function View() {
    const [threads, setThreads] = useState<Thread[]>([]);
    const [turns, setActiveTurnByThread] = useState({
      "thread-1": "run-1",
      "other": "run-other",
    } as Record<string, string>);
    shown = threads;
    active = turns;
    setActiveRun = (runId) =>
      setActiveTurnByThread((current) => ({ ...current, "thread-1": runId }));
    authority = useControlThreadRuntime({
      client: fixture.client,
      manageThreads: true,
      selectedThreadId: null,
      selectedThreadIdRef: useRef(null),
      showArchivedThreadsRef: useRef(false),
      setThreads,
      setActiveTurnByThread,
      appendStreamingTextDelta: deltas,
      resetStreamingText: reset,
      setSelectedThreadId() {},
      setThreadGoal() {},
      setNotice: notice,
      waitForStreamingTextDrain: drain,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <StrictMode>
        <View />
      </StrictMode>,
    ),
  );
  const read = vi.spyOn(authority.runtime!, "readThread");
  return {
    fixture,
    read,
    drain,
    notice,
    reset,
    deltas,
    releaseDrain,
    shown: () => shown,
    active: () => active,
    runtime: () => authority.runtime!,
    streamSignal: () => signal,
    async open() {
      await act(async () => {
        await authority.runtime!.readThread("thread-1");
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(deltas).toHaveBeenCalledWith("thread-1", "Answer");
      });
    },
    complete(terminalSequence = 2) {
      run = {
        ...run,
        status: "completed",
        updatedAt: terminal.occurredAt,
        terminalAt: terminal.occurredAt,
        revision: terminalSequence,
        lastSequence: terminalSequence,
      };
      fixture.setActive(null);
      fixture.thread.revision++;
      fixture.thread.lastMessageSequence = 2;
      fixture.messages.push({
        ...fixture.messages[0]!,
        messageId: "answer-1",
        sequence: 2,
        role: "assistant",
        content: "Answer",
      });
    },
    advanceRun() {
      fixture.setActive(transcriptRun("run-2", true));
      fixture.thread.revision++;
      fixture.thread.lastMessageSequence = 3;
      fixture.messages.push({
        ...fixture.messages[0]!,
        messageId: "next-user",
        sequence: 3,
        content: "Next task",
      });
      setActiveRun("run-2");
    },
    async startSuccessor() {
      const response = await authority.runtime!.startTurn(
        "thread-1",
        "Next task",
      );
      setActiveRun(response.turn.id);
      return response.turn.id;
    },
    captureStream() {
      const target = stream,
        runId = streamRunId;
      return {
        signal,
        delta(sequence: number, text: string) {
          target.enqueue(
            frame({
              ...delta,
              runId,
              sequence,
              data: { segmentId: "segment-1", delta: text },
            }),
          );
        },
        terminal(sequence: number) {
          target.enqueue(frame({ ...terminal, runId, sequence }));
        },
      };
    },
    sendTerminal() {
      stream.enqueue(frame(terminal));
    },
    closeStream() {
      closeStream();
    },
    failStream() {
      failStream();
    },
    async dispose() {
      releaseDrain();
      await act(async () => root.unmount());
      vi.restoreAllMocks();
    },
  };
}
