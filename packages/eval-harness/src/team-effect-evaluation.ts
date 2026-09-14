export const TEAM_EFFECT_CASE_SCHEMA_VERSION =
  "crewon.team-effect-case.v1" as const;
export const TEAM_EFFECT_GUI_TRACE_SCHEMA_VERSION =
  "crewon.team-effect-gui-trace.v1" as const;
export const TEAM_EFFECT_QUALITY_RESULT_SCHEMA_VERSION =
  "crewon.team-effect-quality-result.v1" as const;
export const TEAM_EFFECT_COMPARISON_SCHEMA_VERSION =
  "crewon.team-effect-comparison.v1" as const;

const MAX_CASE_LABELS = 32;
const MAX_EXPECTED_FRAGMENTS = 8;
const MAX_PROMPT_CHARACTERS = 32 * 1024;
const MAX_ANSWER_CHARACTERS = 128 * 1024;
const MIN_VARIANT_AGENTS = 2;
const MAX_VARIANT_AGENTS = 6;
const EFFICIENCY_METRICS = [
  "modelRunCount",
  "logicalPhaseCount",
  "timeToFirstVisibleOutputMs",
  "settledDurationMs",
] as const satisfies readonly TeamEffectEfficiencyMetric[];

export type TeamEffectLabelKind =
  | "decision"
  | "evidence"
  | "conflict"
  | "unknown";

export type TeamEffectLabelExpectation = Readonly<{
  id: string;
  kind: TeamEffectLabelKind;
  label: string;
  expectedFragments: readonly string[];
  exactContent: string | null;
  minContentCharacters: number;
}>;

export type TeamEffectCase = Readonly<{
  schemaVersion: typeof TEAM_EFFECT_CASE_SCHEMA_VERSION;
  caseId: string;
  caseRevision: string;
  title: string;
  prompt: string;
  expectedMemberIds: readonly string[];
  qualityGate: Readonly<{
    authoredOrder: readonly string[];
    maxAnswerCharacters: number;
    allowUnlabelledText: boolean;
    labels: readonly TeamEffectLabelExpectation[];
  }>;
  efficiencyGate: TeamEffectEfficiencyGate;
}>;

export type TeamEffectVariantAgent = Readonly<{
  memberId: string;
  agentVersionId: string;
  agentVersionDigest: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
  capabilityProfileId: string | null;
}>;

export type TeamEffectVariant = Readonly<{
  variantId: string;
  promptVariantId: string;
  harnessVersion: string;
  buildRevision: string;
  agents: readonly TeamEffectVariantAgent[];
}>;

export type TeamEffectEfficiency = Readonly<{
  modelRunCount: number | null;
  logicalPhaseCount: number | null;
  timeToFirstVisibleOutputMs: number | null;
  settledDurationMs: number | null;
}>;

export type TeamEffectEfficiencyMetric = keyof TeamEffectEfficiency;

export type TeamEffectEfficiencyMetricGate = Readonly<{
  maxRegressionPercent: number | null;
  minImprovementPercent: number | null;
}>;

export type TeamEffectEfficiencyGate = Readonly<
  Record<TeamEffectEfficiencyMetric, TeamEffectEfficiencyMetricGate>
>;

export type TeamEffectGuiTrace = Readonly<{
  schemaVersion: typeof TEAM_EFFECT_GUI_TRACE_SCHEMA_VERSION;
  caseId: string;
  caseRevision: string;
  traceId: string;
  submittedPrompt: string;
  capture: Readonly<{
    source: "gui";
    collector: string;
    capturedAt: string;
  }>;
  variant: TeamEffectVariant;
  answer: Readonly<{ text: string }>;
  ui: Readonly<{
    userMessageCopies: number;
    errorText: string | null;
    pending: boolean;
  }>;
  efficiency: TeamEffectEfficiency;
}>;

export type TeamEffectGateFailureCode =
  | "label_missing"
  | "label_duplicate"
  | "label_syntax_invalid"
  | "label_content_empty"
  | "label_content_too_short"
  | "label_exact_content_mismatch"
  | "label_order_invalid"
  | "expected_fragment_missing"
  | "answer_too_long"
  | "unlabelled_text"
  | "user_message_copy_count_invalid"
  | "ui_error_visible"
  | "ui_pending";

export type TeamEffectGateFailure = Readonly<{
  code: TeamEffectGateFailureCode;
  labelId: string | null;
  kind: TeamEffectLabelKind | "answer" | "ui";
  detail: string;
}>;

export type TeamEffectQualityResult = Readonly<{
  schemaVersion: typeof TEAM_EFFECT_QUALITY_RESULT_SCHEMA_VERSION;
  caseId: string;
  caseRevision: string;
  traceId: string;
  variantId: string;
  passed: boolean;
  failures: readonly TeamEffectGateFailure[];
}>;

export type TeamEffectMetricComparison = Readonly<{
  baseline: number;
  candidate: number;
  candidateDelta: number;
  improvementPercent: number | null;
}>;

export type TeamEffectEfficiencyComparison = Readonly<{
  modelRunCount: TeamEffectMetricComparison | null;
  logicalPhaseCount: TeamEffectMetricComparison | null;
  timeToFirstVisibleOutputMs: TeamEffectMetricComparison | null;
  settledDurationMs: TeamEffectMetricComparison | null;
}>;

export type TeamEffectEfficiencyFailure =
  | Readonly<{
      code: "measurement_missing";
      metric: TeamEffectEfficiencyMetric;
      baseline: number | null;
      candidate: number | null;
      maxRegressionPercent: number | null;
      minImprovementPercent: number | null;
      improvementPercent: null;
      regressionPercent: null;
      detail: string;
    }>
  | Readonly<{
      code: "regression_exceeded";
      metric: TeamEffectEfficiencyMetric;
      baseline: number;
      candidate: number;
      maxRegressionPercent: number;
      regressionPercent: number | null;
      detail: string;
    }>
  | Readonly<{
      code: "minimum_improvement_not_met";
      metric: TeamEffectEfficiencyMetric;
      baseline: number;
      candidate: number;
      minImprovementPercent: number;
      improvementPercent: number | null;
      detail: string;
    }>;

export type TeamEffectComparison =
  | Readonly<{
      schemaVersion: typeof TEAM_EFFECT_COMPARISON_SCHEMA_VERSION;
      caseId: string;
      caseRevision: string;
      baselineQuality: TeamEffectQualityResult;
      candidateQuality: TeamEffectQualityResult;
      status: "notCompared";
      reason:
        | "correctness_gate_failed"
        | "measurement_cohort_mismatch"
        | "model_cohort_mismatch"
        | "efficiency_metrics_unavailable"
        | "gated_efficiency_metric_unavailable";
      efficiency: null;
      efficiencyFailures: readonly TeamEffectEfficiencyFailure[];
    }>
  | Readonly<{
      schemaVersion: typeof TEAM_EFFECT_COMPARISON_SCHEMA_VERSION;
      caseId: string;
      caseRevision: string;
      baselineQuality: TeamEffectQualityResult;
      candidateQuality: TeamEffectQualityResult;
      status: "compared";
      reason: null;
      efficiency: TeamEffectEfficiencyComparison;
      efficiencyFailures: readonly TeamEffectEfficiencyFailure[];
    }>;

/** Parses the authored acceptance contract. Unknown versions and fields fail closed. */
export function parseTeamEffectCase(input: unknown): TeamEffectCase {
  const value = requireRecord(input, "team_effect_case_invalid");
  requireExactKeys(value, [
    "caseId",
    "caseRevision",
    "efficiencyGate",
    "expectedMemberIds",
    "prompt",
    "qualityGate",
    "schemaVersion",
    "title",
  ]);
  if (value.schemaVersion !== TEAM_EFFECT_CASE_SCHEMA_VERSION) {
    throw new TypeError("team_effect_case_schema_version_invalid");
  }
  const qualityGate = requireRecord(
    value.qualityGate,
    "team_effect_quality_gate_invalid",
  );
  requireExactKeys(qualityGate, [
    "allowUnlabelledText",
    "authoredOrder",
    "labels",
    "maxAnswerCharacters",
  ]);
  if (
    !Array.isArray(qualityGate.labels) ||
    qualityGate.labels.length < 4 ||
    qualityGate.labels.length > MAX_CASE_LABELS
  ) {
    throw new TypeError("team_effect_labels_invalid");
  }
  const labels = qualityGate.labels.map(parseLabelExpectation);
  requireUnique(
    labels.map(({ id }) => id),
    "team_effect_label_id_duplicate",
  );
  requireUnique(
    labels.map(({ label }) => label),
    "team_effect_label_duplicate",
  );
  if (
    labels.some((left, index) =>
      labels.some(
        (right, rightIndex) =>
          index !== rightIndex && right.label.startsWith(left.label),
      ),
    )
  ) {
    throw new TypeError("team_effect_label_prefix_ambiguous");
  }
  for (const kind of ["decision", "evidence", "conflict", "unknown"] as const) {
    if (!labels.some((label) => label.kind === kind)) {
      throw new TypeError(`team_effect_${kind}_gate_missing`);
    }
  }
  if (
    !labels.some(
      (label) => label.kind === "decision" && label.exactContent !== null,
    )
  ) {
    throw new TypeError("team_effect_exact_decision_gate_missing");
  }
  if (
    !Array.isArray(qualityGate.authoredOrder) ||
    qualityGate.authoredOrder.length !== labels.length
  ) {
    throw new TypeError("team_effect_authored_order_invalid");
  }
  const authoredOrder = qualityGate.authoredOrder.map((id) =>
    requireId(id, "team_effect_authored_order_invalid"),
  );
  requireUnique(authoredOrder, "team_effect_authored_order_invalid");
  const labelIds = new Set(labels.map(({ id }) => id));
  if (authoredOrder.some((id) => !labelIds.has(id))) {
    throw new TypeError("team_effect_authored_order_invalid");
  }
  if (typeof qualityGate.allowUnlabelledText !== "boolean") {
    throw new TypeError("team_effect_allow_unlabelled_text_invalid");
  }
  if (
    !Array.isArray(value.expectedMemberIds) ||
    value.expectedMemberIds.length < MIN_VARIANT_AGENTS ||
    value.expectedMemberIds.length > MAX_VARIANT_AGENTS
  ) {
    throw new TypeError("team_effect_expected_member_ids_invalid");
  }
  const expectedMemberIds = value.expectedMemberIds.map((memberId) =>
    requireId(memberId, "team_effect_expected_member_ids_invalid"),
  );
  requireUnique(expectedMemberIds, "team_effect_expected_member_id_duplicate");
  return {
    schemaVersion: TEAM_EFFECT_CASE_SCHEMA_VERSION,
    caseId: requireId(value.caseId, "team_effect_case_id_invalid"),
    caseRevision: requireId(
      value.caseRevision,
      "team_effect_case_revision_invalid",
    ),
    title: requireNormalizedString(
      value.title,
      256,
      "team_effect_case_title_invalid",
    ),
    prompt: requireNormalizedString(
      value.prompt,
      MAX_PROMPT_CHARACTERS,
      "team_effect_case_prompt_invalid",
    ),
    expectedMemberIds,
    qualityGate: {
      authoredOrder,
      maxAnswerCharacters: requireInteger(
        qualityGate.maxAnswerCharacters,
        1,
        MAX_ANSWER_CHARACTERS,
        "team_effect_max_answer_characters_invalid",
      ),
      allowUnlabelledText: qualityGate.allowUnlabelledText,
      labels,
    },
    efficiencyGate: parseEfficiencyGate(value.efficiencyGate),
  };
}

/** Accepts only an offline artifact explicitly captured by a GUI collector. */
export function parseTeamEffectGuiTrace(input: unknown): TeamEffectGuiTrace {
  const value = requireRecord(input, "team_effect_trace_invalid");
  requireExactKeys(value, [
    "answer",
    "capture",
    "caseId",
    "caseRevision",
    "efficiency",
    "schemaVersion",
    "submittedPrompt",
    "traceId",
    "ui",
    "variant",
  ]);
  if (value.schemaVersion !== TEAM_EFFECT_GUI_TRACE_SCHEMA_VERSION) {
    throw new TypeError("team_effect_trace_schema_version_invalid");
  }

  const capture = requireRecord(value.capture, "team_effect_capture_invalid");
  requireExactKeys(capture, ["capturedAt", "collector", "source"]);
  if (capture.source !== "gui") {
    throw new TypeError("team_effect_capture_source_invalid");
  }
  const capturedAt = requireString(
    capture.capturedAt,
    64,
    "team_effect_capture_time_invalid",
  );
  const capturedTimestamp = Date.parse(capturedAt);
  if (
    !Number.isFinite(capturedTimestamp) ||
    new Date(capturedTimestamp).toISOString() !== capturedAt
  ) {
    throw new TypeError("team_effect_capture_time_invalid");
  }

  const answer = requireRecord(value.answer, "team_effect_answer_invalid");
  requireExactKeys(answer, ["text"]);
  const ui = requireRecord(value.ui, "team_effect_ui_invalid");
  requireExactKeys(ui, ["errorText", "pending", "userMessageCopies"]);
  if (typeof ui.pending !== "boolean") {
    throw new TypeError("team_effect_ui_pending_invalid");
  }
  const errorText = requireNullableString(
    ui.errorText,
    2_000,
    "team_effect_ui_error_invalid",
  );

  const efficiency = parseEfficiency(value.efficiency);
  if (
    efficiency.timeToFirstVisibleOutputMs !== null &&
    efficiency.settledDurationMs !== null &&
    efficiency.timeToFirstVisibleOutputMs > efficiency.settledDurationMs
  ) {
    throw new TypeError("team_effect_efficiency_timeline_invalid");
  }

  return {
    schemaVersion: TEAM_EFFECT_GUI_TRACE_SCHEMA_VERSION,
    caseId: requireId(value.caseId, "team_effect_trace_case_id_invalid"),
    caseRevision: requireId(
      value.caseRevision,
      "team_effect_trace_case_revision_invalid",
    ),
    traceId: requireId(value.traceId, "team_effect_trace_id_invalid"),
    submittedPrompt: requireNormalizedString(
      value.submittedPrompt,
      MAX_PROMPT_CHARACTERS,
      "team_effect_submitted_prompt_invalid",
    ),
    capture: {
      source: "gui",
      collector: requireString(
        capture.collector,
        128,
        "team_effect_collector_invalid",
      ),
      capturedAt,
    },
    variant: parseVariant(value.variant),
    answer: {
      text: requireString(
        answer.text,
        MAX_ANSWER_CHARACTERS,
        "team_effect_answer_text_invalid",
        true,
      ),
    },
    ui: {
      userMessageCopies: requireInteger(
        ui.userMessageCopies,
        0,
        100,
        "team_effect_user_message_copies_invalid",
      ),
      errorText,
      pending: ui.pending,
    },
    efficiency,
  };
}

export function evaluateTeamEffectQuality(
  caseInput: TeamEffectCase,
  traceInput: TeamEffectGuiTrace,
): TeamEffectQualityResult {
  const testCase = parseTeamEffectCase(caseInput);
  const trace = parseTeamEffectGuiTrace(traceInput);
  requireMatchingCase(testCase, trace);
  requireMatchingMembers(testCase, trace);
  const rawLines = trace.answer.text
    .split(/\n/u)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const matchingLines = rawLines.map((line) => line.normalize("NFC"));
  const failures: TeamEffectGateFailure[] = [];
  const uniqueLabelIndexes = new Map<string, number>();

  for (const expectation of testCase.qualityGate.labels) {
    const matches = matchingLines.flatMap((line, index) =>
      line.startsWith(expectation.label) ? [{ index, line }] : [],
    );
    if (matches.length === 0) {
      failures.push({
        code: "label_missing",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `Expected one line starting with ${JSON.stringify(expectation.label)}; found none.`,
      });
      continue;
    }
    if (matches.length > 1) {
      failures.push({
        code: "label_duplicate",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `Expected one line starting with ${JSON.stringify(expectation.label)}; found ${matches.length}.`,
      });
      continue;
    }
    uniqueLabelIndexes.set(expectation.id, matches[0]!.index);
    const firstLineContent = parseAuthoredLabelLine(
      matches[0]!.line,
      expectation.label,
    );
    if (firstLineContent === null) {
      failures.push({
        code: "label_syntax_invalid",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `The ${JSON.stringify(expectation.label)} line must contain exactly one ASCII space between the label and non-whitespace content, with no trailing whitespace.`,
      });
      continue;
    }
    const content = labelSection(
      matchingLines,
      matches[0]!.index,
      firstLineContent,
      testCase.qualityGate.labels,
    );
    if (!content) {
      failures.push({
        code: "label_content_empty",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `The ${JSON.stringify(expectation.label)} section is empty; provide an explicit finding.`,
      });
      continue;
    }
    const contentCharacters = Array.from(content).length;
    if (contentCharacters < expectation.minContentCharacters) {
      failures.push({
        code: "label_content_too_short",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `The ${JSON.stringify(expectation.label)} section contains ${contentCharacters} characters; minimum is ${expectation.minContentCharacters}.`,
      });
    }
    if (
      expectation.exactContent !== null &&
      content !== expectation.exactContent
    ) {
      failures.push({
        code: "label_exact_content_mismatch",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `The ${JSON.stringify(expectation.label)} section must equal ${JSON.stringify(expectation.exactContent)} exactly.`,
      });
    }
    for (const fragment of expectation.expectedFragments) {
      if (!content.includes(fragment)) {
        failures.push({
          code: "expected_fragment_missing",
          labelId: expectation.id,
          kind: expectation.kind,
          detail: `The ${JSON.stringify(expectation.label)} section must contain ${JSON.stringify(fragment)}.`,
        });
      }
    }
  }

  if (uniqueLabelIndexes.size === testCase.qualityGate.labels.length) {
    const actualOrder = [...uniqueLabelIndexes.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([id]) => id);
    const mismatchIndex = testCase.qualityGate.authoredOrder.findIndex(
      (id, index) => actualOrder[index] !== id,
    );
    if (mismatchIndex !== -1) {
      const expectedId = testCase.qualityGate.authoredOrder[mismatchIndex]!;
      const expectation = testCase.qualityGate.labels.find(
        ({ id }) => id === expectedId,
      )!;
      failures.push({
        code: "label_order_invalid",
        labelId: expectation.id,
        kind: expectation.kind,
        detail: `Expected authored label order ${JSON.stringify(testCase.qualityGate.authoredOrder)}; found ${JSON.stringify(actualOrder)}.`,
      });
    }
  }

  const answerCharacters = Array.from(trace.answer.text).length;
  if (answerCharacters > testCase.qualityGate.maxAnswerCharacters) {
    failures.push({
      code: "answer_too_long",
      labelId: null,
      kind: "answer",
      detail: `Answer contains ${answerCharacters} characters; maximum is ${testCase.qualityGate.maxAnswerCharacters}.`,
    });
  }

  if (!testCase.qualityGate.allowUnlabelledText) {
    const unlabelledLineIndex = matchingLines.findIndex(
      (line) =>
        line.trim().length > 0 &&
        !testCase.qualityGate.labels.some(({ label }) =>
          line.startsWith(label),
        ),
    );
    if (unlabelledLineIndex !== -1) {
      failures.push({
        code: "unlabelled_text",
        labelId: null,
        kind: "answer",
        detail: `Line ${unlabelledLineIndex + 1} does not start with an authored label: ${JSON.stringify(truncateDetail(rawLines[unlabelledLineIndex]!))}.`,
      });
    }
  }

  if (trace.ui.userMessageCopies !== 1) {
    failures.push({
      code: "user_message_copy_count_invalid",
      labelId: null,
      kind: "ui",
      detail: `Expected exactly one visible user message; found ${trace.ui.userMessageCopies}.`,
    });
  }
  if (trace.ui.errorText !== null) {
    failures.push({
      code: "ui_error_visible",
      labelId: null,
      kind: "ui",
      detail: `The GUI exposed an error: ${JSON.stringify(trace.ui.errorText)}.`,
    });
  }
  if (trace.ui.pending) {
    failures.push({
      code: "ui_pending",
      labelId: null,
      kind: "ui",
      detail:
        "The GUI was still pending when the trace was captured; wait for a terminal projection.",
    });
  }

  return {
    schemaVersion: TEAM_EFFECT_QUALITY_RESULT_SCHEMA_VERSION,
    caseId: testCase.caseId,
    caseRevision: testCase.caseRevision,
    traceId: trace.traceId,
    variantId: trace.variant.variantId,
    passed: failures.length === 0,
    failures,
  };
}

/**
 * Compares speed and model work only after both traces pass the same quality
 * contract and retain the same per-member model cohort. Missing metrics stay
 * explicit and never become zeroes.
 */
export function compareTeamEffectVariants(
  caseInput: TeamEffectCase,
  baselineInput: TeamEffectGuiTrace,
  candidateInput: TeamEffectGuiTrace,
): TeamEffectComparison {
  const testCase = parseTeamEffectCase(caseInput);
  const baseline = parseTeamEffectGuiTrace(baselineInput);
  const candidate = parseTeamEffectGuiTrace(candidateInput);
  requireMatchingCase(testCase, baseline);
  requireMatchingCase(testCase, candidate);
  requireMatchingMembers(testCase, baseline);
  requireMatchingMembers(testCase, candidate);
  if (baseline.traceId === candidate.traceId) {
    throw new TypeError("team_effect_comparison_trace_id_duplicate");
  }
  const baselineQuality = evaluateTeamEffectQuality(testCase, baseline);
  const candidateQuality = evaluateTeamEffectQuality(testCase, candidate);
  const common = {
    schemaVersion: TEAM_EFFECT_COMPARISON_SCHEMA_VERSION,
    caseId: testCase.caseId,
    caseRevision: testCase.caseRevision,
    baselineQuality,
    candidateQuality,
  } as const;

  if (!baselineQuality.passed || !candidateQuality.passed) {
    return {
      ...common,
      status: "notCompared",
      reason: "correctness_gate_failed",
      efficiency: null,
      efficiencyFailures: [],
    };
  }

  if (!hasMatchingMeasurementCohort(baseline, candidate)) {
    return {
      ...common,
      status: "notCompared",
      reason: "measurement_cohort_mismatch",
      efficiency: null,
      efficiencyFailures: [],
    };
  }

  if (!hasMatchingModelCohort(baseline, candidate)) {
    return {
      ...common,
      status: "notCompared",
      reason: "model_cohort_mismatch",
      efficiency: null,
      efficiencyFailures: [],
    };
  }

  const efficiency: TeamEffectEfficiencyComparison = {
    modelRunCount: compareMetric(
      baseline.efficiency.modelRunCount,
      candidate.efficiency.modelRunCount,
    ),
    logicalPhaseCount: compareMetric(
      baseline.efficiency.logicalPhaseCount,
      candidate.efficiency.logicalPhaseCount,
    ),
    timeToFirstVisibleOutputMs: compareMetric(
      baseline.efficiency.timeToFirstVisibleOutputMs,
      candidate.efficiency.timeToFirstVisibleOutputMs,
    ),
    settledDurationMs: compareMetric(
      baseline.efficiency.settledDurationMs,
      candidate.efficiency.settledDurationMs,
    ),
  };
  const efficiencyFailures = evaluateEfficiencyGate(
    testCase.efficiencyGate,
    baseline.efficiency,
    candidate.efficiency,
    efficiency,
  );
  if (Object.values(efficiency).every((metric) => metric === null)) {
    return {
      ...common,
      status: "notCompared",
      reason: efficiencyFailures.some(
        ({ code }) => code === "measurement_missing",
      )
        ? "gated_efficiency_metric_unavailable"
        : "efficiency_metrics_unavailable",
      efficiency: null,
      efficiencyFailures,
    };
  }
  return {
    ...common,
    status: "compared",
    reason: null,
    efficiency,
    efficiencyFailures,
  };
}

function parseLabelExpectation(
  input: unknown,
  index: number,
): TeamEffectLabelExpectation {
  const value = requireRecord(input, `team_effect_label_${index}_invalid`);
  requireExactKeys(value, [
    "exactContent",
    "expectedFragments",
    "id",
    "kind",
    "label",
    "minContentCharacters",
  ]);
  if (!isLabelKind(value.kind)) {
    throw new TypeError(`team_effect_label_${index}_kind_invalid`);
  }
  const label = requireNormalizedString(
    value.label,
    80,
    `team_effect_label_${index}_text_invalid`,
  );
  if (/[\r\n]/u.test(label) || label !== label.trim()) {
    throw new TypeError(`team_effect_label_${index}_text_invalid`);
  }
  if (
    !Array.isArray(value.expectedFragments) ||
    value.expectedFragments.length > MAX_EXPECTED_FRAGMENTS
  ) {
    throw new TypeError(`team_effect_label_${index}_fragments_invalid`);
  }
  const expectedFragments = value.expectedFragments.map((fragment) => {
    const parsed = requireNormalizedString(
      fragment,
      256,
      `team_effect_label_${index}_fragment_invalid`,
    );
    if (/[\r\n]/u.test(parsed)) {
      throw new TypeError(`team_effect_label_${index}_fragment_invalid`);
    }
    return parsed;
  });
  requireUnique(
    expectedFragments,
    `team_effect_label_${index}_fragment_duplicate`,
  );
  const minContentCharacters = requireInteger(
    value.minContentCharacters,
    1,
    MAX_ANSWER_CHARACTERS,
    `team_effect_label_${index}_min_content_characters_invalid`,
  );
  const exactContent = requireNullableNormalizedString(
    value.exactContent,
    4_096,
    `team_effect_label_${index}_exact_content_invalid`,
  );
  if (exactContent !== null && exactContent !== exactContent.trim()) {
    throw new TypeError(
      `team_effect_label_${index}_exact_content_whitespace_invalid`,
    );
  }
  if (
    exactContent !== null &&
    Array.from(exactContent).length < minContentCharacters
  ) {
    throw new TypeError(
      `team_effect_label_${index}_exact_content_below_minimum`,
    );
  }
  return {
    id: requireId(value.id, `team_effect_label_${index}_id_invalid`),
    kind: value.kind,
    label,
    expectedFragments,
    exactContent,
    minContentCharacters,
  };
}

function parseVariant(input: unknown): TeamEffectVariant {
  const value = requireRecord(input, "team_effect_variant_invalid");
  requireExactKeys(value, [
    "agents",
    "buildRevision",
    "harnessVersion",
    "promptVariantId",
    "variantId",
  ]);
  if (
    !Array.isArray(value.agents) ||
    value.agents.length < MIN_VARIANT_AGENTS ||
    value.agents.length > MAX_VARIANT_AGENTS
  ) {
    throw new TypeError("team_effect_variant_agents_invalid");
  }
  const agents = value.agents.map(parseVariantAgent);
  requireUnique(
    agents.map(({ memberId }) => memberId),
    "team_effect_variant_member_id_duplicate",
  );
  return {
    variantId: requireId(value.variantId, "team_effect_variant_id_invalid"),
    promptVariantId: requireId(
      value.promptVariantId,
      "team_effect_prompt_variant_id_invalid",
    ),
    harnessVersion: requireId(
      value.harnessVersion,
      "team_effect_harness_version_invalid",
    ),
    buildRevision: requireString(
      value.buildRevision,
      128,
      "team_effect_build_revision_invalid",
    ),
    agents,
  };
}

function parseVariantAgent(
  input: unknown,
  index: number,
): TeamEffectVariantAgent {
  const value = requireRecord(
    input,
    `team_effect_variant_agent_${index}_invalid`,
  );
  requireExactKeys(value, [
    "agentVersionDigest",
    "agentVersionId",
    "capabilityProfileId",
    "memberId",
    "modelId",
    "providerId",
    "reasoningEffort",
  ]);
  const agentVersionDigest = requireString(
    value.agentVersionDigest,
    128,
    `team_effect_variant_agent_${index}_version_digest_invalid`,
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(agentVersionDigest)) {
    throw new TypeError(
      `team_effect_variant_agent_${index}_version_digest_invalid`,
    );
  }
  return {
    memberId: requireId(
      value.memberId,
      `team_effect_variant_agent_${index}_member_id_invalid`,
    ),
    agentVersionId: requireId(
      value.agentVersionId,
      `team_effect_variant_agent_${index}_version_id_invalid`,
    ),
    agentVersionDigest,
    providerId: requireId(
      value.providerId,
      `team_effect_variant_agent_${index}_provider_id_invalid`,
    ),
    modelId: requireString(
      value.modelId,
      256,
      `team_effect_variant_agent_${index}_model_id_invalid`,
    ),
    reasoningEffort: requireNullableString(
      value.reasoningEffort,
      64,
      `team_effect_variant_agent_${index}_reasoning_effort_invalid`,
    ),
    capabilityProfileId: requireNullableString(
      value.capabilityProfileId,
      128,
      `team_effect_variant_agent_${index}_capability_profile_id_invalid`,
    ),
  };
}

function parseEfficiency(input: unknown): TeamEffectEfficiency {
  const value = requireRecord(input, "team_effect_efficiency_invalid");
  requireExactKeys(value, [
    "logicalPhaseCount",
    "modelRunCount",
    "settledDurationMs",
    "timeToFirstVisibleOutputMs",
  ]);
  return {
    modelRunCount: requireNullableInteger(
      value.modelRunCount,
      1,
      10_000,
      "team_effect_model_run_count_invalid",
    ),
    logicalPhaseCount: requireNullableInteger(
      value.logicalPhaseCount,
      1,
      10_000,
      "team_effect_logical_phase_count_invalid",
    ),
    timeToFirstVisibleOutputMs: requireNullableInteger(
      value.timeToFirstVisibleOutputMs,
      0,
      24 * 60 * 60 * 1_000,
      "team_effect_first_output_duration_invalid",
    ),
    settledDurationMs: requireNullableInteger(
      value.settledDurationMs,
      1,
      24 * 60 * 60 * 1_000,
      "team_effect_settled_duration_invalid",
    ),
  };
}

function parseEfficiencyGate(input: unknown): TeamEffectEfficiencyGate {
  const value = requireRecord(input, "team_effect_efficiency_gate_invalid");
  requireExactKeys(value, EFFICIENCY_METRICS);
  return {
    modelRunCount: parseEfficiencyMetricGate(
      value.modelRunCount,
      "model_run_count",
    ),
    logicalPhaseCount: parseEfficiencyMetricGate(
      value.logicalPhaseCount,
      "logical_phase_count",
    ),
    timeToFirstVisibleOutputMs: parseEfficiencyMetricGate(
      value.timeToFirstVisibleOutputMs,
      "first_output_duration",
    ),
    settledDurationMs: parseEfficiencyMetricGate(
      value.settledDurationMs,
      "settled_duration",
    ),
  };
}

function parseEfficiencyMetricGate(
  input: unknown,
  metricCode: string,
): TeamEffectEfficiencyMetricGate {
  const value = requireRecord(input, `team_effect_${metricCode}_gate_invalid`);
  requireExactKeys(value, ["maxRegressionPercent", "minImprovementPercent"]);
  return {
    maxRegressionPercent: requireNullableNumber(
      value.maxRegressionPercent,
      0,
      100_000,
      `team_effect_${metricCode}_max_regression_invalid`,
    ),
    minImprovementPercent: requireNullableNumber(
      value.minImprovementPercent,
      0,
      100,
      `team_effect_${metricCode}_min_improvement_invalid`,
    ),
  };
}

function parseAuthoredLabelLine(line: string, label: string): string | null {
  const remainder = line.slice(label.length);
  if (!remainder.startsWith(" ") || remainder.startsWith("  ")) return null;
  const content = remainder.slice(1);
  if (content.length === 0 || content !== content.trim()) return null;
  return content;
}

function labelSection(
  lines: readonly string[],
  startIndex: number,
  firstLineContent: string,
  expectations: readonly TeamEffectLabelExpectation[],
): string {
  const endIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      expectations.some((expectation) => line.startsWith(expectation.label)),
  );
  return [
    firstLineContent,
    ...lines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex),
  ].join("\n");
}

function compareMetric(
  baseline: number | null,
  candidate: number | null,
): TeamEffectMetricComparison | null {
  if (baseline === null || candidate === null) return null;
  return {
    baseline,
    candidate,
    candidateDelta: candidate - baseline,
    improvementPercent:
      baseline === 0
        ? null
        : Math.round(((baseline - candidate) / baseline) * 10_000) / 100,
  };
}

function evaluateEfficiencyGate(
  gate: TeamEffectEfficiencyGate,
  baseline: TeamEffectEfficiency,
  candidate: TeamEffectEfficiency,
  comparison: TeamEffectEfficiencyComparison,
): readonly TeamEffectEfficiencyFailure[] {
  const failures: TeamEffectEfficiencyFailure[] = [];
  for (const metric of EFFICIENCY_METRICS) {
    const maxRegressionPercent = gate[metric].maxRegressionPercent;
    const minImprovementPercent = gate[metric].minImprovementPercent;
    if (maxRegressionPercent === null && minImprovementPercent === null) {
      continue;
    }
    const baselineValue = baseline[metric];
    const candidateValue = candidate[metric];
    if (baselineValue === null || candidateValue === null) {
      const missing = [
        ...(baselineValue === null ? ["baseline"] : []),
        ...(candidateValue === null ? ["candidate"] : []),
      ].join(" and ");
      failures.push({
        code: "measurement_missing",
        metric,
        baseline: baselineValue,
        candidate: candidateValue,
        maxRegressionPercent,
        minImprovementPercent,
        improvementPercent: null,
        regressionPercent: null,
        detail: `${metric} has an enabled efficiency gate but the ${missing} measurement is missing; the gate fails closed.`,
      });
      continue;
    }
    const measured = comparison[metric]!;

    const rawRegressionPercent =
      measured.baseline === 0
        ? measured.candidate === 0
          ? 0
          : null
        : ((measured.candidate - measured.baseline) / measured.baseline) * 100;
    if (
      maxRegressionPercent !== null &&
      (rawRegressionPercent === null ||
        rawRegressionPercent > maxRegressionPercent)
    ) {
      failures.push({
        code: "regression_exceeded",
        metric,
        baseline: measured.baseline,
        candidate: measured.candidate,
        maxRegressionPercent,
        regressionPercent:
          rawRegressionPercent === null
            ? null
            : roundPercent(rawRegressionPercent),
        detail:
          rawRegressionPercent === null
            ? `${metric} increased from zero to ${measured.candidate}; percent regression is undefined and the ${maxRegressionPercent}% gate fails closed.`
            : `${metric} regressed by ${roundPercent(rawRegressionPercent)}%; maximum allowed regression is ${maxRegressionPercent}%.`,
      });
      continue;
    }

    const rawImprovementPercent =
      measured.baseline === 0
        ? null
        : ((measured.baseline - measured.candidate) / measured.baseline) * 100;
    if (
      minImprovementPercent !== null &&
      (rawImprovementPercent === null ||
        rawImprovementPercent < minImprovementPercent)
    ) {
      failures.push({
        code: "minimum_improvement_not_met",
        metric,
        baseline: measured.baseline,
        candidate: measured.candidate,
        minImprovementPercent,
        improvementPercent:
          rawImprovementPercent === null
            ? null
            : roundPercent(rawImprovementPercent),
        detail:
          rawImprovementPercent === null
            ? `${metric} has a zero baseline, so percent improvement is undefined and the ${minImprovementPercent}% minimum-improvement gate fails closed.`
            : `${metric} improved by ${roundPercent(rawImprovementPercent)}%; minimum required improvement is ${minImprovementPercent}%.`,
      });
    }
  }
  return failures;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireMatchingCase(
  testCase: TeamEffectCase,
  trace: TeamEffectGuiTrace,
): void {
  if (trace.caseId !== testCase.caseId) {
    throw new TypeError("team_effect_trace_case_mismatch");
  }
  if (trace.caseRevision !== testCase.caseRevision) {
    throw new TypeError("team_effect_trace_case_revision_mismatch");
  }
  if (trace.submittedPrompt !== testCase.prompt) {
    throw new TypeError("team_effect_trace_submitted_prompt_mismatch");
  }
}

function requireMatchingMembers(
  testCase: TeamEffectCase,
  trace: TeamEffectGuiTrace,
): void {
  const actualMemberIds = new Set(
    trace.variant.agents.map(({ memberId }) => memberId),
  );
  if (
    actualMemberIds.size !== testCase.expectedMemberIds.length ||
    testCase.expectedMemberIds.some(
      (memberId) => !actualMemberIds.has(memberId),
    )
  ) {
    throw new TypeError("team_effect_trace_members_mismatch");
  }
}

function hasMatchingMeasurementCohort(
  baseline: TeamEffectGuiTrace,
  candidate: TeamEffectGuiTrace,
): boolean {
  return (
    baseline.variant.harnessVersion === candidate.variant.harnessVersion &&
    baseline.capture.collector === candidate.capture.collector
  );
}

function hasMatchingModelCohort(
  baseline: TeamEffectGuiTrace,
  candidate: TeamEffectGuiTrace,
): boolean {
  const candidateAgentsByMemberId = new Map(
    candidate.variant.agents.map((agent) => [agent.memberId, agent]),
  );
  return baseline.variant.agents.every((baselineAgent) => {
    const candidateAgent = candidateAgentsByMemberId.get(
      baselineAgent.memberId,
    );
    return (
      candidateAgent !== undefined &&
      candidateAgent.providerId === baselineAgent.providerId &&
      candidateAgent.modelId === baselineAgent.modelId &&
      candidateAgent.reasoningEffort === baselineAgent.reasoningEffort
    );
  });
}

function isLabelKind(value: unknown): value is TeamEffectLabelKind {
  return ["decision", "evidence", "conflict", "unknown"].includes(
    value as TeamEffectLabelKind,
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
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError("team_effect_shape_invalid");
  }
}

function requireId(input: unknown, code: string): string {
  const value = requireString(input, 128, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new TypeError(code);
  }
  return value;
}

function requireString(
  input: unknown,
  maxCharacters: number,
  code: string,
  allowEmpty = false,
): string {
  if (
    typeof input !== "string" ||
    (!allowEmpty && input.trim().length === 0) ||
    Array.from(input).length > maxCharacters
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireNullableString(
  input: unknown,
  maxCharacters: number,
  code: string,
): string | null {
  return input === null ? null : requireString(input, maxCharacters, code);
}

function requireNormalizedString(
  input: unknown,
  maxCharacters: number,
  code: string,
): string {
  return requireString(input, maxCharacters, code).normalize("NFC");
}

function requireNullableNormalizedString(
  input: unknown,
  maxCharacters: number,
  code: string,
): string | null {
  return input === null
    ? null
    : requireNormalizedString(input, maxCharacters, code);
}

function requireInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < minimum ||
    (input as number) > maximum
  ) {
    throw new TypeError(code);
  }
  return input as number;
}

function requireNullableInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number | null {
  return input === null ? null : requireInteger(input, minimum, maximum, code);
}

function requireNullableNumber(
  input: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number | null {
  if (input === null) return null;
  if (
    typeof input !== "number" ||
    !Number.isFinite(input) ||
    input < minimum ||
    input > maximum
  ) {
    throw new TypeError(code);
  }
  return input;
}

function requireUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(code);
  }
}

function truncateDetail(value: string): string {
  const characters = Array.from(value);
  return characters.length <= 160
    ? value
    : `${characters.slice(0, 157).join("")}...`;
}
