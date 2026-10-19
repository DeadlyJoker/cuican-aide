import type { RunEventView } from "@crewon/contracts";
import type { ControlRunModelActivity } from "./controlRunModelActivity";

export type ControlRunDraftProjectionState = Readonly<{
  segmentId: string | null;
  modelActivity?: ControlRunModelActivity;
}>;

export type ControlRunDraftProjectionResult = Readonly<{
  state: ControlRunDraftProjectionState;
  reset: boolean;
  delta: string;
  /** Emitted only on a phase transition, never for every streamed text chunk. */
  modelActivity?: ControlRunModelActivity | null;
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
  let modelActivity = current.modelActivity ?? null;
  if (event.type === "model.sampling.retry") modelActivity = "retrying";
  else if (event.type === "segment.started" || event.type === "tool.completed")
    modelActivity = "waiting";
  else if (
    event.type === "tool.requested" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled" ||
    (event.type === "model.output.delta" && event.data.delta.trim().length > 0)
  )
    modelActivity = null;
  const projected = projectDraftText(current, event);
  const { modelActivity: _prior, ...state } = projected.state;
  return {
    ...projected,
    state: modelActivity ? { ...state, modelActivity } : state,
    ...(modelActivity !== (current.modelActivity ?? null)
      ? { modelActivity }
      : {}),
  };
}

function projectDraftText(
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
