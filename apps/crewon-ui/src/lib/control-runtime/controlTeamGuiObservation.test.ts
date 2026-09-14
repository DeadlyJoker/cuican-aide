import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunEventView } from "@crewon/contracts";
import type { ControlApiClient } from "@crewon/control-client";

import {
  CONTROL_TEAM_GUI_OBSERVATION_STORAGE_KEY,
  controlTeamGuiObservationEnabled,
  createControlTeamGuiObservationCollector,
} from "./controlTeamGuiObservation";
import type { ControlTeamRunAcceptedEvent } from "./controlTeamRuntime";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("controlTeamGuiObservationEnabled", () => {
  it("requires an explicit exact query opt-in", () => {
    expect(controlTeamGuiObservationEnabled("?crewonTeamObserve=1")).toBe(true);
    expect(controlTeamGuiObservationEnabled("?crewonTeamObserve=true")).toBe(
      false,
    );
    expect(controlTeamGuiObservationEnabled("")).toBe(false);
  });
});

describe("createControlTeamGuiObservationCollector", () => {
  it("stays inert when observation is disabled", () => {
    expect(
      createControlTeamGuiObservationCollector({
        client: {} as ControlApiClient,
        enabled: false,
      }),
    ).toBeNull();
  });

  it("collects bounded Team phase, SSE timing, retry, usage, and terminal facts", async () => {
    const storage = memoryStorage();
    const now = monotonicClock();
    const eventStream = vi.fn(async function* (
      _client: ControlApiClient,
      input: { runId: string },
    ) {
      const isFinal = input.runId === "run-final";
      yield runEvent(input.runId, 1, "run.created", {
        threadId: isFinal ? "thread-main" : "thread-worker",
      });
      yield runEvent(input.runId, 2, "segment.started", {
        segmentId: `${input.runId}-segment`,
        attempt: 1,
      });
      yield runEvent(input.runId, 3, "model.output.delta", {
        segmentId: `${input.runId}-segment`,
        delta: "first",
      });
      yield runEvent(input.runId, 4, "model.output.delta", {
        segmentId: `${input.runId}-segment`,
        delta: "second",
      });
      yield runEvent(input.runId, 5, "model.sampling.retry", {
        segmentId: `${input.runId}-segment`,
        samplingAttempt: 1,
        maxRetries: 2,
        code: "retry",
        discardedOutput: true,
      });
      yield runEvent(input.runId, 6, "model.transport.fallback", {
        segmentId: `${input.runId}-segment`,
        fromTransport: "responses",
        toTransport: "chatCompletions",
        code: "fallback",
        discardedOutput: false,
      });
      yield runEvent(input.runId, 7, "segment.provider_continuation", {
        segmentId: `${input.runId}-segment`,
        sampleIndex: 1,
        throughHistorySequence: 1,
      });
      yield runEvent(input.runId, 8, "usage.recorded", {
        segmentId: `${input.runId}-segment`,
        inputTokens: isFinal ? 20 : 10,
        outputTokens: isFinal ? 4 : 2,
        totalTokens: isFinal ? 24 : 12,
      });
      yield runEvent(input.runId, 9, "run.completed", {
        outputRef: null,
      });
    });
    const collector = createControlTeamGuiObservationCollector({
      client: {} as ControlApiClient,
      enabled: true,
      eventStream,
      storage,
      eventTarget: null,
      document: null,
      clock: {
        monotonicNow: now,
        wallNow: wallClock(),
      },
      reconnectDelay: async () => undefined,
    });

    collector!.observeRunAccepted(
      "thread-main",
      acceptedRun("run-worker", "thread-worker", 0, "worker"),
    );
    collector!.observeRunAccepted(
      "thread-main",
      acceptedRun("run-final", "thread-main", 1, "managerFinal"),
    );
    await eventually(() => collector!.snapshots()[0]?.complete === true);

    const observation = collector!.snapshots()[0]!;
    expect(observation.summary).toEqual({
      modelRunCount: 2,
      logicalPhaseCount: 2,
      workerRecoveryRunCount: 0,
      settledDurationMs: 0,
      finalOutputFirstDeltaFromFirstRunAcceptedMs: expect.any(Number),
    });
    expect(observation.runs).toHaveLength(2);
    expect(observation.runs[0]).toMatchObject({
      kind: "worker",
      controlSse: {
        firstDeltaMs: expect.any(Number),
        maxDeltaGapMs: expect.any(Number),
        reconnectCount: 0,
        outputChunkCount: 2,
      },
      signals: {
        samplingRetryCount: 1,
        transportFallbackCount: 1,
        providerContinuationCount: 1,
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      terminal: { status: "completed", sequence: 9 },
    });
    expect(
      JSON.parse(
        storage.getItem(CONTROL_TEAM_GUI_OBSERVATION_STORAGE_KEY) ?? "null",
      ),
    ).toEqual(collector!.snapshots());
  });

  it("reconnects from the last durable sequence without double counting", async () => {
    let attempt = 0;
    const eventStream = vi.fn(async function* (
      _client: ControlApiClient,
      input: { runId: string; afterSequence?: number },
    ) {
      attempt += 1;
      if (attempt === 1) {
        expect(input.afterSequence).toBe(0);
        yield runEvent(input.runId, 1, "run.created", {
          threadId: "thread-main",
        });
        yield runEvent(input.runId, 2, "model.output.delta", {
          segmentId: "segment-1",
          delta: "one",
        });
        throw new Error("network_reset");
      }
      expect(input.afterSequence).toBe(2);
      yield runEvent(input.runId, 3, "model.output.delta", {
        segmentId: "segment-1",
        delta: "two",
      });
      yield runEvent(input.runId, 4, "run.completed", { outputRef: null });
    });
    const collector = createControlTeamGuiObservationCollector({
      client: {} as ControlApiClient,
      enabled: true,
      eventStream,
      storage: null,
      eventTarget: null,
      document: null,
      clock: {
        monotonicNow: monotonicClock(),
        wallNow: wallClock(),
      },
      reconnectDelay: async () => undefined,
    });

    collector!.observeRunAccepted(
      "thread-main",
      acceptedRun("run-final", "thread-main", 1, "managerFinal"),
    );
    await eventually(() => collector!.snapshots()[0]?.complete === true);

    expect(eventStream).toHaveBeenCalledTimes(2);
    expect(collector!.snapshots()[0]?.runs[0]).toMatchObject({
      controlSse: {
        reconnectCount: 1,
        outputChunkCount: 2,
      },
    });
  });
});

function acceptedRun(
  runId: string,
  runThreadId: string,
  phaseIndex: number,
  kind: ControlTeamRunAcceptedEvent["kind"],
): ControlTeamRunAcceptedEvent {
  return {
    phaseIndex,
    kind,
    memberId: kind === "worker" ? "member-worker" : "member-manager",
    agentVersionId: kind === "worker" ? "agent-worker-v1" : "agent-manager-v1",
    runId,
    runThreadId,
  };
}

function runEvent<T extends RunEventView["type"]>(
  runId: string,
  sequence: number,
  type: T,
  data: Extract<RunEventView, { type: T }>["data"],
): Extract<RunEventView, { type: T }> {
  return {
    eventId: `${runId}-event-${sequence}`,
    runId,
    sequence,
    occurredAt: "2026-09-07T00:00:00.000Z",
    type,
    data,
  } as Extract<RunEventView, { type: T }>;
}

function monotonicClock(): () => number {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
}

function wallClock(): () => string {
  let value = 0;
  return () => new Date(Date.UTC(2026, 8, 7, 0, 0, 0, value++)).toISOString();
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition_not_reached");
}
