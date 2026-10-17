// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowRootEvents } from "./useWorkflowRootEvents";
import type { WorkflowRunObserver } from "../../lib/control-runtime/controlDurableWorkflowRuntime";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = Parameters<typeof useWorkflowRootEvents>[0];
function Harness(props: Props) {
  useWorkflowRootEvents(props);
  return null;
}
const waitAbort = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
let root: Root, container: HTMLDivElement;
async function render(props: Props) {
  await act(async () => {
    root.render(
      <StrictMode>
        <Harness {...props} />
      </StrictMode>,
    );
  });
}
function props(observe: WorkflowRunObserver): Props {
  return {
    enabled: true,
    workflowVersionId: "version-1",
    runId: "root-1",
    afterSequence: 5,
    sourceIdentity: {},
    observe,
    reload: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.useFakeTimers();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("visible Workflow root SSE", () => {
  it("consumes ordered invalidations, ignores duplicate/text completion, and reads canonical state on terminal", async () => {
    const observe = vi.fn<WorkflowRunObserver>(async function* () {
      yield { type: "run.started", sequence: 6 };
      yield { type: "run.started", sequence: 6 };
      yield { type: "message.completed", sequence: 7 };
      yield { type: "run.completed", sequence: 8 };
    });
    const input = props(observe);
    await render(input);
    expect(observe).toHaveBeenCalledOnce();
    expect(input.reload).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(observe).toHaveBeenCalledOnce();
  });
  it("reconnects the same root after a disconnect from the last consumed sequence", async () => {
    let attempt = 0;
    const observe = vi.fn<WorkflowRunObserver>(async function* () {
      if (attempt++ === 0) {
        yield { type: "run.started", sequence: 6 };
        throw Error("offline");
      }
      yield { type: "run.completed", sequence: 7 };
    });
    const input = props(observe);
    await render(input);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(observe).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(observe.mock.calls[1]?.[0]).toEqual({
      workflowVersionId: "version-1",
      runId: "root-1",
      afterSequence: 6,
    });
    expect(input.reload).toHaveBeenCalledTimes(2);
  });
  it("does not treat EOF as completion or submit any replacement request", async () => {
    const observe = vi.fn<WorkflowRunObserver>(async function* () {}),
      input = props(observe);
    await render(input);
    expect(input.reload).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(input.reload).not.toHaveBeenCalled();
  });
  it("keeps its active reader when callbacks and snapshot sequence change", async () => {
    const signals: AbortSignal[] = [];
    const observe = vi.fn<WorkflowRunObserver>(
      async function* (_scope, signal) {
        signals.push(signal);
        await waitAbort(signal);
      },
    );
    const input = props(observe);
    await render(input);
    await render({
      ...input,
      afterSequence: 10,
      reload: vi.fn(async () => {}),
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(signals[0]!.aborted).toBe(false);
  });
  it("aborts hidden/source-replaced readers and stops delayed reconnects", async () => {
    const signals: AbortSignal[] = [];
    const observe = vi.fn<WorkflowRunObserver>(
      async function* (_scope, signal) {
        signals.push(signal);
        await waitAbort(signal);
      },
    );
    const input = props(observe);
    await render(input);
    await render({
      ...input,
      sourceIdentity: {},
      runId: "root-2",
      afterSequence: 1,
    });
    expect(signals[0]!.aborted).toBe(true);
    expect(observe.mock.calls[1]?.[0].runId).toBe("root-2");
    await render({ ...input, enabled: false });
    expect(signals[1]!.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it("waits for a slow canonical read before consuming the next invalidation", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observe = vi.fn<WorkflowRunObserver>(async function* () {
      yield { type: "run.started", sequence: 6 };
      yield { type: "run.completed", sequence: 7 };
    });
    const input = props(observe),
      read = vi.fn(async () => {});
    read.mockReturnValueOnce(held);
    input.reload = read;
    await render(input);
    expect(read).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await held;
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
