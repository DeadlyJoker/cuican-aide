import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { ControlApiClient } from "@crewon/control-client";
import type {
  RunEventExtension,
  RunEventView,
  RunView,
  WorkspaceChangeSummary,
} from "@crewon/contracts";
import { parseWorkspaceChangeSummary } from "@crewon/contracts";

const MAX_CONTROL_TOOL_ITEMS_PER_RUN = 256;
const MAX_CONTROL_TOOL_HISTORY_RUNS = 50;
const CONTROL_TOOL_HISTORY_CONCURRENCY = 4;

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
  state.set(event.data.callId, entry);
  return entry.item;
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
  const deadline = controlToolHistoryDeadline(params.signal, params.timeoutMs);
  let lastSequence = params.afterSequence;
  const items: ControlToolItem[] = [];
  try {
    for await (const event of params.eventStream(params.client, {
      runId: params.runId,
      afterSequence: params.afterSequence,
      extensions: ["run-plan-v1"],
      view: "transcript",
      signal: deadline.controller.signal,
    })) {
      deadline.controller.signal.throwIfAborted();
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
        items.push(item);
      }
      if (lastSequence >= params.throughSequence) {
        break;
      }
    }
  } finally {
    deadline.dispose();
  }
  if (lastSequence < params.throughSequence) {
    throw new Error("control_tool_history_backfill_incomplete");
  }
  return {
    items,
    lastSequence,
    complete: controlToolProjectionComplete(params.state),
  };
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
    params.requestSignal?.throwIfAborted();
    const batch = runs.slice(index, index + CONTROL_TOOL_HISTORY_CONCURRENCY);
    const histories = await waitForControlToolHistoryBatch(
      Promise.all(batch.map((run) => controlToolHistoryLoad(params, run))),
      params.requestSignal,
    );
    for (const history of histories) {
      if (history && !params.lifecycleSignal.aborted) {
        params.statesByRun.set(history.runId, history.state);
        params.coverageByRun.set(history.runId, history.coverage);
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
  const deadline = controlToolHistoryDeadline(
    params.lifecycleSignal,
    params.timeoutMs,
  );
  const state = createControlToolProjectionState();
  let lastSequence = 0;
  let reachedSnapshotHead = false;
  try {
    for await (const event of params.eventStream(params.client, {
      runId: run.runId,
      afterSequence: 0,
      extensions: ["run-plan-v1"],
      view: "transcript",
      signal: deadline.controller.signal,
    })) {
      deadline.controller.signal.throwIfAborted();
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
  } catch {
    return null;
  } finally {
    deadline.dispose();
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
}

function controlToolHistoryDeadline(
  parentSignal: AbortSignal,
  timeoutMs: number,
): Readonly<{ controller: AbortController; dispose: () => void }> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    abortFromParent();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(new Error("control_tool_history_timeout")),
    timeoutMs,
  );
  return {
    controller,
    dispose: () => {
      globalThis.clearTimeout(timeoutId);
      parentSignal.removeEventListener("abort", abortFromParent);
      controller.abort();
    },
  };
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
