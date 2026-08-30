import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { ControlApiClient } from "@crewon/control-client";
import type { RunEventView, RunView } from "@crewon/contracts";

const MAX_CONTROL_TOOL_ITEMS_PER_RUN = 256;
const MAX_CONTROL_TOOL_HISTORY_RUNS = 50;
const CONTROL_TOOL_HISTORY_CONCURRENCY = 4;

type ControlToolItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;
type ControlToolEvent = Extract<
  RunEventView,
  { type: "tool.requested" | "tool.completed" }
>;

type ControlToolProjectionEntry = {
  firstSequence: number;
  item: ControlToolItem;
  lastSequence: number;
  requestedAtMs: number | null;
};

export type ControlToolProjectionState = Map<
  string,
  ControlToolProjectionEntry
>;

type ControlToolHistory = Readonly<{
  runId: string;
  state: ControlToolProjectionState;
}> | null;

export type ControlToolHistoryLoad = Promise<ControlToolHistory>;

export type ControlRunEventStream = (
  client: ControlApiClient,
  input: {
    runId: string;
    afterSequence?: number;
    view?: "client" | "audit";
    signal?: AbortSignal;
  },
) => AsyncIterable<RunEventView>;

export function createControlToolProjectionState(): ControlToolProjectionState {
  return new Map();
}

export function applyControlToolEvent(
  state: ControlToolProjectionState,
  event: RunEventView,
): ControlToolItem | null {
  if (event.type !== "tool.requested" && event.type !== "tool.completed") {
    return null;
  }

  const existing = state.get(event.data.callId);
  if (existing && event.sequence <= existing.lastSequence) {
    return null;
  }
  if (!existing && state.size >= MAX_CONTROL_TOOL_ITEMS_PER_RUN) {
    return null;
  }

  const entry = projectControlToolEntry(event, existing);
  state.set(event.data.callId, entry);
  return entry.item;
}

export function controlToolItems(
  state: ControlToolProjectionState | undefined,
): ControlToolItem[] {
  if (!state) {
    return [];
  }
  return [...state.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map((entry) => entry.item);
}

export async function hydrateControlToolHistories(params: {
  client: ControlApiClient;
  eventStream: ControlRunEventStream;
  inFlightByRun: Map<string, ControlToolHistoryLoad>;
  lifecycleSignal: AbortSignal;
  requestSignal?: AbortSignal;
  runsNewestFirst: readonly RunView[];
  statesByRun: Map<string, ControlToolProjectionState>;
  timeoutMs: number;
}): Promise<void> {
  const runs = params.runsNewestFirst
    .filter(
      (run) =>
        (run.purpose ?? "turn") === "turn" &&
        run.terminalAt !== null &&
        run.lastSequence > 0 &&
        !params.statesByRun.has(run.runId),
    )
    .slice(0, MAX_CONTROL_TOOL_HISTORY_RUNS);

  for (
    let index = 0;
    index < runs.length;
    index += CONTROL_TOOL_HISTORY_CONCURRENCY
  ) {
    params.requestSignal?.throwIfAborted();
    const batch = runs.slice(index, index + CONTROL_TOOL_HISTORY_CONCURRENCY);
    const histories = await waitForControlToolHistoryBatch(
      Promise.all(batch.map((run) => controlToolHistoryLoad(params, run))),
      params.requestSignal,
    );
    for (const history of histories) {
      if (history && !params.lifecycleSignal.aborted) {
        params.statesByRun.set(history.runId, history.state);
      }
    }
  }
}

function controlToolHistoryLoad(
  params: Parameters<typeof hydrateControlToolHistories>[0],
  run: RunView,
): ControlToolHistoryLoad {
  const existing = params.inFlightByRun.get(run.runId);
  if (existing) {
    return existing;
  }
  const load = loadControlToolHistory(params, run);
  params.inFlightByRun.set(run.runId, load);
  const clear = () => {
    if (params.inFlightByRun.get(run.runId) === load) {
      params.inFlightByRun.delete(run.runId);
    }
  };
  void load.then(clear, clear);
  return load;
}

function projectControlToolEntry(
  event: ControlToolEvent,
  existing: ControlToolProjectionEntry | undefined,
): ControlToolProjectionEntry {
  const requestedAtMs =
    event.type === "tool.requested"
      ? Date.parse(event.occurredAt)
      : (existing?.requestedAtMs ?? null);
  const durationMs =
    event.type === "tool.completed" && requestedAtMs !== null
      ? Math.max(0, Date.parse(event.occurredAt) - requestedAtMs)
      : null;
  const status =
    event.type === "tool.requested"
      ? "inProgress"
      : event.data.isError
        ? "failed"
        : "completed";

  return {
    firstSequence: existing?.firstSequence ?? event.sequence,
    item: {
      type: "dynamicToolCall",
      id: event.data.callId,
      namespace: null,
      tool: event.data.name,
      arguments: existing?.item.arguments ?? {},
      status,
      contentItems: existing?.item.contentItems ?? null,
      success: event.type === "tool.completed" ? !event.data.isError : null,
      durationMs,
    },
    lastSequence: event.sequence,
    requestedAtMs,
  };
}

async function loadControlToolHistory(
  params: {
    client: ControlApiClient;
    eventStream: ControlRunEventStream;
    lifecycleSignal: AbortSignal;
    timeoutMs: number;
  },
  run: RunView,
): ControlToolHistoryLoad {
  const controller = new AbortController();
  const abortFromRuntime = () =>
    controller.abort(params.lifecycleSignal.reason);
  if (params.lifecycleSignal.aborted) {
    abortFromRuntime();
  } else {
    params.lifecycleSignal.addEventListener("abort", abortFromRuntime, {
      once: true,
    });
  }
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(new Error("control_tool_history_timeout")),
    params.timeoutMs,
  );
  const state = createControlToolProjectionState();
  let reachedSnapshotHead = false;
  try {
    for await (const event of params.eventStream(params.client, {
      runId: run.runId,
      afterSequence: 0,
      view: "client",
      signal: controller.signal,
    })) {
      applyControlToolEvent(state, event);
      if (event.sequence >= run.lastSequence) {
        reachedSnapshotHead = true;
        break;
      }
    }
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeoutId);
    params.lifecycleSignal.removeEventListener("abort", abortFromRuntime);
    controller.abort();
  }

  return reachedSnapshotHead ? { runId: run.runId, state } : null;
}

function waitForControlToolHistoryBatch<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const finish = (complete: () => void) => {
      signal.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => finish(() => resolve(value)),
      (reason: unknown) => finish(() => reject(reason)),
    );
  });
}
