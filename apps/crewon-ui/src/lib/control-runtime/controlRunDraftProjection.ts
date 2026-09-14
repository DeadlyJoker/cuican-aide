import type { RunEventView } from "@crewon/contracts";

export type ControlRunDraftProjectionState = Readonly<{
  segmentId: string | null;
}>;

export type ControlRunDraftProjectionResult = Readonly<{
  state: ControlRunDraftProjectionState;
  reset: boolean;
  delta: string;
}>;

export function createControlRunDraftProjectionState(): ControlRunDraftProjectionState {
  return { segmentId: null };
}

/**
 * Projects durable model events into a provisional UI draft. The authoritative
 * assistant Message still replaces this draft when the Run settles.
 */
export function applyControlRunDraftEvent(
  current: ControlRunDraftProjectionState,
  event: RunEventView,
): ControlRunDraftProjectionResult {
  if (event.type === "segment.started") {
    const changed = current.segmentId !== event.data.segmentId;
    return {
      state: {
        segmentId: event.data.segmentId,
      },
      // Claim the thread-level draft even for a freshly constructed runtime.
      // Replayed events otherwise append onto text left by the prior runtime.
      reset: changed,
      delta: "",
    };
  }

  if (event.type === "model.output.delta") {
    const changed =
      current.segmentId !== null && current.segmentId !== event.data.segmentId;
    return {
      state: {
        segmentId: event.data.segmentId,
      },
      reset: changed,
      delta: event.data.delta,
    };
  }

  if (
    (event.type === "model.sampling.retry" ||
      event.type === "model.transport.fallback") &&
    event.data.discardedOutput
  ) {
    return {
      state: { segmentId: event.data.segmentId },
      reset: true,
      delta: "",
    };
  }

  if (
    event.type === "segment.failed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  ) {
    return {
      state: { segmentId: null },
      reset: true,
      delta: "",
    };
  }

  return { state: current, reset: false, delta: "" };
}
