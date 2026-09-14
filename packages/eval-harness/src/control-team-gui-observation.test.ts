import assert from "node:assert/strict";
import test from "node:test";

import {
  parseControlTeamGuiObservation,
  parseControlTeamGuiObservations,
  teamEffectEfficiencyFromControlTeamGuiObservation,
} from "./control-team-gui-observation.ts";

test("parses a complete GUI observation and exports only semantically matching efficiency", () => {
  const observation = parseControlTeamGuiObservation(fixture());

  assert.deepEqual(
    teamEffectEfficiencyFromControlTeamGuiObservation(observation),
    {
      modelRunCount: 2,
      logicalPhaseCount: 2,
      timeToFirstVisibleOutputMs: null,
      settledDurationMs: 2_000,
    },
  );
  assert.deepEqual(parseControlTeamGuiObservations([fixture()]), [observation]);
});

test("rejects derived summary drift", () => {
  const input = fixture();
  input.summary.modelRunCount = 3;
  assert.throws(
    () => parseControlTeamGuiObservation(input),
    /control_team_gui_summary_count_mismatch/u,
  );
});

test("rejects a false complete snapshot while a worker stream is unresolved", () => {
  const input = fixture();
  input.runs[0]!.terminal = null;
  input.summary.settledDurationMs = null;
  assert.throws(
    () => parseControlTeamGuiObservation(input),
    /control_team_gui_completion_mismatch/u,
  );
});

test("rejects a complete snapshot without a terminal final Run", () => {
  const input = fixture();
  input.runs.pop();
  input.summary.modelRunCount = 1;
  input.summary.logicalPhaseCount = 1;
  input.summary.settledDurationMs = 1_000;
  input.summary.finalOutputFirstDeltaFromFirstRunAcceptedMs = null;
  assert.throws(
    () => parseControlTeamGuiObservation(input),
    /control_team_gui_completion_mismatch/u,
  );
});

test("does not export efficiency from an incomplete observation", () => {
  const input = fixture();
  input.complete = false;
  input.runs[1]!.terminal = null;
  input.runs[1]!.controlSse.outputChunkCount = 0;
  input.runs[1]!.controlSse.firstDeltaMs = null;
  input.runs[1]!.controlSse.maxDeltaGapMs = null;
  input.summary.settledDurationMs = null;
  input.summary.finalOutputFirstDeltaFromFirstRunAcceptedMs = null;
  const observation = parseControlTeamGuiObservation(input);

  assert.throws(
    () => teamEffectEfficiencyFromControlTeamGuiObservation(observation),
    /control_team_gui_observation_not_settled/u,
  );
});

test("rejects Control-SSE timing that invents a first delta", () => {
  const input = fixture();
  input.runs[0]!.controlSse.outputChunkCount = 0;
  assert.throws(
    () => parseControlTeamGuiObservation(input),
    /control_team_gui_delta_timing_invalid/u,
  );
});

type MutableObservationFixture = Record<string, unknown> & {
  complete: boolean;
  runs: Array<
    Record<string, unknown> & {
      terminal: Record<string, unknown> | null;
      controlSse: {
        firstDeltaMs: number | null;
        maxDeltaGapMs: number | null;
        reconnectCount: number;
        outputChunkCount: number;
      };
    }
  >;
  summary: {
    modelRunCount: number;
    logicalPhaseCount: number;
    workerRecoveryRunCount: number;
    settledDurationMs: number | null;
    finalOutputFirstDeltaFromFirstRunAcceptedMs: number | null;
  };
};

function fixture(): MutableObservationFixture {
  return {
    schemaVersion: "crewon.control-team-gui-observation.v1",
    collector: "crewon-ui-control-sse-v1",
    threadId: "thread-main",
    startedAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:02.000Z",
    complete: true,
    runs: [
      {
        phaseIndex: 0,
        kind: "worker",
        memberId: "member-worker",
        agentVersionId: "agent-worker-v1",
        runId: "run-worker",
        runThreadId: "thread-worker",
        recoveredMemberId: null,
        acceptedAt: "2026-09-07T00:00:00.000Z",
        createdAt: "2026-09-07T00:00:00.000Z",
        controlSse: {
          firstDeltaMs: 120,
          maxDeltaGapMs: 80,
          reconnectCount: 0,
          outputChunkCount: 2,
        },
        signals: {
          samplingRetryCount: 0,
          transportFallbackCount: 0,
          providerContinuationCount: 0,
        },
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        terminal: {
          status: "completed",
          sequence: 9,
          occurredAt: "2026-09-07T00:00:01.000Z",
        },
      },
      {
        phaseIndex: 1,
        kind: "managerFinal",
        memberId: "member-manager",
        agentVersionId: "agent-manager-v1",
        runId: "run-final",
        runThreadId: "thread-main",
        recoveredMemberId: null,
        acceptedAt: "2026-09-07T00:00:01.000Z",
        createdAt: "2026-09-07T00:00:01.000Z",
        controlSse: {
          firstDeltaMs: 100,
          maxDeltaGapMs: 20,
          reconnectCount: 0,
          outputChunkCount: 3,
        },
        signals: {
          samplingRetryCount: 1,
          transportFallbackCount: 0,
          providerContinuationCount: 0,
        },
        usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
        terminal: {
          status: "completed",
          sequence: 10,
          occurredAt: "2026-09-07T00:00:02.000Z",
        },
      },
    ],
    summary: {
      modelRunCount: 2,
      logicalPhaseCount: 2,
      workerRecoveryRunCount: 0,
      settledDurationMs: 2_000,
      finalOutputFirstDeltaFromFirstRunAcceptedMs: 1_100,
    },
  };
}
