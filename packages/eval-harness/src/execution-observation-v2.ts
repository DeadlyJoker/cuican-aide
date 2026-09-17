import {
  parseTeamEffectGuiTrace,
  type TeamEffectGuiTrace,
} from "./team-effect-evaluation.ts";

export const TEAM_EFFECT_EXECUTION_OBSERVATION_SCHEMA_VERSION =
  "crewon.team-effect-execution-observation.v2" as const;

const MAX_OBSERVATION_ITEMS = 10_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type TeamEffectExecutionAuthority = "crewonKernel" | "providerAgent";

export type TeamEffectRunKind =
  | "managerPlanning"
  | "worker"
  | "workerRecovery"
  | "managerFinal"
  | "managerDelegation"
  | "memberFinal";

export type TeamEffectDurableAttemptKind =
  | "model"
  | "tool"
  | "agent"
  | "workflowNode"
  | "gate"
  | "verification";

export type TeamEffectProviderInvocationTrigger =
  | "initial"
  | "toolContinuation"
  | "recovery"
  | "samplingRetry";

export type TeamEffectProviderStreamObservation = Readonly<{
  firstDeltaMs: number | null;
  maxDeltaGapMs: number | null;
  reconnectCount: number | null;
  truncated: boolean | null;
}>;

export type TeamEffectProviderReceiptObservation = Readonly<{
  receiptId: string | null;
  terminalEventSequence: number | null;
  terminalDigest: string | null;
}>;

export type TeamEffectTokenUsageObservation = Readonly<{
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}>;

/** One call to the provider transport, including a sampling retry. */
export type TeamEffectProviderInvocationObservation = Readonly<{
  /** Provider-issued identity; null when the provider exposes none. */
  providerInvocationId: string | null;
  sequence: number;
  trigger: TeamEffectProviderInvocationTrigger;
  stream: TeamEffectProviderStreamObservation;
  receipt: TeamEffectProviderReceiptObservation | null;
  tokenUsage: TeamEffectTokenUsageObservation | null;
}>;

/** A durable CrewON attempt. One model attempt may invoke the provider repeatedly. */
export type TeamEffectDurableAttemptObservation = Readonly<{
  attemptId: string;
  sequence: number;
  kind: TeamEffectDurableAttemptKind;
  /** Null means invocations were opaque; [] means observed as zero. */
  providerInvocations:
    | readonly TeamEffectProviderInvocationObservation[]
    | null;
}>;

export type TeamEffectCrewonRunObservation = Readonly<{
  crewonRunId: string;
  sequence: number;
  phaseIndex: number;
  runKind: TeamEffectRunKind;
  executionAuthority: TeamEffectExecutionAuthority;
  /** Null means provider-owned internal agent steps were not observable. */
  providerInternalSteps: number | null;
  /** Null means durable attempts were opaque; [] means observed as zero. */
  durableAttempts: readonly TeamEffectDurableAttemptObservation[] | null;
}>;

export type TeamEffectUserTurnObservation = Readonly<{
  userTurnId: string;
  sequence: number;
  crewonRuns: readonly TeamEffectCrewonRunObservation[];
}>;

/**
 * A v2 sidecar for one v1 GUI trace. Keeping it separate leaves the strict v1
 * quality and comparison contracts unchanged while making execution work
 * observable at the correct layers.
 */
export type TeamEffectExecutionObservationV2 = Readonly<{
  schemaVersion: typeof TEAM_EFFECT_EXECUTION_OBSERVATION_SCHEMA_VERSION;
  traceId: string;
  capture: Readonly<{
    source: "gui";
    collector: string;
    capturedAt: string;
  }>;
  userTurns: readonly TeamEffectUserTurnObservation[];
}>;

export type TeamEffectExecutionObservationSummaryV2 = Readonly<{
  userTurnCount: number;
  crewonRunCount: number;
  durableAttemptCount: number | null;
  providerInvocationCount: number | null;
  initialInvocationCount: number | null;
  toolContinuationInvocationCount: number | null;
  recoveryInvocationCount: number | null;
  samplingRetryInvocationCount: number | null;
  workerRecoveryRunCount: number;
  providerInternalStepCount: number | null;
}>;

export type TeamEffectDeltaTimeline = Readonly<{
  requestStartedAtMs: number | null;
  deltaObservedAtMs: readonly number[] | null;
}>;

/**
 * Derives stream timing only from monotonic collector timestamps. A missing
 * timeline remains unknown; one delta has no measurable inter-delta gap.
 */
export function summarizeTeamEffectDeltaTimeline(
  input: TeamEffectDeltaTimeline,
): Readonly<{ firstDeltaMs: number | null; maxDeltaGapMs: number | null }> {
  const { requestStartedAtMs, deltaObservedAtMs } = input;
  if (requestStartedAtMs === null && deltaObservedAtMs === null) {
    return { firstDeltaMs: null, maxDeltaGapMs: null };
  }
  if (requestStartedAtMs === null || deltaObservedAtMs === null) {
    throw new TypeError("team_effect_delta_timeline_incomplete");
  }
  requireSafeInteger(
    requestStartedAtMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "team_effect_delta_timeline_start_invalid",
  );

  let prior = requestStartedAtMs;
  let maxDeltaGapMs: number | null = null;
  for (const [index, observedAtMs] of deltaObservedAtMs.entries()) {
    requireSafeInteger(
      observedAtMs,
      requestStartedAtMs,
      Number.MAX_SAFE_INTEGER,
      "team_effect_delta_timeline_sample_invalid",
    );
    if (observedAtMs < prior) {
      throw new TypeError("team_effect_delta_timeline_order_invalid");
    }
    if (index > 0) {
      const gap = observedAtMs - prior;
      maxDeltaGapMs =
        maxDeltaGapMs === null ? gap : Math.max(maxDeltaGapMs, gap);
    }
    prior = observedAtMs;
  }

  return {
    firstDeltaMs:
      deltaObservedAtMs.length === 0
        ? null
        : deltaObservedAtMs[0]! - requestStartedAtMs,
    maxDeltaGapMs: deltaObservedAtMs.length < 2 ? null : maxDeltaGapMs,
  };
}

/** Parses an execution sidecar without changing or upgrading a v1 GUI trace. */
export function parseTeamEffectExecutionObservationV2(
  input: unknown,
): TeamEffectExecutionObservationV2 {
  const value = requireRecord(input, "team_effect_observation_v2_invalid");
  requireExactKeys(value, ["capture", "schemaVersion", "traceId", "userTurns"]);
  if (
    value.schemaVersion !== TEAM_EFFECT_EXECUTION_OBSERVATION_SCHEMA_VERSION
  ) {
    throw new TypeError("team_effect_observation_v2_schema_version_invalid");
  }

  const capture = parseCapture(value.capture);
  if (
    !Array.isArray(value.userTurns) ||
    value.userTurns.length === 0 ||
    value.userTurns.length > MAX_OBSERVATION_ITEMS
  ) {
    throw new TypeError("team_effect_observation_v2_user_turns_invalid");
  }
  const userTurns = value.userTurns.map(parseUserTurn);
  requireUnique(
    userTurns.map(({ userTurnId }) => userTurnId),
    "team_effect_observation_v2_user_turn_id_duplicate",
  );
  requireStrictSequence(
    userTurns.map(({ sequence }) => sequence),
    "team_effect_observation_v2_user_turn_sequence_invalid",
  );

  const runs = userTurns.flatMap(({ crewonRuns }) => crewonRuns);
  requireUnique(
    runs.map(({ crewonRunId }) => crewonRunId),
    "team_effect_observation_v2_run_id_duplicate",
  );
  const attempts = runs.flatMap(({ durableAttempts }) => durableAttempts ?? []);
  requireUnique(
    attempts.map(({ attemptId }) => attemptId),
    "team_effect_observation_v2_attempt_id_duplicate",
  );
  const invocationIds = attempts.flatMap(({ providerInvocations }) =>
    (providerInvocations ?? []).flatMap(({ providerInvocationId }) =>
      providerInvocationId === null ? [] : [providerInvocationId],
    ),
  );
  requireUnique(
    invocationIds,
    "team_effect_observation_v2_provider_invocation_id_duplicate",
  );

  return {
    schemaVersion: TEAM_EFFECT_EXECUTION_OBSERVATION_SCHEMA_VERSION,
    traceId: requireIdentifier(
      value.traceId,
      "team_effect_observation_v2_trace_id_invalid",
    ),
    capture,
    userTurns,
  };
}

/** Fails closed before a sidecar can be attributed to a different GUI trace. */
export function requireMatchingTeamEffectExecutionObservationV2(
  traceInput: TeamEffectGuiTrace,
  observationInput: TeamEffectExecutionObservationV2,
): TeamEffectExecutionObservationV2 {
  const trace = parseTeamEffectGuiTrace(traceInput);
  const observation = parseTeamEffectExecutionObservationV2(observationInput);
  if (observation.traceId !== trace.traceId) {
    throw new TypeError("team_effect_observation_v2_trace_mismatch");
  }
  if (observation.capture.collector !== trace.capture.collector) {
    throw new TypeError("team_effect_observation_v2_collector_mismatch");
  }
  if (observation.capture.capturedAt !== trace.capture.capturedAt) {
    throw new TypeError("team_effect_observation_v2_capture_time_mismatch");
  }
  return observation;
}

/**
 * Counts only explicitly observed work. If any enclosing layer is opaque, the
 * dependent aggregate remains null rather than a misleading lower bound.
 */
export function summarizeTeamEffectExecutionObservationV2(
  input: TeamEffectExecutionObservationV2,
): TeamEffectExecutionObservationSummaryV2 {
  const observation = parseTeamEffectExecutionObservationV2(input);
  const runs = observation.userTurns.flatMap(({ crewonRuns }) => crewonRuns);
  const attemptsObservable = runs.every(
    ({ durableAttempts }) => durableAttempts !== null,
  );
  const attempts = attemptsObservable
    ? runs.flatMap(({ durableAttempts }) => durableAttempts ?? [])
    : null;
  const invocationsObservable =
    attempts !== null &&
    attempts.every(({ providerInvocations }) => providerInvocations !== null);
  const invocations = invocationsObservable
    ? attempts!.flatMap(({ providerInvocations }) => providerInvocations ?? [])
    : null;
  const internalStepsObservable = runs.every(
    ({ providerInternalSteps }) => providerInternalSteps !== null,
  );

  return {
    userTurnCount: observation.userTurns.length,
    crewonRunCount: runs.length,
    durableAttemptCount: attempts?.length ?? null,
    providerInvocationCount: invocations?.length ?? null,
    initialInvocationCount: countInvocations(invocations, "initial"),
    toolContinuationInvocationCount: countInvocations(
      invocations,
      "toolContinuation",
    ),
    recoveryInvocationCount: countInvocations(invocations, "recovery"),
    samplingRetryInvocationCount: countInvocations(
      invocations,
      "samplingRetry",
    ),
    workerRecoveryRunCount: runs.filter(
      ({ runKind }) => runKind === "workerRecovery",
    ).length,
    providerInternalStepCount: internalStepsObservable
      ? runs.reduce(
          (sum, { providerInternalSteps }) =>
            sum + (providerInternalSteps ?? 0),
          0,
        )
      : null,
  };
}

function countInvocations(
  invocations: readonly TeamEffectProviderInvocationObservation[] | null,
  trigger: TeamEffectProviderInvocationTrigger,
): number | null {
  return (
    invocations?.filter((invocation) => invocation.trigger === trigger)
      .length ?? null
  );
}

function parseCapture(
  input: unknown,
): TeamEffectExecutionObservationV2["capture"] {
  const value = requireRecord(
    input,
    "team_effect_observation_v2_capture_invalid",
  );
  requireExactKeys(value, ["capturedAt", "collector", "source"]);
  if (value.source !== "gui") {
    throw new TypeError("team_effect_observation_v2_capture_source_invalid");
  }
  const capturedAt = requireString(
    value.capturedAt,
    64,
    "team_effect_observation_v2_capture_time_invalid",
  );
  const capturedTimestamp = Date.parse(capturedAt);
  if (
    !Number.isFinite(capturedTimestamp) ||
    new Date(capturedTimestamp).toISOString() !== capturedAt
  ) {
    throw new TypeError("team_effect_observation_v2_capture_time_invalid");
  }
  return {
    source: "gui",
    collector: requireString(
      value.collector,
      128,
      "team_effect_observation_v2_collector_invalid",
    ),
    capturedAt,
  };
}

function parseUserTurn(
  input: unknown,
  index: number,
): TeamEffectUserTurnObservation {
  const value = requireRecord(
    input,
    `team_effect_observation_v2_user_turn_${index}_invalid`,
  );
  requireExactKeys(value, ["crewonRuns", "sequence", "userTurnId"]);
  if (
    !Array.isArray(value.crewonRuns) ||
    value.crewonRuns.length > MAX_OBSERVATION_ITEMS
  ) {
    throw new TypeError(
      `team_effect_observation_v2_user_turn_${index}_runs_invalid`,
    );
  }
  const crewonRuns = value.crewonRuns.map((run, runIndex) =>
    parseCrewonRun(run, index, runIndex),
  );
  requireStrictSequence(
    crewonRuns.map(({ sequence }) => sequence),
    `team_effect_observation_v2_user_turn_${index}_run_sequence_invalid`,
  );
  return {
    userTurnId: requireIdentifier(
      value.userTurnId,
      `team_effect_observation_v2_user_turn_${index}_id_invalid`,
    ),
    sequence: requireSafeInteger(
      value.sequence,
      1,
      MAX_OBSERVATION_ITEMS,
      `team_effect_observation_v2_user_turn_${index}_sequence_invalid`,
    ),
    crewonRuns,
  };
}

function parseCrewonRun(
  input: unknown,
  userTurnIndex: number,
  runIndex: number,
): TeamEffectCrewonRunObservation {
  const code = `team_effect_observation_v2_user_turn_${userTurnIndex}_run_${runIndex}`;
  const value = requireRecord(input, `${code}_invalid`);
  requireExactKeys(value, [
    "crewonRunId",
    "durableAttempts",
    "executionAuthority",
    "phaseIndex",
    "providerInternalSteps",
    "runKind",
    "sequence",
  ]);
  if (!isExecutionAuthority(value.executionAuthority)) {
    throw new TypeError(`${code}_execution_authority_invalid`);
  }
  if (!isRunKind(value.runKind)) {
    throw new TypeError(`${code}_run_kind_invalid`);
  }
  return {
    crewonRunId: requireIdentifier(value.crewonRunId, `${code}_id_invalid`),
    sequence: requireSafeInteger(
      value.sequence,
      1,
      MAX_OBSERVATION_ITEMS,
      `${code}_sequence_invalid`,
    ),
    phaseIndex: requireSafeInteger(
      value.phaseIndex,
      0,
      MAX_OBSERVATION_ITEMS,
      `${code}_phase_index_invalid`,
    ),
    runKind: value.runKind,
    executionAuthority: value.executionAuthority,
    providerInternalSteps: requireNullableSafeInteger(
      value.providerInternalSteps,
      0,
      MAX_OBSERVATION_ITEMS,
      `${code}_provider_internal_steps_invalid`,
    ),
    durableAttempts: parseDurableAttempts(value.durableAttempts, code),
  };
}

function parseDurableAttempts(
  input: unknown,
  runCode: string,
): readonly TeamEffectDurableAttemptObservation[] | null {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > MAX_OBSERVATION_ITEMS) {
    throw new TypeError(`${runCode}_durable_attempts_invalid`);
  }
  const attempts = input.map((attempt, attemptIndex) =>
    parseDurableAttempt(attempt, runCode, attemptIndex),
  );
  requireStrictSequence(
    attempts.map(({ sequence }) => sequence),
    `${runCode}_durable_attempt_sequence_invalid`,
  );
  return attempts;
}

function parseDurableAttempt(
  input: unknown,
  runCode: string,
  attemptIndex: number,
): TeamEffectDurableAttemptObservation {
  const code = `${runCode}_durable_attempt_${attemptIndex}`;
  const value = requireRecord(input, `${code}_invalid`);
  requireExactKeys(value, [
    "attemptId",
    "kind",
    "providerInvocations",
    "sequence",
  ]);
  if (!isDurableAttemptKind(value.kind)) {
    throw new TypeError(`${code}_kind_invalid`);
  }
  return {
    attemptId: requireIdentifier(value.attemptId, `${code}_id_invalid`),
    sequence: requireSafeInteger(
      value.sequence,
      1,
      MAX_OBSERVATION_ITEMS,
      `${code}_sequence_invalid`,
    ),
    kind: value.kind,
    providerInvocations: parseProviderInvocations(
      value.providerInvocations,
      code,
    ),
  };
}

function parseProviderInvocations(
  input: unknown,
  attemptCode: string,
): readonly TeamEffectProviderInvocationObservation[] | null {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > MAX_OBSERVATION_ITEMS) {
    throw new TypeError(`${attemptCode}_provider_invocations_invalid`);
  }
  const invocations = input.map((invocation, invocationIndex) =>
    parseProviderInvocation(invocation, attemptCode, invocationIndex),
  );
  requireStrictSequence(
    invocations.map(({ sequence }) => sequence),
    `${attemptCode}_provider_invocation_sequence_invalid`,
  );
  return invocations;
}

function parseProviderInvocation(
  input: unknown,
  attemptCode: string,
  invocationIndex: number,
): TeamEffectProviderInvocationObservation {
  const code = `${attemptCode}_provider_invocation_${invocationIndex}`;
  const value = requireRecord(input, `${code}_invalid`);
  requireExactKeys(value, [
    "providerInvocationId",
    "receipt",
    "sequence",
    "stream",
    "tokenUsage",
    "trigger",
  ]);
  if (!isProviderInvocationTrigger(value.trigger)) {
    throw new TypeError(`${code}_trigger_invalid`);
  }
  return {
    providerInvocationId: requireNullableString(
      value.providerInvocationId,
      256,
      `${code}_provider_invocation_id_invalid`,
    ),
    sequence: requireSafeInteger(
      value.sequence,
      1,
      MAX_OBSERVATION_ITEMS,
      `${code}_sequence_invalid`,
    ),
    trigger: value.trigger,
    stream: parseStream(value.stream, code),
    receipt: parseReceipt(value.receipt, code),
    tokenUsage: parseTokenUsage(value.tokenUsage, code),
  };
}

function parseStream(
  input: unknown,
  invocationCode: string,
): TeamEffectProviderStreamObservation {
  const value = requireRecord(input, `${invocationCode}_stream_invalid`);
  requireExactKeys(value, [
    "firstDeltaMs",
    "maxDeltaGapMs",
    "reconnectCount",
    "truncated",
  ]);
  const firstDeltaMs = requireNullableSafeInteger(
    value.firstDeltaMs,
    0,
    MAX_DURATION_MS,
    `${invocationCode}_first_delta_invalid`,
  );
  const maxDeltaGapMs = requireNullableSafeInteger(
    value.maxDeltaGapMs,
    0,
    MAX_DURATION_MS,
    `${invocationCode}_max_delta_gap_invalid`,
  );
  if (firstDeltaMs === null && maxDeltaGapMs !== null) {
    throw new TypeError(`${invocationCode}_stream_timeline_invalid`);
  }
  if (value.truncated !== null && typeof value.truncated !== "boolean") {
    throw new TypeError(`${invocationCode}_truncated_invalid`);
  }
  return {
    firstDeltaMs,
    maxDeltaGapMs,
    reconnectCount: requireNullableSafeInteger(
      value.reconnectCount,
      0,
      MAX_OBSERVATION_ITEMS,
      `${invocationCode}_reconnect_count_invalid`,
    ),
    truncated: value.truncated,
  };
}

function parseReceipt(
  input: unknown,
  invocationCode: string,
): TeamEffectProviderReceiptObservation | null {
  if (input === null) return null;
  const value = requireRecord(input, `${invocationCode}_receipt_invalid`);
  requireExactKeys(value, [
    "receiptId",
    "terminalDigest",
    "terminalEventSequence",
  ]);
  const receipt = {
    receiptId: requireNullableString(
      value.receiptId,
      256,
      `${invocationCode}_receipt_id_invalid`,
    ),
    terminalEventSequence: requireNullableSafeInteger(
      value.terminalEventSequence,
      0,
      MAX_COUNTER,
      `${invocationCode}_terminal_event_sequence_invalid`,
    ),
    terminalDigest: requireNullableString(
      value.terminalDigest,
      512,
      `${invocationCode}_terminal_digest_invalid`,
    ),
  };
  if (Object.values(receipt).every((field) => field === null)) {
    throw new TypeError(`${invocationCode}_receipt_empty`);
  }
  return receipt;
}

function parseTokenUsage(
  input: unknown,
  invocationCode: string,
): TeamEffectTokenUsageObservation | null {
  if (input === null) return null;
  const value = requireRecord(input, `${invocationCode}_token_usage_invalid`);
  requireExactKeys(value, [
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "totalTokens",
  ]);
  const tokenUsage = {
    inputTokens: requireNullableSafeInteger(
      value.inputTokens,
      0,
      MAX_COUNTER,
      `${invocationCode}_input_tokens_invalid`,
    ),
    cachedInputTokens: requireNullableSafeInteger(
      value.cachedInputTokens,
      0,
      MAX_COUNTER,
      `${invocationCode}_cached_input_tokens_invalid`,
    ),
    outputTokens: requireNullableSafeInteger(
      value.outputTokens,
      0,
      MAX_COUNTER,
      `${invocationCode}_output_tokens_invalid`,
    ),
    totalTokens: requireNullableSafeInteger(
      value.totalTokens,
      0,
      MAX_COUNTER,
      `${invocationCode}_total_tokens_invalid`,
    ),
  };
  if (Object.values(tokenUsage).every((field) => field === null)) {
    throw new TypeError(`${invocationCode}_token_usage_empty`);
  }
  if (
    tokenUsage.cachedInputTokens !== null &&
    tokenUsage.inputTokens !== null &&
    tokenUsage.cachedInputTokens > tokenUsage.inputTokens
  ) {
    throw new TypeError(`${invocationCode}_cached_input_tokens_exceed_input`);
  }
  if (
    tokenUsage.inputTokens !== null &&
    tokenUsage.outputTokens !== null &&
    tokenUsage.totalTokens !== null &&
    tokenUsage.totalTokens !== tokenUsage.inputTokens + tokenUsage.outputTokens
  ) {
    throw new TypeError(`${invocationCode}_total_tokens_mismatch`);
  }
  return tokenUsage;
}

function isExecutionAuthority(
  input: unknown,
): input is TeamEffectExecutionAuthority {
  return input === "crewonKernel" || input === "providerAgent";
}

function isRunKind(input: unknown): input is TeamEffectRunKind {
  return (
    input === "managerPlanning" ||
    input === "worker" ||
    input === "workerRecovery" ||
    input === "managerFinal" ||
    input === "managerDelegation" ||
    input === "memberFinal"
  );
}

function isDurableAttemptKind(
  input: unknown,
): input is TeamEffectDurableAttemptKind {
  return (
    input === "model" ||
    input === "tool" ||
    input === "agent" ||
    input === "workflowNode" ||
    input === "gate" ||
    input === "verification"
  );
}

function isProviderInvocationTrigger(
  input: unknown,
): input is TeamEffectProviderInvocationTrigger {
  return (
    input === "initial" ||
    input === "toolContinuation" ||
    input === "recovery" ||
    input === "samplingRetry"
  );
}

function requireRecord(input: unknown, code: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(code);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(code);
  }
  return input as Record<string, unknown>;
}

function requireExactKeys(
  input: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("team_effect_observation_v2_fields_invalid");
  }
}

function requireIdentifier(input: unknown, code: string): string {
  const value = requireString(input, 128, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(code);
  }
  return value;
}

function requireString(
  input: unknown,
  maxLength: number,
  code: string,
): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    Array.from(input).length > maxLength
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireNullableString(
  input: unknown,
  maxLength: number,
  code: string,
): string | null {
  return input === null ? null : requireString(input, maxLength, code);
}

function requireSafeInteger(
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

function requireNullableSafeInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number | null {
  return input === null
    ? null
    : requireSafeInteger(input, minimum, maximum, code);
}

function requireUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(code);
}

function requireStrictSequence(values: readonly number[], code: string): void {
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    throw new TypeError(code);
  }
}
