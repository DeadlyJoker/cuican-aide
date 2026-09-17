// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { RunEventView, OfficeThreadResponse } from "@crewon/contracts";
import { createControlCommandOfficeRoomAdapter } from "./ControlCommandOfficeRoomAdapter";
import {
  controlOfficeThreadTitle,
  legacyControlOfficeThreadTitle,
} from "./controlOfficeChatPresentation";
import { ControlThreadRuntime } from "../../lib/control-runtime/controlThreadRuntime";
import { controlHistoryReadBudget } from "../../lib/control-runtime/controlHistoryReadBudget";
import {
  transcriptFixture,
  transcriptRun,
} from "../../lib/control-runtime/controlTranscriptWindow.test-support";

import {
  catalogPage,
  officeAssociation,
  deferred,
  fixture,
  record,
  send,
  thread,
} from "./ControlOfficeThread.test-support";
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not rename or start detail reads when an unmounted Office lookup completes", async () => {
  const f = fixture(),
    lookup = deferred<OfficeThreadResponse>();
  f.client.getOfficeThread.mockReturnValue(lookup.promise);
  try {
    await f.render();
    await f.close();
    await act(async () => lookup.resolve(officeAssociation()));
    expect(f.runtime.renameThread).not.toHaveBeenCalled();
    expect(f.runtime.readThread).not.toHaveBeenCalled();
    expect(f.client.getThreadGoal).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(["unmount", "identity"] as const)(
  "cancels pending Office detail and Goal reads on %s",
  async (change) => {
    const f = fixture(),
      detail = deferred<Thread>(),
      goal = deferred<{ goal: null; eventSequence: number }>();
    f.runtime.readThread.mockReturnValue(detail.promise);
    f.client.getThreadGoal.mockReturnValue(goal.promise);
    try {
      await f.render();
      const detailSignals = f.runtime.readThread.mock.calls.map(
        (call) => call[1]?.signal,
      );
      const goalSignals = f.client.getThreadGoal.mock.calls.map(
        (call) => call[1]?.signal,
      );
      expect(detailSignals.length).toBeGreaterThan(0);
      expect(
        detailSignals.every((signal) => signal instanceof AbortSignal),
      ).toBe(true);
      const newRead = vi.fn(async () => ({
        ...thread,
        id: "thread-new",
        name: controlOfficeThreadTitle(record),
      }));
      if (change === "identity")
        await f.render([], {
          runtime: {
            ...f.runtime,
            readThread: newRead,
          },
          client: {
            ...f.client,
            getOfficeThread: vi.fn(async () =>
              officeAssociation(
                catalogPage([{ ...thread, id: "thread-new" }]).data[0]!,
              ),
            ),
          },
        });
      else await f.close();
      expect(detailSignals.every((signal) => signal!.aborted)).toBe(true);
      expect(goalSignals.every((signal) => signal!.aborted)).toBe(true);
      await act(async () => {
        detail.resolve(thread);
        goal.resolve({ goal: null, eventSequence: 0 });
      });
      if (change === "identity") {
        expect(newRead).toHaveBeenCalledOnce();
        expect(f.container.querySelector("textarea")!.disabled).toBe(false);
      }
    } finally {
      detail.resolve(thread);
      goal.resolve({ goal: null, eventSequence: 0 });
      await f.close();
    }
  },
);

it("uses sparse reconciliation with live Runtime updates and stops after terminal output", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const active = {
    ...thread,
    status: { type: "active", activeFlags: [] },
  } as Thread;
  const runtime = { ...f.runtime, turnUpdates: "runtime" as const };
  f.runtime.readThread.mockResolvedValue(active);
  try {
    await f.render([active], { runtime });
    const initial = f.runtime.readThread.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
    await f.render([thread], { runtime });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.close();
  }
});

it.each(["undeclared", "missing-live-thread"])(
  "keeps reconciliation available for %s",
  async (kind) => {
    vi.useFakeTimers();
    const f = fixture(),
      active = {
        ...thread,
        status: { type: "active", activeFlags: [] },
      } as Thread;
    f.runtime.readThread.mockResolvedValue(active);
    try {
      await f.render(kind === "undeclared" ? [active] : [], {
        runtime:
          kind === "undeclared"
            ? f.runtime
            : { ...f.runtime, turnUpdates: "runtime" },
      });
      const initial = f.runtime.readThread.mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(1_500));
      expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
      await f.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it("does not start a post-send read after the Office has closed", async () => {
  const f = fixture(),
    accepted = deferred<unknown>();
  f.runtime.startTurn.mockReturnValue(accepted.promise);
  try {
    await f.render();
    await send(f.container);
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
    const reads = f.runtime.readThread.mock.calls.length,
      goals = f.client.getThreadGoal.mock.calls.length;
    await f.close();
    await act(async () => accepted.resolve({}));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads);
    expect(f.client.getThreadGoal).toHaveBeenCalledTimes(goals);
  } finally {
    accepted.resolve({});
    await f.close();
  }
});

it("coalesces timer reads behind an accepted send and cancels its pending refresh on close", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    afterSend = deferred<Thread>();
  f.runtime.startTurn.mockResolvedValue({});
  try {
    await f.render();
    const initial = f.runtime.readThread.mock.calls.length;
    f.runtime.readThread.mockReturnValue(afterSend.promise);
    await send(f.container);
    expect(f.runtime.startTurn).toHaveBeenCalledOnce();
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
    const signal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
    expect(signal.aborted).toBe(false);
    await f.close();
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => afterSend.resolve(thread));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
  } finally {
    afterSend.resolve(thread);
    await f.close();
  }
});

it("supersedes a pre-send background read and ignores its late result", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    beforeSend = deferred<Thread>();
  f.client.getThreadGoal.mockResolvedValue({
    goal: { status: "active" },
    eventSequence: 1,
  } as never);
  f.runtime.startTurn.mockResolvedValue({});
  const answer = (text: string) =>
    ({
      ...thread,
      turns: [
        {
          id: "run-1",
          status: "completed",
          items: [{ type: "agentMessage", id: "answer", text }],
          startedAt: 1,
        },
      ],
    }) as Thread;
  try {
    await f.render();
    f.runtime.readThread.mockReturnValueOnce(beforeSend.promise);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    const oldSignal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    expect(oldSignal.aborted).toBe(false);
    f.runtime.readThread.mockResolvedValue(answer("Fresh answer"));
    await send(f.container);
    expect(oldSignal.aborted).toBe(true);
    expect(f.container.textContent).toContain("Fresh answer");
    await act(async () => beforeSend.resolve(answer("Stale answer")));
    expect(f.container.textContent).toContain("Fresh answer");
    expect(f.container.textContent).not.toContain("Stale answer");
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).toBeNull();
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    beforeSend.resolve(thread);
    await f.close();
  }
});

it("pauses in member settings and keeps its binding when the sidebar page changes", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    pending = deferred<Thread>();
  const active = {
    ...thread,
    status: { type: "active", activeFlags: [] },
  } as Thread;
  f.runtime.readThread.mockResolvedValue(active);
  try {
    await f.render();
    f.runtime.readThread.mockReturnValueOnce(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    const signal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    await act(async () =>
      f.container
        .querySelector<HTMLButtonElement>(
          ".control-office-member-settings-button",
        )!
        .click(),
    );
    expect(signal.aborted).toBe(true);
    const reads = f.runtime.readThread.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads);
    // The current shared catalog page can move while the room is hidden.
    f.runtime.listThreads.mockResolvedValue([]);
    f.client.getThreadCatalog.mockResolvedValue(catalogPage([]));
    const lookups = f.client.getThreadCatalog.mock.calls.length;
    await act(async () => pending.resolve(active));
    const back = [...f.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Back"),
    )!;
    expect(back).toBeDefined();
    await act(async () => back.click());
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads + 1);
    expect(f.client.getThreadCatalog).toHaveBeenCalledTimes(lookups);
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pending.resolve(thread);
    await f.close();
  }
});

it("releases actual Runtime history streams when the Office unmounts", async () => {
  const f = fixture(),
    control = transcriptFixture(8),
    signals: AbortSignal[] = [];
  control.runtime.close();
  const runtime = new ControlThreadRuntime(
    {
      client: control.client,
      eventStream: async function* (_client, input) {
        const signal = input.signal!;
        signals.push(signal);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
    {
      onThread() {},
      onTextDelta() {},
      onToolItem() {},
      onRunSettled() {},
      onStreamError() {},
    },
  );
  runtime.setThreadEventStreamFocus(null);
  vi.spyOn(control.client, "getOfficeThread").mockResolvedValue(
    officeAssociation(),
  );
  vi.spyOn(control.client, "getThreadGoal").mockResolvedValue({
    goal: null,
    eventSequence: 0,
  });
  try {
    await f.render([], { runtime, client: control.client });
    await vi.waitFor(() => expect(signals).toHaveLength(4));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await f.close();
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage).toEqual({
        active: 0,
        activeHistory: 0,
        queued: 0,
        queuedBytes: 0,
      }),
    );
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(control.mutations).toHaveLength(0);
  } finally {
    await f.close();
    runtime.close();
  }
});

it("keeps the existing Office binding when its initial detail read is superseded", async () => {
  const f = fixture();
  f.runtime.readThread.mockRejectedValue(
    new Error("control_thread_projection_superseded"),
  );
  f.runtime.startTurn.mockResolvedValue({});
  try {
    await f.render();
    expect(f.container.querySelector("textarea")!.disabled).toBe(false);
    f.runtime.readThread.mockResolvedValue(thread);
    await send(f.container);
    expect(f.client.createThread).not.toHaveBeenCalled();
    expect(f.runtime.startTurn.mock.lastCall![0]).toBe(thread.id);
  } finally {
    await f.close();
  }
});

it("does not restart an in-flight Office read just to change the display language", async () => {
  const f = fixture(),
    pending = deferred<Thread>();
  f.runtime.readThread.mockReturnValue(pending.promise);
  try {
    await f.render();
    const reads = f.runtime.readThread.mock.calls.length;
    const signal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    await f.render([], { locale: "zh" });
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads);
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(thread));
    expect(f.container.querySelector("textarea")!.disabled).toBe(false);
    expect(f.container.textContent).toContain("办公室群聊");
  } finally {
    pending.resolve(thread);
    await f.close();
  }
});

it("bounds optional Goal metadata without failing an already-loaded Thread", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    pending = deferred<{ goal: null; eventSequence: number }>();
  f.client.getThreadGoal.mockReturnValue(pending.promise);
  try {
    await f.render();
    const signal = f.client.getThreadGoal.mock.lastCall![1]!.signal!;
    const reads = f.runtime.readThread.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(signal.aborted).toBe(true);
    expect(f.container.querySelector("textarea")!.disabled).toBe(false);
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).toBeNull();
    await act(async () =>
      pending.resolve({
        goal: { status: "active" },
        eventSequence: 1,
      } as never),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads);
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pending.resolve({ goal: null, eventSequence: 0 });
    await f.close();
  }
});

it("bounds an uncooperative initial detail read and ignores completion after its deadline", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    pending = deferred<Thread>();
  f.runtime.readThread.mockReturnValue(pending.promise);
  try {
    await f.render();
    const signal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(signal.aborted).toBe(true);
    expect(f.container.querySelector("textarea")!.disabled).toBe(false);
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).not.toBeNull();
    await act(async () => pending.resolve(thread));
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).not.toBeNull();
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pending.resolve(thread);
    await f.close();
  }
});

it("checks an active Goal between Runs and stops when the Goal finishes", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    runtime = { ...f.runtime, turnUpdates: "runtime" as const };
  f.client.getThreadGoal.mockResolvedValue({
    goal: { status: "active" },
    eventSequence: 1,
  } as never);
  try {
    await f.render([thread], { runtime });
    const initial = f.runtime.readThread.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 1);
    f.client.getThreadGoal.mockResolvedValue({ goal: null, eventSequence: 2 });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 2);
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(initial + 2);
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.close();
  }
});

it("cancels a pending background projection when live output settles the Run", async () => {
  vi.useFakeTimers();
  const f = fixture(),
    pending = deferred<Thread>();
  const active = {
    ...thread,
    status: { type: "active", activeFlags: [] },
  } as Thread;
  const runtime = { ...f.runtime, turnUpdates: "runtime" as const };
  f.runtime.readThread.mockResolvedValue(active);
  try {
    await f.render([active], { runtime });
    f.runtime.readThread.mockReturnValue(pending.promise);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    const signal = f.runtime.readThread.mock.lastCall![1]!.signal!;
    expect(signal.aborted).toBe(false);
    await f.render([thread], { runtime });
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(active));
    expect(
      f.container.querySelector('[data-runtime-status="error"]'),
    ).toBeNull();
    const reads = f.runtime.readThread.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(f.runtime.readThread).toHaveBeenCalledTimes(reads);
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    pending.resolve(thread);
    await f.close();
  }
});

it("keeps actual Runtime streaming and settlement alive when the Office is closed and reopened", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let publishThread: (value: Thread) => void = () => {};
  let appendText: (id: string, delta: string) => void = () => {};
  let resetText: (id: string) => void = () => {};
  const settled = vi.fn();
  const control = transcriptFixture(1);
  control.runtime.close();
  const activeRun = { ...transcriptRun("run-1", true), lastSequence: 1 };
  let running = true;
  let liveSignal: AbortSignal | undefined;
  vi.spyOn(control.client, "getRun").mockImplementation(async () => ({
    run: running
      ? { ...activeRun }
      : { ...transcriptRun("run-1"), revision: 3, lastSequence: 3 },
  }));
  const runtime = new ControlThreadRuntime(
    {
      client: control.client,
      eventStream: async function* (
        _client,
        input,
      ): AsyncGenerator<RunEventView> {
        const afterSequence = input.afterSequence ?? 0;
        const live = running;
        if (live) {
          liveSignal = input.signal;
          activeRun.lastSequence = 2;
          activeRun.revision = 2;
        }
        const base = { runId: "run-1", occurredAt: activeRun.updatedAt };
        if (afterSequence < 1)
          yield {
            ...base,
            eventId: "started-1",
            sequence: 1,
            type: "run.started",
            data: {},
          };
        if (afterSequence < 2)
          yield {
            ...base,
            eventId: "delta-2",
            sequence: 2,
            type: "model.output.delta",
            data: { segmentId: "live", delta: "Still running" },
          };
        if (live)
          await new Promise<void>((resolve) => {
            if (input.signal!.aborted) resolve();
            else
              input.signal!.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
        else if (afterSequence < 3)
          yield {
            ...base,
            eventId: "done-3",
            sequence: 3,
            type: "run.completed",
            data: { outputRef: null },
          };
      },
    },
    {
      onThread: (value) => publishThread(value),
      onTextDelta: (id, delta) => appendText(id, delta),
      onTextReset: (id) => resetText(id),
      onRunSettled: settled,
      onToolItem() {},
      onStreamError() {},
    },
  );
  control.setActive(activeRun);
  control.thread.title = thread.name;
  runtime.setThreadEventStreamFocus(null);
  vi.spyOn(control.client, "getOfficeThread").mockResolvedValue(
    officeAssociation(),
  );
  vi.spyOn(control.client, "getThreadGoal").mockResolvedValue({
    goal: null,
    eventSequence: 0,
  });
  const reads = vi.spyOn(runtime, "readThread");
  function App({ show }: { show: boolean }) {
    const [threads, setThreads] = useState<Thread[]>([]);
    const [text, setText] = useState<Record<string, string>>({});
    publishThread = (value) =>
      setThreads((current) => [
        ...current.filter((item) => item.id !== value.id),
        value,
      ]);
    appendText = (id, delta) =>
      setText((current) => ({ ...current, [id]: (current[id] ?? "") + delta }));
    resetText = (id) => setText((current) => ({ ...current, [id]: "" }));
    const adapter = createControlCommandOfficeRoomAdapter({
      client: control.client,
      runtime,
      liveThreads: threads,
      streamingTextByThread: text,
      locale: "en",
    });
    return show ? adapter.render(record, vi.fn(), vi.fn()) : null;
  }
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <App show />
        </StrictMode>,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(container.textContent).toContain("Still running");
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    const initial = reads.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(reads).toHaveBeenCalledTimes(initial);
    const signal = liveSignal!;
    expect(signal.aborted).toBe(false);
    await act(async () =>
      root.render(
        <StrictMode>
          <App show={false} />
        </StrictMode>,
      ),
    );
    expect(signal.aborted).toBe(false);
    running = false;
    control.setActive(null);
    control.messages.push({
      ...control.messages[0]!,
      messageId: "answer-2",
      sequence: 2,
      role: "assistant",
      content: "Durable final answer",
    });
    control.thread.lastMessageSequence = 2;
    control.thread.revision++;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(settled).toHaveBeenCalledWith("thread-1", "run-1");
    expect(signal.aborted).toBe(true);
    await act(async () =>
      root.render(
        <StrictMode>
          <App show />
        </StrictMode>,
      ),
    );
    expect(container.textContent).toContain("Durable final answer");
    expect(container.textContent).not.toContain("Still running");
    expect(control.mutations).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    runtime.close();
    await act(async () => vi.advanceTimersByTimeAsync(0));
  }
  expect(vi.getTimerCount()).toBe(0);
});
