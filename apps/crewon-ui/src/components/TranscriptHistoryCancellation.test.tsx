// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ControlThreadRuntime } from "../lib/control-runtime/controlThreadRuntime";
import { controlHistoryReadBudget } from "../lib/control-runtime/controlHistoryReadBudget";
import { transcriptFixture } from "../lib/control-runtime/controlTranscriptWindow.test-support";
import {
  TranscriptNavigationScope,
  TranscriptWindowControls,
} from "./TranscriptWindowControls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("releases actual runtime history on selection change and unmount, then permits a fresh page read", async () => {
  const f = transcriptFixture(100);
  const thread = await f.runtime.readThread("thread-1", {
    toolHistoryMode: "skip",
  });
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let unmounted = false;
  const render = async (id: string) =>
    act(async () =>
      root.render(
        <StrictMode>
          <TranscriptNavigationScope runtime={runtime}>
            <TranscriptWindowControls thread={{ ...thread, id }} locale="en" />
          </TranscriptNavigationScope>
        </StrictMode>,
      ),
    );
  const openHistory = async (count: number) =>
    act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Older messages")!
        .click();
      await vi.waitFor(() => expect(signals).toHaveLength(count));
    });
  try {
    await render(thread.id);
    await openHistory(4);
    expect(container.querySelector("nav")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    await render("another-thread");
    await vi.waitFor(() => {
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(controlHistoryReadBudget.usage.active).toBe(0);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-busy")).toBe(
      "false",
    );
    await render(thread.id);
    await openHistory(8);
    expect(signals.slice(4).every((signal) => !signal.aborted)).toBe(true);
    await act(async () => root.unmount());
    unmounted = true;
    await vi.waitFor(() => {
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(controlHistoryReadBudget.usage).toEqual({
        active: 0,
        activeHistory: 0,
        queued: 0,
        queuedBytes: 0,
      });
    });
    expect(f.mutations).toHaveLength(0);
  } finally {
    if (!unmounted) await act(async () => root.unmount());
    runtime.close();
    container.remove();
  }
});
