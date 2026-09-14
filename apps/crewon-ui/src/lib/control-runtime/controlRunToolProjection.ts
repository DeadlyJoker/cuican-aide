import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  RunEventExtension,
  RunEventView,
  RunView,
  WorkspaceChangeSummary,
} from "@crewon/contracts";
import { parseWorkspaceChangeSummary } from "@crewon/contracts";
import { controlHistoryReadBudget } from "./controlHistoryReadBudget";
import { ThreadDetailSize } from "../thread/threadDetailSize";

const MAX_CONTROL_TOOL_ITEMS_PER_RUN = 256;
const MAX_CONTROL_TOOL_HISTORY_RUNS = 50;
const CONTROL_TOOL_HISTORY_CONCURRENCY = 4;
const MAX_CONTROL_TOOL_PAYLOAD_BYTES = 2 * 1024 * 1024;
const toolPayloadSizes = new ThreadDetailSize(MAX_CONTROL_TOOL_PAYLOAD_BYTES);
const payloadUsage = new WeakMap<
  object,
  { bytes: number; weights: Map<string, number> }
>();

export type ControlToolItem = Extract<ThreadItem, { type: "dynamicToolCall" }> &
  Readonly<{
    controlApproval?: Readonly<{
      approvalId: string;
      status: "required";
    }>;
    controlToolKind?: "custom" | "function";
    workspaceChanges?: WorkspaceChangeSummary;
  }>;
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

type ControlTaskChangeProjectionEntry = ControlToolProjectionEntry & {
  phase: "pending" | "completed";
  segmentId: string;
};

export type ControlToolProjectionState = Map<
  string,
  ControlToolProjectionEntry
>;
export type ControlTaskChangeProjectionState = Map<
  string,
  ControlTaskChangeProjectionEntry
>;

export type ControlToolHistoryCoverage = Readonly<{
  throughSequence: number;
  complete: boolean;
}>;

const overflowedToolStates = new WeakSet<ControlToolProjectionState>();
const overflowedTaskChangeStates =
  new WeakSet<ControlTaskChangeProjectionState>();
const invalidTaskChangeStates = new WeakSet<ControlTaskChangeProjectionState>();

type ControlToolHistory = Readonly<{
  runId: string;
  state: ControlToolProjectionState;
  coverage: ControlToolHistoryCoverage;
}> | null;

export type ControlToolHistoryLoad = Promise<ControlToolHistory>;

const LOCAL_WORKSPACE_MCP_PREFIX = "mcp__workspace_checks__";

export type ControlRunEventStream = (
  client: ControlApiClient,
  input: {
    runId: string;
    afterSequence?: number;
    extensions?: readonly RunEventExtension[];
    view?: "client" | "audit" | "transcript";
    signal?: AbortSignal;
  },
) => AsyncIterable<RunEventView>;

export function createControlToolProjectionState(): ControlToolProjectionState {
  return new Map();
}

export function createControlTaskChangeProjectionState(): ControlTaskChangeProjectionState {
  return new Map();
}

/**
 * Maintains the active Run's mutation-only ledger independently from the
 * bounded Tool-detail projection. Read-only Tool volume must not make exact
 * task accounting unavailable.
 */
export function applyControlTaskChangeEvent(
  state: ControlTaskChangeProjectionState,
  event: RunEventView,
): ControlToolItem | null {
  if (
    (event.type !== "tool.requested" && event.type !== "tool.completed") ||
    event.data.kind !== "function" ||
    event.data.name !== "workspace_run_command"
  ) {
    return null;
  }
  const existing = state.get(event.data.callId);
  if (event.type === "tool.requested" && existing) {
    invalidTaskChangeStates.add(state);
    return null;
  }
  if (!existing && state.size >= MAX_CONTROL_TOOL_ITEMS_PER_RUN) {
    overflowedTaskChangeStates.add(state);
    return null;
  }
  if (event.type === "tool.completed") {
    if (
      existing === undefined ||
      existing.phase !== "pending" ||
      existing.segmentId !== event.data.segmentId ||
      event.sequence <= existing.lastSequence ||
      event.data.workspaceChanges === undefined
    ) {
      invalidTaskChangeStates.add(state);
      return null;
    }
    try {
      if (
        !parseWorkspaceChangeSummary(event.data.workspaceChanges).statsComplete
      ) {
        invalidTaskChangeStates.add(state);
        return null;
      }
    } catch {
      invalidTaskChangeStates.add(state);
      return null;
    }
  }
  const entry = projectControlToolEntry(event, existing);
  if (!reserveToolPayload(state, event.data.callId, entry.item)) {
    overflowedTaskChangeStates.add(state);
    return null;
  }
  state.set(event.data.callId, {
    ...entry,
    phase: event.type === "tool.requested" ? "pending" : "completed",
    segmentId: event.data.segmentId,
  });
  return entry.item;
}

export function controlTaskChangeProjectionComplete(
  state: ControlTaskChangeProjectionState,
): boolean {
  return (
    !overflowedTaskChangeStates.has(state) &&
    !invalidTaskChangeStates.has(state) &&
    [...state.values()].every((entry) => entry.phase === "completed")
  );
}

export function applyControlToolEvent(
  state: ControlToolProjectionState,
  event: RunEventView,
): ControlToolItem | null {
  if (event.type === "run.approval.required") {
    const pending = [...state.entries()]
      .reverse()
      .find(([, entry]) => entry.item.status === "inProgress");
    if (!pending) {
      return null;
    }
    const [callId, existing] = pending;
    if (event.sequence <= existing.lastSequence) {
      return null;
    }
    const item: ControlToolItem = {
      ...existing.item,
      controlApproval: {
        approvalId: event.data.approvalId,
        status: "required",
      },
    };
    state.set(callId, {
      ...existing,
      item,
      lastSequence: event.sequence,
    });
    return item;
  }

  if (event.type === "run.resumed") {
    const pending = [...state.entries()]
      .reverse()
      .find(
        ([, entry]) =>
          entry.item.status === "inProgress" &&
          entry.item.controlApproval?.status === "required",
      );
    if (!pending) {
      return null;
    }
    const [callId, existing] = pending;
    if (event.sequence <= existing.lastSequence) {
      return null;
    }
    const { controlApproval: _controlApproval, ...item } = existing.item;
    state.set(callId, {
      ...existing,
      item,
      lastSequence: event.sequence,
    });
    return item;
  }

  if (event.type !== "tool.requested" && event.type !== "tool.completed") {
    return null;
  }

  const existing = state.get(event.data.callId);
  if (existing && event.sequence <= existing.lastSequence) {
    return null;
  }
  if (!existing && state.size >= MAX_CONTROL_TOOL_ITEMS_PER_RUN) {
    overflowedToolStates.add(state);
    return null;
  }

  const entry = projectControlToolEntry(event, existing);
  if (!reserveToolPayload(state, event.data.callId, entry.item)) {
    overflowedToolStates.add(state);
    return null;
  }
  state.set(event.data.callId, entry);
  return entry.item;
}

/** Bound preview payloads separately from the 256 small identity/status entries. */
function reserveToolPayload(
  state: ControlToolProjectionState | ControlTaskChangeProjectionState,
  callId: string,
  item: ControlToolItem,
): boolean {
  let usage = payloadUsage.get(state);
  if (!usage) {
    usage = { bytes: 0, weights: new Map() };
    for (const [id, entry] of state) {
      const weight = measureToolPayload(entry.item);
      usage.weights.set(id, weight);
      usage.bytes += weight;
    }
    payloadUsage.set(state, usage);
  }
  const weight = measureToolPayload(item);
  const bytes = usage.bytes - (usage.weights.get(callId) ?? 0) + weight;
  if (bytes > MAX_CONTROL_TOOL_PAYLOAD_BYTES) return false;
  usage.bytes = bytes;
  usage.weights.set(callId, weight);
  return true;
}

function measureToolPayload(item: ControlToolItem): number {
  return (
    toolPayloadSizes.measure(item.arguments) +
    toolPayloadSizes.measure(item.contentItems) +
    toolPayloadSizes.measure(item.workspaceChanges)
  );
}

export function controlToolProjectionComplete(
  state: ControlToolProjectionState,
): boolean {
  return !overflowedToolStates.has(state);
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

/**
 * Rehydrates transcript items without losing mutation entries retained by the
 * independent task-change ledger after the general Tool projection saturates.
 */
export function controlToolItemsWithTaskChanges(
  toolState: ControlToolProjectionState | undefined,
  taskChangeState: ControlTaskChangeProjectionState | undefined,
): ControlToolItem[] {
  const entries = new Map<string, ControlToolProjectionEntry>();
  for (const [callId, entry] of toolState ?? []) entries.set(callId, entry);
  for (const [callId, entry] of taskChangeState ?? []) {
    const existing = entries.get(callId);
    if (existing === undefined || entry.lastSequence > existing.lastSequence) {
      entries.set(callId, entry);
    }
  }
  return [...entries.values()]
    .sort((left, right) => left.firstSequence - right.firstSequence)
    .map((entry) => entry.item);
}

export function settleControlToolProjection(
  state: ControlToolProjectionState,
  terminal: Pick<RunView, "lastSequence" | "status" | "terminalAt">,
): ControlToolItem[] {
  if (
    terminal.terminalAt === null ||
    (terminal.status !== "canceled" &&
      terminal.status !== "completed" &&
      terminal.status !== "failed")
  ) {
    return [];
  }
  const terminalAtMs = Date.parse(terminal.terminalAt);
  const settled: ControlToolItem[] = [];
  for (const [callId, entry] of state) {
    if (entry.item.status !== "inProgress") {
      continue;
    }
    const durationMs =
      entry.requestedAtMs !== null && Number.isFinite(terminalAtMs)
        ? Math.max(0, terminalAtMs - entry.requestedAtMs)
        : null;
    const { controlApproval: _controlApproval, ...pendingItem } = entry.item;
    const item: ControlToolItem = {
      ...pendingItem,
      status: "failed",
      success: false,
      durationMs,
    };
    state.set(callId, {
      ...entry,
      item,
      lastSequence: Math.max(entry.lastSequence, terminal.lastSequence),
    });
    settled.push(item);
  }
  return settled;
}

export async function backfillControlToolProjection(params: {
  client: ControlApiClient;
  eventStream: ControlRunEventStream;
  runId: string;
  afterSequence: number;
  throughSequence: number;
  state: ControlToolProjectionState;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent?: (event: RunEventView) => void;
}): Promise<
  Readonly<{
    items: ControlToolItem[];
    lastSequence: number;
    complete: boolean;
  }>
> {
  return controlHistoryReadBudget.run({
    kind: "settlement",
    runId: params.runId,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    read: async (signal) => {
      let lastSequence = params.afterSequence;
      const items = new Map<string, ControlToolItem>();
      for await (const event of params.eventStream(params.client, {
        runId: params.runId,
        afterSequence: params.afterSequence,
        extensions: ["run-plan-v1"],
        view: "transcript",
        signal,
      })) {
        signal.throwIfAborted();
        if (event.sequence <= lastSequence) {
          continue;
        }
        if (event.sequence !== lastSequence + 1) {
          throw new Error("control_tool_history_sequence_gap");
        }
        lastSequence = event.sequence;
        params.onEvent?.(event);
        const item = applyControlToolEvent(params.state, event);
        if (item) {
          items.set(item.id, item);
        }
        if (lastSequence >= params.throughSequence) {
          break;
        }
      }
      if (lastSequence < params.throughSequence) {
        throw new Error("control_tool_history_backfill_incomplete");
      }
      return {
        items: [...items.values()],
        lastSequence,
        complete: controlToolProjectionComplete(params.state),
      };
    },
  });
}

export async function hydrateControlToolHistories(params: {
  client: ControlApiClient;
  eventStream: ControlRunEventStream;
  inFlightByRun: Map<string, ControlToolHistoryLoad>;
  lifecycleSignal: AbortSignal;
  requestSignal?: AbortSignal;
  runsNewestFirst: readonly RunView[];
  statesByRun: Map<string, ControlToolProjectionState>;
  coverageByRun: Map<string, ControlToolHistoryCoverage>;
  timeoutMs: number;
}): Promise<void> {
  const deadline = new AbortController();
  const abortFromCaller = () => deadline.abort(params.requestSignal?.reason);
  if (params.requestSignal?.aborted) abortFromCaller();
  else
    params.requestSignal?.addEventListener("abort", abortFromCaller, {
      once: true,
    });
  const timer = setTimeout(
    () => deadline.abort(new Error("control_tool_hydration_timeout")),
    Math.min(params.timeoutMs, 10_000),
  );
  try {
    const runs = params.runsNewestFirst
      .filter(
        (run) =>
          (run.purpose ?? "turn") === "turn" &&
          run.terminalAt !== null &&
          run.lastSequence > 0 &&
          (params.coverageByRun.get(run.runId)?.throughSequence ?? -1) <
            run.lastSequence,
      )
      .slice(0, MAX_CONTROL_TOOL_HISTORY_RUNS);

    for (
      let index = 0;
      index < runs.length;
      index += CONTROL_TOOL_HISTORY_CONCURRENCY
    ) {
      deadline.signal.throwIfAborted();
      if (params.lifecycleSignal.aborted) return;
      const batch = runs.slice(index, index + CONTROL_TOOL_HISTORY_CONCURRENCY);
      const histories = await waitForControlToolHistoryBatch(
        Promise.all(batch.map((run) => controlToolHistoryLoad(params, run))),
        deadline.signal,
      );
      for (const history of histories) {
        if (history && !params.lifecycleSignal.aborted) {
          params.statesByRun.set(history.runId, history.state);
          params.coverageByRun.set(history.runId, history.coverage);
        }
      }
    }
  } catch (error) {
    // Optional history cannot block the canonical page indefinitely. Caller
    // cancellation still propagates; the local deadline leaves partial coverage.
    if (!deadline.signal.aborted || params.requestSignal?.aborted) throw error;
  } finally {
    clearTimeout(timer);
    params.requestSignal?.removeEventListener("abort", abortFromCaller);
    deadline.abort();
  }
}

function controlToolHistoryLoad(
  params: Parameters<typeof hydrateControlToolHistories>[0],
  run: RunView,
): ControlToolHistoryLoad {
  const inFlightByRun = params.inFlightByRun;
  const existing = inFlightByRun.get(run.runId);
  if (existing) {
    return existing;
  }
  // Do not let an admitted read retain the caller's entire staged Thread maps.
  const { client, eventStream, lifecycleSignal, timeoutMs } = params;
  const load = loadControlToolHistory(
    { client, eventStream, lifecycleSignal, timeoutMs },
    run,
  );
  inFlightByRun.set(run.runId, load);
  const clear = () => {
    if (inFlightByRun.get(run.runId) === load) {
      inFlightByRun.delete(run.runId);
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
  const identity = controlToolIdentity(event.data.name);
  const argumentsValue =
    event.type === "tool.requested"
      ? controlToolArguments(
          event.data.inputPreview,
          existing?.item.arguments ?? {},
        )
      : (existing?.item.arguments ?? {});
  const contentItems =
    event.type === "tool.completed" && event.data.outputPreview !== undefined
      ? [
          {
            type: "inputText" as const,
            text: event.data.outputPreview,
          },
        ]
      : (existing?.item.contentItems ?? null);

  return {
    firstSequence: existing?.firstSequence ?? event.sequence,
    item: {
      type: "dynamicToolCall",
      id: event.data.callId,
      namespace: identity.namespace,
      tool: identity.tool,
      arguments: argumentsValue,
      status,
      contentItems,
      success: event.type === "tool.completed" ? !event.data.isError : null,
      durationMs,
      ...(event.data.name === "workspace_run_command"
        ? { controlToolKind: event.data.kind }
        : {}),
      ...(event.type === "tool.completed" &&
      event.data.workspaceChanges !== undefined
        ? { workspaceChanges: event.data.workspaceChanges }
        : {}),
    },
    lastSequence: event.sequence,
    requestedAtMs,
  };
}

function controlToolArguments(
  preview: string | undefined,
  fallback: ControlToolItem["arguments"],
): ControlToolItem["arguments"] {
  if (preview === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(preview) as ControlToolItem["arguments"];
  } catch {
    return preview;
  }
}

function controlToolIdentity(name: string): {
  namespace: string | null;
  tool: string;
} {
  if (name.startsWith(LOCAL_WORKSPACE_MCP_PREFIX)) {
    return {
      namespace: "workspace",
      tool: name.slice(LOCAL_WORKSPACE_MCP_PREFIX.length),
    };
  }
  return { namespace: null, tool: name };
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
  return controlHistoryReadBudget
    .run({
      kind: "history",
      runId: run.runId,
      signal: params.lifecycleSignal,
      timeoutMs: params.timeoutMs,
      read: async (signal) => {
        const state = createControlToolProjectionState();
        let lastSequence = 0;
        let reachedSnapshotHead = false;
        for await (const event of params.eventStream(params.client, {
          runId: run.runId,
          afterSequence: 0,
          extensions: ["run-plan-v1"],
          view: "transcript",
          signal,
        })) {
          signal.throwIfAborted();
          if (event.sequence <= lastSequence) {
            continue;
          }
          if (event.sequence !== lastSequence + 1) {
            return null;
          }
          lastSequence = event.sequence;
          applyControlToolEvent(state, event);
          if (event.sequence >= run.lastSequence) {
            reachedSnapshotHead = true;
            break;
          }
        }

        if (!reachedSnapshotHead) {
          return null;
        }
        settleControlToolProjection(state, run);
        return {
          runId: run.runId,
          state,
          coverage: {
            throughSequence: run.lastSequence,
            complete: controlToolProjectionComplete(state),
          },
        };
      },
    })
    .catch(() => null);
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
