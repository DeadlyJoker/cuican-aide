import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  parseTeamEffectExecutionObservationV2,
  requireMatchingTeamEffectExecutionObservationV2,
  summarizeTeamEffectDeltaTimeline,
  summarizeTeamEffectExecutionObservationV2,
  type TeamEffectExecutionObservationV2,
} from "./execution-observation-v2.ts";
import { parseTeamEffectGuiTrace } from "./team-effect-evaluation.ts";

const completeObservation: TeamEffectExecutionObservationV2 = {
  schemaVersion: "crewon.team-effect-execution-observation.v2",
  traceId: "gui-trace-001",
  capture: {
    source: "gui",
    collector: "electron-cdp-v2",
    capturedAt: "2026-09-04T10:15:30.000Z",
  },
  userTurns: [
    {
      userTurnId: "turn-001",
      sequence: 1,
      crewonRuns: [
        {
          crewonRunId: "run-001",
          sequence: 1,
          phaseIndex: 0,
          runKind: "worker",
          executionAuthority: "crewonKernel",
          providerInternalSteps: 0,
          durableAttempts: [
            {
              attemptId: "attempt-001",
              sequence: 1,
              kind: "model",
              providerInvocations: [
                {
                  providerInvocationId: "invocation-001",
                  sequence: 1,
                  trigger: "initial",
                  stream: {
                    firstDeltaMs: 120,
                    maxDeltaGapMs: 44,
                    reconnectCount: 0,
                    truncated: false,
                  },
                  receipt: {
                    receiptId: "receipt-001",
                    terminalEventSequence: 12,
                    terminalDigest: "sha256:terminal-001",
                  },
                  tokenUsage: {
                    inputTokens: 240,
                    cachedInputTokens: 20,
                    outputTokens: 80,
                    totalTokens: 320,
                  },
                },
                {
                  providerInvocationId: "invocation-002",
                  sequence: 2,
                  trigger: "samplingRetry",
                  stream: {
                    firstDeltaMs: 90,
                    maxDeltaGapMs: null,
                    reconnectCount: 1,
                    truncated: false,
                  },
                  receipt: null,
                  tokenUsage: {
                    inputTokens: null,
                    cachedInputTokens: null,
                    outputTokens: null,
                    totalTokens: 175,
                  },
                },
              ],
            },
            {
              attemptId: "attempt-002",
              sequence: 2,
              kind: "model",
              providerInvocations: [
                {
                  providerInvocationId: "invocation-003",
                  sequence: 1,
                  trigger: "toolContinuation",
                  stream: {
                    firstDeltaMs: null,
                    maxDeltaGapMs: null,
                    reconnectCount: null,
                    truncated: null,
                  },
                  receipt: null,
                  tokenUsage: null,
                },
              ],
            },
          ],
        },
      ],
    },
    {
      userTurnId: "turn-002",
      sequence: 2,
      crewonRuns: [
        {
          crewonRunId: "run-002",
          sequence: 1,
          phaseIndex: 1,
          runKind: "workerRecovery",
          executionAuthority: "providerAgent",
          providerInternalSteps: 3,
          durableAttempts: [
            {
              attemptId: "attempt-003",
              sequence: 1,
              kind: "agent",
              providerInvocations: [
                {
                  providerInvocationId: null,
                  sequence: 1,
                  trigger: "recovery",
                  stream: {
                    firstDeltaMs: null,
                    maxDeltaGapMs: null,
                    reconnectCount: null,
                    truncated: null,
                  },
                  receipt: {
                    receiptId: null,
                    terminalEventSequence: null,
                    terminalDigest: "opaque-provider-terminal",
                  },
                  tokenUsage: null,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

test("parses turn, Run, durable attempt, and provider invocation separately", () => {
  const parsed = parseTeamEffectExecutionObservationV2(completeObservation);

  assert.deepEqual(parsed, completeObservation);
  assert.equal(
    parsed.userTurns[0]?.crewonRuns[0]?.executionAuthority,
    "crewonKernel",
  );
  assert.equal(parsed.userTurns[1]?.crewonRuns[0]?.runKind, "workerRecovery");
  assert.deepEqual(summarizeTeamEffectExecutionObservationV2(parsed), {
    userTurnCount: 2,
    crewonRunCount: 2,
    durableAttemptCount: 3,
    providerInvocationCount: 4,
    initialInvocationCount: 1,
    toolContinuationInvocationCount: 1,
    recoveryInvocationCount: 1,
    samplingRetryInvocationCount: 1,
    workerRecoveryRunCount: 1,
    providerInternalStepCount: 3,
  });
});

test("keeps opaque work unknown instead of treating it as zero", () => {
  const opaque: TeamEffectExecutionObservationV2 = {
    ...completeObservation,
    traceId: "gui-trace-opaque",
    userTurns: [
      {
        userTurnId: "turn-opaque",
        sequence: 1,
        crewonRuns: [
          {
            crewonRunId: "run-opaque",
            sequence: 1,
            phaseIndex: 0,
            runKind: "memberFinal",
            executionAuthority: "providerAgent",
            providerInternalSteps: null,
            durableAttempts: null,
          },
        ],
      },
    ],
  };

  assert.deepEqual(summarizeTeamEffectExecutionObservationV2(opaque), {
    userTurnCount: 1,
    crewonRunCount: 1,
    durableAttemptCount: null,
    providerInvocationCount: null,
    initialInvocationCount: null,
    toolContinuationInvocationCount: null,
    recoveryInvocationCount: null,
    samplingRetryInvocationCount: null,
    workerRecoveryRunCount: 0,
    providerInternalStepCount: null,
  });

  const observedZero: TeamEffectExecutionObservationV2 = {
    ...opaque,
    traceId: "gui-trace-observed-zero",
    userTurns: [
      {
        ...opaque.userTurns[0]!,
        crewonRuns: [
          {
            ...opaque.userTurns[0]!.crewonRuns[0]!,
            providerInternalSteps: 0,
            durableAttempts: [],
          },
        ],
      },
    ],
  };
  assert.deepEqual(summarizeTeamEffectExecutionObservationV2(observedZero), {
    userTurnCount: 1,
    crewonRunCount: 1,
    durableAttemptCount: 0,
    providerInvocationCount: 0,
    initialInvocationCount: 0,
    toolContinuationInvocationCount: 0,
    recoveryInvocationCount: 0,
    samplingRetryInvocationCount: 0,
    workerRecoveryRunCount: 0,
    providerInternalStepCount: 0,
  });

  const opaqueInvocations: TeamEffectExecutionObservationV2 = {
    ...observedZero,
    traceId: "gui-trace-opaque-invocations",
    userTurns: [
      {
        ...observedZero.userTurns[0]!,
        crewonRuns: [
          {
            ...observedZero.userTurns[0]!.crewonRuns[0]!,
            durableAttempts: [
              {
                attemptId: "attempt-opaque",
                sequence: 1,
                kind: "model",
                providerInvocations: null,
              },
            ],
          },
        ],
      },
    ],
  };
  const summary = summarizeTeamEffectExecutionObservationV2(opaqueInvocations);
  assert.equal(summary.durableAttemptCount, 1);
  assert.equal(summary.providerInvocationCount, null);
  assert.equal(summary.samplingRetryInvocationCount, null);
});

test("derives first-delta and maximum inter-delta gap from timestamps", () => {
  assert.deepEqual(
    summarizeTeamEffectDeltaTimeline({
      requestStartedAtMs: null,
      deltaObservedAtMs: null,
    }),
    { firstDeltaMs: null, maxDeltaGapMs: null },
  );
  assert.deepEqual(
    summarizeTeamEffectDeltaTimeline({
      requestStartedAtMs: 1_000,
      deltaObservedAtMs: [],
    }),
    { firstDeltaMs: null, maxDeltaGapMs: null },
  );
  assert.deepEqual(
    summarizeTeamEffectDeltaTimeline({
      requestStartedAtMs: 1_000,
      deltaObservedAtMs: [1_125],
    }),
    { firstDeltaMs: 125, maxDeltaGapMs: null },
  );
  assert.deepEqual(
    summarizeTeamEffectDeltaTimeline({
      requestStartedAtMs: 1_000,
      deltaObservedAtMs: [1_000, 1_015, 1_090, 1_110],
    }),
    { firstDeltaMs: 0, maxDeltaGapMs: 75 },
  );
  assert.deepEqual(
    summarizeTeamEffectDeltaTimeline({
      requestStartedAtMs: 0,
      deltaObservedAtMs: [0, 100],
    }),
    { firstDeltaMs: 0, maxDeltaGapMs: 100 },
  );

  assert.throws(
    () =>
      summarizeTeamEffectDeltaTimeline({
        requestStartedAtMs: null,
        deltaObservedAtMs: [],
      }),
    /team_effect_delta_timeline_incomplete/u,
  );
  assert.throws(
    () =>
      summarizeTeamEffectDeltaTimeline({
        requestStartedAtMs: 1_000,
        deltaObservedAtMs: [1_050, 1_049],
      }),
    /team_effect_delta_timeline_order_invalid/u,
  );
});

test("binds a v2 sidecar to the exact v1 trace capture", () => {
  const v1 = parseTeamEffectGuiTrace(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/example-release-decision.candidate.gui-trace.v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown,
  );
  const matching: TeamEffectExecutionObservationV2 = {
    ...completeObservation,
    traceId: v1.traceId,
    capture: v1.capture,
  };
  assert.equal(
    requireMatchingTeamEffectExecutionObservationV2(v1, matching).traceId,
    v1.traceId,
  );

  assert.throws(
    () =>
      requireMatchingTeamEffectExecutionObservationV2(v1, {
        ...matching,
        traceId: "another-trace",
      }),
    /team_effect_observation_v2_trace_mismatch/u,
  );
  assert.throws(
    () =>
      requireMatchingTeamEffectExecutionObservationV2(v1, {
        ...matching,
        capture: { ...matching.capture, collector: "another-collector" },
      }),
    /team_effect_observation_v2_collector_mismatch/u,
  );
  assert.throws(
    () =>
      requireMatchingTeamEffectExecutionObservationV2(v1, {
        ...matching,
        capture: {
          ...matching.capture,
          capturedAt: "2026-09-04T10:15:31.000Z",
        },
      }),
    /team_effect_observation_v2_capture_time_mismatch/u,
  );
});

test("requires explicit nulls and rejects partial pseudo-evidence", () => {
  const run = completeObservation.userTurns[0]!.crewonRuns[0]!;
  const attempt = run.durableAttempts![0]!;
  const invocation = attempt.providerInvocations![0]!;

  assert.throws(
    () =>
      parseTeamEffectExecutionObservationV2({
        ...completeObservation,
        unexpected: true,
      }),
    /team_effect_observation_v2_fields_invalid/u,
  );
  assert.throws(
    () =>
      parseWithInvocationOverride({
        ...invocation,
        stream: {
          ...invocation.stream,
          firstDeltaMs: null,
          maxDeltaGapMs: 10,
        },
      }),
    /stream_timeline_invalid/u,
  );
  assert.throws(
    () =>
      parseWithInvocationOverride({
        ...invocation,
        receipt: {
          receiptId: null,
          terminalEventSequence: null,
          terminalDigest: null,
        },
      }),
    /receipt_empty/u,
  );
  assert.throws(
    () =>
      parseWithInvocationOverride({
        ...invocation,
        tokenUsage: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          totalTokens: null,
        },
      }),
    /token_usage_empty/u,
  );
});

function parseWithInvocationOverride(invocation: unknown): void {
  const run = completeObservation.userTurns[0]!.crewonRuns[0]!;
  const attempt = run.durableAttempts![0]!;
  parseTeamEffectExecutionObservationV2({
    ...completeObservation,
    userTurns: [
      {
        ...completeObservation.userTurns[0]!,
        crewonRuns: [
          {
            ...run,
            durableAttempts: [
              {
                ...attempt,
                providerInvocations: [invocation],
              },
            ],
          },
        ],
      },
    ],
  });
}
