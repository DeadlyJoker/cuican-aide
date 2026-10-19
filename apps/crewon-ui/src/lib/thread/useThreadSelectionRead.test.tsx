// @vitest-environment happy-dom
import { act, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import {
  useThreadSelectionRead,
  type ThreadSelectionRead,
} from "./useThreadSelectionRead";
import { selectThreadAction } from "./threadListActions";
import { ControlThreadRuntime } from "../control-runtime/controlThreadRuntime";
import { controlHistoryReadBudget } from "../control-runtime/controlHistoryReadBudget";
import { transcriptFixture } from "../control-runtime/controlTranscriptWindow.test-support";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("a newer authoritative projection supersedes a selection without reporting a connection failure", async () => {
  const published = vi.fn();
  const f = transcriptFixture(8, { onThread: published });
  const original = f.client.getRunPlan.bind(f.client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const plans = vi
    .spyOn(f.client, "getRunPlan")
    .mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await gate;
      return result;
    });
  const setNotice = vi.fn(),
    preserve = vi.fn(),
    setThreads = vi.fn();
  let selection: Promise<Thread | null> | undefined;
  try {
    selection = selectThreadAction({
      client: f.runtime,
      threadId: "thread-1",
      isConnected: true,
      locale: "zh",
      setThreads,
      setNotice,
      preserveThreadsAfterConnectionLoss: preserve,
      setSelectedThreadId() {},
      setAppView() {},
      setInspectorOpen() {},
      setSidebarOpen() {},
      shouldAutoCloseSidebar: () => false,
    });
    await vi.waitFor(() => expect(plans).toHaveBeenCalled());
    const current = await f.runtime.readThread("thread-1");
    expect(current.id).toBe("thread-1");
    expect(current.turns).toHaveLength(4);
    release();
    expect(await selection).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
    expect(preserve).not.toHaveBeenCalled();
    expect(setThreads).not.toHaveBeenCalled();
    expect(published).toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
  } finally {
    release();
    await selection;
    f.runtime.close();
  }
});

it("closes stale identity callbacks and unmounted reads even when a reader ignores cancellation", async () => {
  let run!: ThreadSelectionRead;
  function Probe({ identity }: { identity: object }) {
    run = useThreadSelectionRead({ identity, selectedThreadId: "selected" });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const signals: AbortSignal[] = [];
  const releases: (() => void)[] = [];
  const read = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<void>((resolve) => releases.push(resolve));
  });
  let unmounted = false;
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe identity={{}} />
        </StrictMode>,
      ),
    );
    const stale = run;
    const first = run("selected", read).catch((error: unknown) => error);
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe identity={{}} />
        </StrictMode>,
      ),
    );
    expect(await first).toMatchObject({ name: "AbortError" });
    expect(signals[0]!.aborted).toBe(true);
    await expect(stale("selected", read)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(read).toHaveBeenCalledTimes(1);
    const second = run("selected", read).catch((error: unknown) => error);
    await act(async () => root.unmount());
    unmounted = true;
    expect(await second).toMatchObject({ name: "AbortError" });
    expect(signals[1]!.aborted).toBe(true);
    await expect(run("selected", read)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    releases.forEach((release) => release());
  }
});

it("propagates actual list selection cancellation through the runtime history pool", async () => {
  const f = transcriptFixture(8);
  f.runtime.close();
  const signals: AbortSignal[] = [];
  const runtime = new ControlThreadRuntime(
    {
      client: f.client,
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
  const plans = vi.spyOn(f.client, "getRunPlan");
  let selection: Promise<Thread | null> | undefined;
  const setThreads = vi.fn(),
    setNotice = vi.fn();
  function Probe() {
    const [selected, setSelected] = useState<string | null>(null);
    const runSelectionRead = useThreadSelectionRead({
      identity: runtime,
      selectedThreadId: selected,
    });
    return (
      <>
        <button
          onClick={() => {
            selection = selectThreadAction({
              client: runtime,
              runSelectionRead,
              threadId: "thread-1",
              isConnected: true,
              locale: "en",
              setSelectedThreadId: setSelected,
              setThreads,
              setNotice,
              setAppView() {},
              setInspectorOpen() {},
              setSidebarOpen() {},
              preserveThreadsAfterConnectionLoss() {},
              shouldAutoCloseSidebar: () => false,
            });
          }}
        >
          Open
        </button>
        <button onClick={() => setSelected(null)}>Draft</button>
      </>
    );
  }
  const container = document.createElement("div"),
    root = createRoot(container);
  let unmounted = false;
  try {
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
    await act(async () => container.querySelectorAll("button")[0]!.click());
    await vi.waitFor(() => expect(signals).toHaveLength(4));
    const previous = selection;
    await act(async () => container.querySelectorAll("button")[0]!.click());
    expect(await previous).toBeNull();
    await vi.waitFor(() => expect(plans).toHaveBeenCalledTimes(2));
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(await selection).toBeNull();
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage.active).toBe(0),
    );
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => container.querySelectorAll("button")[0]!.click());
    await vi.waitFor(() => expect(signals).toHaveLength(8));
    expect(signals.slice(4).every((signal) => !signal.aborted)).toBe(true);
    await act(async () => root.unmount());
    unmounted = true;
    expect(await selection).toBeNull();
    await vi.waitFor(() =>
      expect(controlHistoryReadBudget.usage).toEqual({
        active: 0,
        activeHistory: 0,
        queued: 0,
        queuedBytes: 0,
      }),
    );
    expect(setThreads).not.toHaveBeenCalled();
    expect(setNotice).not.toHaveBeenCalled();
    expect(f.mutations).toHaveLength(0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    runtime.close();
    await selection;
  }
});
