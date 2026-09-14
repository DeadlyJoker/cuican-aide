import type { TeamEffectEfficiency } from "./team-effect-evaluation.ts";

export const CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION =
  "crewon.control-team-gui-observation.v1" as const;

const MAX_OBSERVATIONS = 16;
const MAX_RUNS = 32;
const MAX_ID_CHARACTERS = 512;

export type ControlTeamGuiRunKind =
  | "managerPlanning"
  | "worker"
  | "workerRecovery"
  | "managerFinal"
  | "managerDelegation"
  | "memberFinal";

export type ControlTeamGuiRunObservation = Readonly<{
  phaseIndex: number;
  kind: ControlTeamGuiRunKind;
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

/** Parses the bounded JSON artifact exported by CrewON's opt-in GUI observer. */
export function parseControlTeamGuiObservations(
  input: unknown,
): readonly ControlTeamGuiObservation[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_OBSERVATIONS
  ) {
    throw new TypeError("control_team_gui_observations_invalid");
  }
  const observations = input.map(parseControlTeamGuiObservation);
  requireUnique(
    observations.map(({ threadId }) => threadId),
    "control_team_gui_observation_thread_duplicate",
  );
  return observations;
}

export function parseControlTeamGuiObservation(
  input: unknown,
): ControlTeamGuiObservation {
  const value = requireRecord(input, "control_team_gui_observation_invalid");
  requireExactKeys(value, [
    "collector",
    "complete",
    "runs",
    "schemaVersion",
    "startedAt",
    "summary",
    "threadId",
    "updatedAt",
  ]);
  if (
    value.schemaVersion !== CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION ||
    value.collector !== "crewon-ui-control-sse-v1" ||
    typeof value.complete !== "boolean"
  ) {
    throw new TypeError("control_team_gui_observation_header_invalid");
  }
  if (!Array.isArray(value.runs) || value.runs.length > MAX_RUNS) {
    throw new TypeError("control_team_gui_observation_runs_invalid");
  }
  const runs = value.runs.map(parseRun);
  requireUnique(
    runs.map(({ runId }) => runId),
    "control_team_gui_observation_run_duplicate",
  );
  const summary = parseSummary(value.summary);
  const observation: ControlTeamGuiObservation = {
    schemaVersion: CONTROL_TEAM_GUI_OBSERVATION_SCHEMA_VERSION,
    collector: "crewon-ui-control-sse-v1",
    threadId: requireId(
      value.threadId,
      "control_team_gui_observation_thread_id_invalid",
    ),
    startedAt: requireTimestamp(
      value.startedAt,
      "control_team_gui_observation_started_at_invalid",
    ),
    updatedAt: requireTimestamp(
      value.updatedAt,
      "control_team_gui_observation_updated_at_invalid",
    ),
    complete: value.complete,
    runs,
    summary,
  };
  validateDerivedFacts(observation);
  return observation;
}

/**
 * Converts only measurements whose semantics match the v1 quality harness.
 * Control-SSE timing starts at Run observation, not at GUI submit, so the
 * user-visible first-output metric deliberately remains unknown.
 */
export function teamEffectEfficiencyFromControlTeamGuiObservation(
  observation: ControlTeamGuiObservation,
): TeamEffectEfficiency {
  if (
    !observation.complete ||
    observation.runs.length === 0 ||
    observation.runs.some(({ terminal }) => terminal === null) ||
    observation.summary.settledDurationMs === null
  ) {
    throw new TypeError("control_team_gui_observation_not_settled");
  }
  return {
    modelRunCount: observation.summary.modelRunCount,
    logicalPhaseCount: observation.summary.logicalPhaseCount,
    timeToFirstVisibleOutputMs: null,
    settledDurationMs: observation.summary.settledDurationMs,
  };
}

function parseRun(input: unknown): ControlTeamGuiRunObservation {
  const value = requireRecord(input, "control_team_gui_run_invalid");
  requireExactKeys(value, [
    "acceptedAt",
    "agentVersionId",
    "controlSse",
    "createdAt",
    "kind",
    "memberId",
    "phaseIndex",
    "recoveredMemberId",
    "runId",
    "runThreadId",
    "signals",
    "terminal",
    "usage",
  ]);
  const kind = requireRunKind(value.kind);
  const recoveredMemberId = requireNullableId(
    value.recoveredMemberId,
    "control_team_gui_run_recovered_member_id_invalid",
  );
  if ((kind === "workerRecovery") !== (recoveredMemberId !== null)) {
    throw new TypeError("control_team_gui_run_recovery_identity_invalid");
  }
  return {
    phaseIndex: requireInteger(
      value.phaseIndex,
      0,
      MAX_RUNS,
      "control_team_gui_run_phase_invalid",
    ),
    kind,
    memberId: requireId(value.memberId, "control_team_gui_run_member_invalid"),
    agentVersionId: requireId(
      value.agentVersionId,
      "control_team_gui_run_agent_version_invalid",
    ),
    runId: requireId(value.runId, "control_team_gui_run_id_invalid"),
    runThreadId: requireId(
      value.runThreadId,
      "control_team_gui_run_thread_id_invalid",
    ),
    recoveredMemberId,
    acceptedAt: requireTimestamp(
      value.acceptedAt,
      "control_team_gui_run_accepted_at_invalid",
    ),
    createdAt:
      value.createdAt === null
        ? null
        : requireTimestamp(
            value.createdAt,
            "control_team_gui_run_created_at_invalid",
          ),
    controlSse: parseControlSse(value.controlSse),
    signals: parseSignals(value.signals),
    usage: value.usage === null ? null : parseUsage(value.usage),
    terminal: value.terminal === null ? null : parseTerminal(value.terminal),
  };
}

function parseControlSse(
  input: unknown,
): ControlTeamGuiRunObservation["controlSse"] {
  const value = requireRecord(input, "control_team_gui_control_sse_invalid");
  requireExactKeys(value, [
    "firstDeltaMs",
    "maxDeltaGapMs",
    "outputChunkCount",
    "reconnectCount",
  ]);
  const outputChunkCount = requireCounter(
    value.outputChunkCount,
    "control_team_gui_output_chunk_count_invalid",
  );
  const firstDeltaMs = requireNullableCounter(
    value.firstDeltaMs,
    "control_team_gui_first_delta_invalid",
  );
  const maxDeltaGapMs = requireNullableCounter(
    value.maxDeltaGapMs,
    "control_team_gui_max_delta_gap_invalid",
  );
  if (
    (outputChunkCount === 0) !== (firstDeltaMs === null) ||
    outputChunkCount < 2 !== (maxDeltaGapMs === null)
  ) {
    throw new TypeError("control_team_gui_delta_timing_invalid");
  }
  return {
    firstDeltaMs,
    maxDeltaGapMs,
    reconnectCount: requireCounter(
      value.reconnectCount,
      "control_team_gui_reconnect_count_invalid",
    ),
    outputChunkCount,
  };
}

function parseSignals(input: unknown): ControlTeamGuiRunObservation["signals"] {
  const value = requireRecord(input, "control_team_gui_signals_invalid");
  requireExactKeys(value, [
    "providerContinuationCount",
    "samplingRetryCount",
    "transportFallbackCount",
  ]);
  return {
    samplingRetryCount: requireCounter(
      value.samplingRetryCount,
      "control_team_gui_sampling_retry_count_invalid",
    ),
    transportFallbackCount: requireCounter(
      value.transportFallbackCount,
      "control_team_gui_transport_fallback_count_invalid",
    ),
    providerContinuationCount: requireCounter(
      value.providerContinuationCount,
      "control_team_gui_provider_continuation_count_invalid",
    ),
  };
}

function parseUsage(
  input: unknown,
): NonNullable<ControlTeamGuiRunObservation["usage"]> {
  const value = requireRecord(input, "control_team_gui_usage_invalid");
  requireExactKeys(value, ["inputTokens", "outputTokens", "totalTokens"]);
  const inputTokens = requireCounter(
    value.inputTokens,
    "control_team_gui_input_tokens_invalid",
  );
  const outputTokens = requireCounter(
    value.outputTokens,
    "control_team_gui_output_tokens_invalid",
  );
  const totalTokens = requireCounter(
    value.totalTokens,
    "control_team_gui_total_tokens_invalid",
  );
  if (inputTokens + outputTokens !== totalTokens) {
    throw new TypeError("control_team_gui_total_tokens_mismatch");
  }
  return { inputTokens, outputTokens, totalTokens };
}

function parseTerminal(
  input: unknown,
): NonNullable<ControlTeamGuiRunObservation["terminal"]> {
  const value = requireRecord(input, "control_team_gui_terminal_invalid");
  requireExactKeys(value, ["occurredAt", "sequence", "status"]);
  if (!["completed", "failed", "canceled"].includes(String(value.status))) {
    throw new TypeError("control_team_gui_terminal_status_invalid");
  }
  return {
    status: value.status as "completed" | "failed" | "canceled",
    sequence: requireInteger(
      value.sequence,
      1,
      Number.MAX_SAFE_INTEGER,
      "control_team_gui_terminal_sequence_invalid",
    ),
    occurredAt: requireTimestamp(
      value.occurredAt,
      "control_team_gui_terminal_occurred_at_invalid",
    ),
  };
}

function parseSummary(input: unknown): ControlTeamGuiObservation["summary"] {
  const value = requireRecord(input, "control_team_gui_summary_invalid");
  requireExactKeys(value, [
    "finalOutputFirstDeltaFromFirstRunAcceptedMs",
    "logicalPhaseCount",
    "modelRunCount",
    "settledDurationMs",
    "workerRecoveryRunCount",
  ]);
  return {
    modelRunCount: requireCounter(
      value.modelRunCount,
      "control_team_gui_model_run_count_invalid",
    ),
    logicalPhaseCount: requireCounter(
      value.logicalPhaseCount,
      "control_team_gui_phase_count_invalid",
    ),
    workerRecoveryRunCount: requireCounter(
      value.workerRecoveryRunCount,
      "control_team_gui_recovery_count_invalid",
    ),
    settledDurationMs: requireNullableCounter(
      value.settledDurationMs,
      "control_team_gui_settled_duration_invalid",
    ),
    finalOutputFirstDeltaFromFirstRunAcceptedMs: requireNullableCounter(
      value.finalOutputFirstDeltaFromFirstRunAcceptedMs,
      "control_team_gui_final_delta_invalid",
    ),
  };
}

function validateDerivedFacts(observation: ControlTeamGuiObservation): void {
  const { runs, summary } = observation;
  if (
    summary.modelRunCount !== runs.length ||
    summary.logicalPhaseCount !==
      new Set(runs.map(({ phaseIndex }) => phaseIndex)).size ||
    summary.workerRecoveryRunCount !==
      runs.filter(({ kind }) => kind === "workerRecovery").length
  ) {
    throw new TypeError("control_team_gui_summary_count_mismatch");
  }
  const finalRun = runs.find(
    ({ kind }) => kind === "managerFinal" || kind === "memberFinal",
  );
  const finalRunTerminal = finalRun !== undefined && finalRun.terminal !== null;
  const allTerminal =
    runs.length > 0 && runs.every(({ terminal }) => terminal !== null);
  if (
    observation.complete !== finalRunTerminal ||
    (observation.complete && !allTerminal)
  ) {
    throw new TypeError("control_team_gui_completion_mismatch");
  }
  const derivedDuration = allTerminal ? settledDurationMs(runs) : null;
  if (summary.settledDurationMs !== derivedDuration) {
    throw new TypeError("control_team_gui_settled_duration_mismatch");
  }
  const finalHasOutput = (finalRun?.controlSse.outputChunkCount ?? 0) > 0;
  if (
    finalHasOutput !==
    (summary.finalOutputFirstDeltaFromFirstRunAcceptedMs !== null)
  ) {
    throw new TypeError("control_team_gui_final_delta_mismatch");
  }
}

function settledDurationMs(
  runs: readonly ControlTeamGuiRunObservation[],
): number {
  const starts = runs.map((run) => Date.parse(run.createdAt ?? run.acceptedAt));
  const terminals = runs.map((run) => Date.parse(run.terminal!.occurredAt));
  return Math.max(0, Math.round(Math.max(...terminals) - Math.min(...starts)));
}

function requireRunKind(input: unknown): ControlTeamGuiRunKind {
  if (
    ![
      "managerPlanning",
      "worker",
      "workerRecovery",
      "managerFinal",
      "managerDelegation",
      "memberFinal",
    ].includes(String(input))
  ) {
    throw new TypeError("control_team_gui_run_kind_invalid");
  }
  return input as ControlTeamGuiRunKind;
}

function requireNullableId(input: unknown, code: string): string | null {
  return input === null ? null : requireId(input, code);
}

function requireId(input: unknown, code: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_ID_CHARACTERS ||
    input.trim() !== input
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireTimestamp(input: unknown, code: string): string {
  if (
    typeof input !== "string" ||
    !Number.isFinite(Date.parse(input)) ||
    new Date(input).toISOString() !== input
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireCounter(input: unknown, code: string): number {
  return requireInteger(input, 0, Number.MAX_SAFE_INTEGER, code);
}

function requireNullableCounter(input: unknown, code: string): number | null {
  return input === null ? null : requireCounter(input, code);
}

function requireInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireRecord(input: unknown, code: string): Record<string, unknown> {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new TypeError(code);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(input).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError("control_team_gui_observation_keys_invalid");
  }
}

function requireUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(code);
}
