import type { RunEventView } from "@crewon/contracts";
import { streamRunEvents, type ControlApiClient } from "@crewon/control-client";

import type { ControlTeamRunAcceptedEvent } from "./controlTeamRuntime";
import { waitForControlRuntimeDelay } from "./controlRuntimeDelay";

export const CONTROL_TEAM_GUI_OBSERVATION_QUERY = "crewonTeamObserve" as const;
export const CONTROL_TEAM_GUI_OBSERVATION_STORAGE_KEY =
  "crewon.control-team-gui-observation.v1" as const;
export const CONTROL_TEAM_GUI_OBSERVATION_EVENT =
  "crewon:control-team-gui-observation" as const;
export const CONTROL_TEAM_GUI_OBSERVATION_ELEMENT_ID =
  "crewon-control-team-gui-observation" as const;
export const CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION =
  "crewon.control-team-gui-observation.v1" as const;

const MAX_OBSERVATIONS = 16;
const MAX_RUNS_PER_OBSERVATION = 32;
const MAX_RECONNECT_DELAY_MS = 5_000;

type RunEventStream = (
  client: ControlApiClient,
  input: {
    runId: string;
    afterSequence?: number;
    view?: "client" | "audit" | "transcript";
    signal?: AbortSignal;
  },
) => AsyncIterable<RunEventView>;

type ObservationStorage = Pick<Storage, "getItem" | "setItem">;

type ObservationEventTarget = Pick<EventTarget, "dispatchEvent">;

type ObservationClock = Readonly<{
  monotonicNow: () => number;
  wallNow: () => string;
}>;

export type ControlTeamGuiRunObservation = Readonly<{
  phaseIndex: number;
  kind: ControlTeamRunAcceptedEvent["kind"];
  memberId: string;
  agentVersionId: string;
  runId: string;
  runThreadId: string;
  recoveredMemberId: string | null;
  acceptedAt: string;
  createdAt: string | null;
  controlSse: Readonly<{
    firstDeltaMs: number | null;
    maxDeltaGapMs: number | null;
    reconnectCount: number;
    outputChunkCount: number;
  }>;
  signals: Readonly<{
    samplingRetryCount: number;
    transportFallbackCount: number;
    providerContinuationCount: number;
  }>;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> | null;
  terminal: Readonly<{
    status: "completed" | "failed" | "canceled";
    sequence: number;
    occurredAt: string;
  }> | null;
}>;

export type ControlTeamGuiObservation = Readonly<{
  schemaVersion: typeof CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION;
  collector: "crewon-ui-control-sse-v1";
  threadId: string;
  startedAt: string;
  updatedAt: string;
  complete: boolean;
  runs: readonly ControlTeamGuiRunObservation[];
  summary: Readonly<{
    modelRunCount: number;
    logicalPhaseCount: number;
    workerRecoveryRunCount: number;
    settledDurationMs: number | null;
    finalOutputFirstDeltaFromFirstRunAcceptedMs: number | null;
  }>;
}>;

type MutableRunObservation = {
  placement: ControlTeamRunAcceptedEvent;
  acceptedAt: string;
  acceptedAtMs: number;
  streamRequestedAtMs: number;
  createdAt: string | null;
  firstDeltaAtMs: number | null;
  previousDeltaAtMs: number | null;
  maxDeltaGapMs: number | null;
  reconnectCount: number;
  outputChunkCount: number;
  samplingRetryCount: number;
  transportFallbackCount: number;
  providerContinuationCount: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  terminal: ControlTeamGuiRunObservation["terminal"];
  controller: AbortController;
};

type MutableObservation = {
  threadId: string;
  startedAt: string;
  updatedAt: string;
  firstRunAcceptedAtMs: number;
  complete: boolean;
  runs: Map<string, MutableRunObservation>;
};

export type ControlTeamGuiObservationCollector = Readonly<{
  observeRunAccepted: (
    threadId: string,
    event: ControlTeamRunAcceptedEvent,
  ) => void;
  snapshots: () => readonly ControlTeamGuiObservation[];
  close: () => void;
}>;

export function controlTeamGuiObservationEnabled(
  search: string = browserSearch(),
): boolean {
  return (
    new URLSearchParams(search).get(CONTROL_TEAM_GUI_OBSERVATION_QUERY) === "1"
  );
}

/**
 * Creates an opt-in, read-only GUI collector. It observes accepted Team Runs
 * through Control SSE; it never starts execution and never calls PIM.
 */
export function createControlTeamGuiObservationCollector(input: {
  client: ControlApiClient;
  enabled?: boolean;
  eventStream?: RunEventStream;
  storage?: ObservationStorage | null;
  eventTarget?: ObservationEventTarget | null;
  document?: Document | null;
  clock?: ObservationClock;
  reconnectDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}): ControlTeamGuiObservationCollector | null {
  if (!(input.enabled ?? controlTeamGuiObservationEnabled())) return null;

  const eventStream = input.eventStream ?? streamRunEvents;
  const storage =
    input.storage === undefined ? browserStorage() : input.storage;
  const eventTarget =
    input.eventTarget === undefined ? browserEventTarget() : input.eventTarget;
  const document =
    input.document === undefined ? browserDocument() : input.document;
  const clock = input.clock ?? defaultClock();
  const reconnectDelay = input.reconnectDelay ?? defaultReconnectDelay;
  const observations = new Map<string, MutableObservation>();
  let closed = false;

  const snapshots = (): readonly ControlTeamGuiObservation[] =>
    [...observations.values()].map(projectObservation);

  const publish = (): void => {
    const value = snapshots().slice(-MAX_OBSERVATIONS);
    const serialized = JSON.stringify(value);
    try {
      storage?.setItem(CONTROL_TEAM_GUI_OBSERVATION_STORAGE_KEY, serialized);
    } catch {
      // Observation storage is best-effort and must never affect execution.
    }
    try {
      eventTarget?.dispatchEvent(
        new CustomEvent(CONTROL_TEAM_GUI_OBSERVATION_EVENT, {
          detail: value,
        }),
      );
    } catch {
      // Sandboxed browsers may not expose CustomEvent.
    }
    try {
      let element = document?.getElementById(
        CONTROL_TEAM_GUI_OBSERVATION_ELEMENT_ID,
      );
      if (document && element === null) {
        element = document.createElement("output");
        element.id = CONTROL_TEAM_GUI_OBSERVATION_ELEMENT_ID;
        element.hidden = true;
        document.body.append(element);
      }
      if (element) element.textContent = serialized;
    } catch {
      // The DOM export is only a GUI-test convenience.
    }
  };

  const observeRunAccepted = (
    threadId: string,
    event: ControlTeamRunAcceptedEvent,
  ): void => {
    if (closed) return;
    const existing = observations.get(threadId);
    const acceptedAtMs = clock.monotonicNow();
    const acceptedAt = clock.wallNow();
    const observation =
      existing ??
      ({
        threadId,
        startedAt: acceptedAt,
        updatedAt: acceptedAt,
        firstRunAcceptedAtMs: acceptedAtMs,
        complete: false,
        runs: new Map(),
      } satisfies MutableObservation);
    if (observation.runs.has(event.runId)) return;
    if (observation.complete) {
      observation.complete = false;
      observation.startedAt = acceptedAt;
      observation.firstRunAcceptedAtMs = acceptedAtMs;
      observation.runs.clear();
    }
    if (observation.runs.size >= MAX_RUNS_PER_OBSERVATION) return;
    observations.delete(threadId);
    observations.set(threadId, observation);
    while (observations.size > MAX_OBSERVATIONS) {
      const oldestThreadId = observations.keys().next().value as
        | string
        | undefined;
      if (oldestThreadId === undefined) break;
      for (const run of observations.get(oldestThreadId)?.runs.values() ?? []) {
        run.controller.abort();
      }
      observations.delete(oldestThreadId);
    }

    const controller = new AbortController();
    const run: MutableRunObservation = {
      placement: Object.freeze({ ...event }),
      acceptedAt,
      acceptedAtMs,
      streamRequestedAtMs: clock.monotonicNow(),
      createdAt: null,
      firstDeltaAtMs: null,
      previousDeltaAtMs: null,
      maxDeltaGapMs: null,
      reconnectCount: 0,
      outputChunkCount: 0,
      samplingRetryCount: 0,
      transportFallbackCount: 0,
      providerContinuationCount: 0,
      usage: null,
      terminal: null,
      controller,
    };
    observation.runs.set(event.runId, run);
    observation.updatedAt = acceptedAt;
    publish();
    void consumeRun({
      client: input.client,
      eventStream,
      reconnectDelay,
      clock,
      run,
      observation,
      isClosed: () => closed,
      publish,
    }).catch(() => undefined);
  };

  return {
    observeRunAccepted,
    snapshots,
    close: () => {
      closed = true;
      for (const observation of observations.values()) {
        for (const run of observation.runs.values()) {
          run.controller.abort();
        }
      }
    },
  };
}

async function consumeRun(input: {
  client: ControlApiClient;
  eventStream: RunEventStream;
  reconnectDelay: (attempt: number, signal: AbortSignal) => Promise<void>;
  clock: ObservationClock;
  run: MutableRunObservation;
  observation: MutableObservation;
  isClosed: () => boolean;
  publish: () => void;
}): Promise<void> {
  let afterSequence = 0;
  for (;;) {
    if (input.isClosed() || input.run.controller.signal.aborted) return;
    try {
      for await (const event of input.eventStream(input.client, {
        runId: input.run.placement.runId,
        afterSequence,
        view: "client",
        signal: input.run.controller.signal,
      })) {
        if (input.isClosed() || input.run.controller.signal.aborted) return;
        if (event.sequence <= afterSequence) continue;
        if (event.sequence !== afterSequence + 1) {
          throw new Error("control_team_gui_observation_sequence_gap");
        }
        afterSequence = event.sequence;
        observeEvent(input.run, event, input.clock.monotonicNow());
        input.observation.updatedAt = input.clock.wallNow();
        if (input.run.terminal !== null) {
          input.observation.complete = terminalRunCompletesTeam(
            input.run.placement.kind,
          );
          input.publish();
          return;
        }
      }
    } catch {
      if (input.isClosed() || input.run.controller.signal.aborted) return;
    }
    input.run.reconnectCount += 1;
    input.observation.updatedAt = input.clock.wallNow();
    input.publish();
    await input.reconnectDelay(
      input.run.reconnectCount,
      input.run.controller.signal,
    );
  }
}

function observeEvent(
  run: MutableRunObservation,
  event: RunEventView,
  observedAtMs: number,
): void {
  if (event.type === "run.created") {
    run.createdAt = event.occurredAt;
  } else if (event.type === "model.output.delta") {
    run.outputChunkCount += 1;
    if (run.firstDeltaAtMs === null) {
      run.firstDeltaAtMs = observedAtMs;
    }
    if (run.previousDeltaAtMs !== null) {
      const gap = nonNegativeRounded(observedAtMs - run.previousDeltaAtMs);
      run.maxDeltaGapMs =
        run.maxDeltaGapMs === null ? gap : Math.max(run.maxDeltaGapMs, gap);
    }
    run.previousDeltaAtMs = observedAtMs;
  } else if (event.type === "model.sampling.retry") {
    run.samplingRetryCount += 1;
  } else if (event.type === "model.transport.fallback") {
    run.transportFallbackCount += 1;
  } else if (event.type === "segment.provider_continuation") {
    run.providerContinuationCount += 1;
  } else if (event.type === "usage.recorded") {
    run.usage = {
      inputTokens: (run.usage?.inputTokens ?? 0) + event.data.inputTokens,
      outputTokens: (run.usage?.outputTokens ?? 0) + event.data.outputTokens,
      totalTokens: (run.usage?.totalTokens ?? 0) + event.data.totalTokens,
    };
  } else if (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.canceled"
  ) {
    run.terminal = {
      status:
        event.type === "run.completed"
          ? "completed"
          : event.type === "run.failed"
            ? "failed"
            : "canceled",
      sequence: event.sequence,
      occurredAt: event.occurredAt,
    };
  }
}

function projectObservation(
  observation: MutableObservation,
): ControlTeamGuiObservation {
  const runs = [...observation.runs.values()].map((run) => ({
    phaseIndex: run.placement.phaseIndex,
    kind: run.placement.kind,
    memberId: run.placement.memberId,
    agentVersionId: run.placement.agentVersionId,
    runId: run.placement.runId,
    runThreadId: run.placement.runThreadId,
    recoveredMemberId: run.placement.recoveredMemberId ?? null,
    acceptedAt: run.acceptedAt,
    createdAt: run.createdAt,
    controlSse: {
      firstDeltaMs:
        run.firstDeltaAtMs === null
          ? null
          : nonNegativeRounded(run.firstDeltaAtMs - run.streamRequestedAtMs),
      maxDeltaGapMs: run.maxDeltaGapMs,
      reconnectCount: run.reconnectCount,
      outputChunkCount: run.outputChunkCount,
    },
    signals: {
      samplingRetryCount: run.samplingRetryCount,
      transportFallbackCount: run.transportFallbackCount,
      providerContinuationCount: run.providerContinuationCount,
    },
    usage: run.usage === null ? null : { ...run.usage },
    terminal: run.terminal === null ? null : { ...run.terminal },
  }));
  const final = [...observation.runs.values()].find(
    (run) =>
      (run.placement.kind === "managerFinal" ||
        run.placement.kind === "memberFinal") &&
      run.firstDeltaAtMs !== null,
  );
  return {
    schemaVersion: CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION,
    collector: "crewon-ui-control-sse-v1",
    threadId: observation.threadId,
    startedAt: observation.startedAt,
    updatedAt: observation.updatedAt,
    complete: observation.complete,
    runs,
    summary: {
      modelRunCount: runs.length,
      logicalPhaseCount: new Set(runs.map(({ phaseIndex }) => phaseIndex)).size,
      workerRecoveryRunCount: runs.filter(
        ({ kind }) => kind === "workerRecovery",
      ).length,
      settledDurationMs: settledDurationMs(runs),
      finalOutputFirstDeltaFromFirstRunAcceptedMs:
        final?.firstDeltaAtMs === null || final === undefined
          ? null
          : nonNegativeRounded(
              final.firstDeltaAtMs - observation.firstRunAcceptedAtMs,
            ),
    },
  };
}

function settledDurationMs(
  runs: readonly ControlTeamGuiRunObservation[],
): number | null {
  const starts = runs.flatMap((run) => {
    const value = Date.parse(run.createdAt ?? run.acceptedAt);
    return Number.isFinite(value) ? [value] : [];
  });
  const terminals = runs.flatMap((run) => {
    if (run.terminal === null) return [];
    const value = Date.parse(run.terminal.occurredAt);
    return Number.isFinite(value) ? [value] : [];
  });
  if (starts.length === 0 || terminals.length !== runs.length) return null;
  return nonNegativeRounded(Math.max(...terminals) - Math.min(...starts));
}

function terminalRunCompletesTeam(
  kind: ControlTeamRunAcceptedEvent["kind"],
): boolean {
  return kind === "managerFinal" || kind === "memberFinal";
}

function nonNegativeRounded(value: number): number {
  return Math.max(0, Math.round(value));
}

function browserSearch(): string {
  try {
    return typeof window === "undefined" ? "" : window.location.search;
  } catch {
    return "";
  }
}

function browserStorage(): ObservationStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function browserEventTarget(): ObservationEventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function browserDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function defaultClock(): ObservationClock {
  return {
    monotonicNow: () => performance.now(),
    wallNow: () => new Date().toISOString(),
  };
}

async function defaultReconnectDelay(
  attempt: number,
  signal: AbortSignal,
): Promise<void> {
  const delayMs = Math.min(
    MAX_RECONNECT_DELAY_MS,
    250 * 2 ** Math.min(Math.max(0, attempt - 1), 4),
  );
  await waitForControlRuntimeDelay({ delayMs, signal });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}
