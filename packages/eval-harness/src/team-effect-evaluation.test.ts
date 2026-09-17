import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  compareTeamEffectVariants,
  evaluateTeamEffectQuality,
  parseTeamEffectCase,
  parseTeamEffectGuiTrace,
  type TeamEffectGuiTrace,
  type TeamEffectVariantAgent,
} from "./team-effect-evaluation.ts";

const caseFixture = readFixture("example-release-decision.case.v1.json");
const baselineFixture = readFixture(
  "example-release-decision.baseline.gui-trace.v1.json",
);
const candidateFixture = readFixture(
  "example-release-decision.candidate.gui-trace.v1.json",
);

test("loads versioned GUI fixtures and passes every deterministic quality gate", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  assert.equal(baseline.capture.source, "gui");
  assert.equal(candidate.capture.source, "gui");
  assert.equal(testCase.caseRevision, "revision-1");
  assert.equal(candidate.submittedPrompt, testCase.prompt);
  assert.match(testCase.prompt, /rollback/u);
  assert.deepEqual(testCase.qualityGate.authoredOrder.slice(0, 2), [
    "decision",
    "evidence-a",
  ]);
  assert.equal(candidate.variant.agents.length, 3);
  assert.deepEqual(candidate.variant.agents[1], {
    memberId: "planner",
    agentVersionId: "candidate-planner-v1",
    agentVersionDigest:
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    providerId: "fixture-provider-a",
    modelId: "fixture-planner-model",
    reasoningEffort: "high",
    capabilityProfileId: "portable-text-v1",
  });
  assert.deepEqual(evaluateTeamEffectQuality(testCase, baseline), {
    schemaVersion: "crewon.team-effect-quality-result.v1",
    caseId: "example-release-decision",
    caseRevision: "revision-1",
    traceId: "example-baseline-001",
    variantId: "manager-generated",
    passed: true,
    failures: [],
  });
  assert.equal(evaluateTeamEffectQuality(testCase, candidate).passed, true);
});

test("binds a GUI trace to the exact case id, revision, and submitted prompt", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  assert.throws(
    () =>
      evaluateTeamEffectQuality(testCase, {
        ...candidate,
        caseId: "another-case",
      }),
    /team_effect_trace_case_mismatch/u,
  );
  assert.throws(
    () =>
      evaluateTeamEffectQuality(testCase, {
        ...candidate,
        caseRevision: "revision-0",
      }),
    /team_effect_trace_case_revision_mismatch/u,
  );
  assert.throws(
    () =>
      evaluateTeamEffectQuality(testCase, {
        ...candidate,
        submittedPrompt: `${candidate.submittedPrompt} changed`,
      }),
    /team_effect_trace_submitted_prompt_mismatch/u,
  );

  const canonicalPromptCase = {
    ...testCase,
    prompt: `${testCase.prompt} café`,
  };
  const canonicallyEquivalentTrace = {
    ...candidate,
    submittedPrompt: `${testCase.prompt} cafe\u0301`,
  };
  assert.equal(
    evaluateTeamEffectQuality(canonicalPromptCase, canonicallyEquivalentTrace)
      .passed,
    true,
  );
});

test("compares efficiency only after both GUI traces pass correctness", () => {
  const comparison = compareTeamEffectVariants(
    parseTeamEffectCase(caseFixture),
    parseTeamEffectGuiTrace(baselineFixture),
    parseTeamEffectGuiTrace(candidateFixture),
  );

  assert.equal(comparison.status, "compared");
  assert.equal(comparison.reason, null);
  assert.deepEqual(comparison.efficiencyFailures, []);
  assert.deepEqual(comparison.efficiency, {
    modelRunCount: {
      baseline: 4,
      candidate: 3,
      candidateDelta: -1,
      improvementPercent: 25,
    },
    logicalPhaseCount: {
      baseline: 3,
      candidate: 2,
      candidateDelta: -1,
      improvementPercent: 33.33,
    },
    timeToFirstVisibleOutputMs: null,
    settledDurationMs: {
      baseline: 50_524,
      candidate: 45_683,
      candidateDelta: -4_841,
      improvementPercent: 9.58,
    },
  });
});

test("fails closed before efficiency attribution when a member changes model cohort", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const mismatchOverrides: ReadonlyArray<
    readonly [
      string,
      Readonly<
        Partial<
          Pick<
            TeamEffectVariantAgent,
            "providerId" | "modelId" | "reasoningEffort"
          >
        >
      >,
    ]
  > = [
    ["provider", { providerId: "another-provider" }],
    ["model", { modelId: "another-model" }],
    ["reasoning-effort", { reasoningEffort: "low" }],
  ];

  for (const [name, override] of mismatchOverrides) {
    const mismatchedCandidate: TeamEffectGuiTrace = {
      ...candidate,
      traceId: `candidate-${name}-mismatch`,
      variant: {
        ...candidate.variant,
        agents: candidate.variant.agents.map((agent) =>
          agent.memberId === "planner" ? { ...agent, ...override } : agent,
        ),
      },
    };

    const comparison = compareTeamEffectVariants(
      testCase,
      baseline,
      mismatchedCandidate,
    );
    assert.equal(comparison.baselineQuality.passed, true, name);
    assert.equal(comparison.candidateQuality.passed, true, name);
    assert.equal(comparison.status, "notCompared", name);
    assert.equal(comparison.reason, "model_cohort_mismatch", name);
    assert.equal(comparison.efficiency, null, name);
    assert.deepEqual(comparison.efficiencyFailures, [], name);
  }
});

test("fails closed when the GUI measurement cohort changes", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  for (const [name, changed] of [
    [
      "harness-version",
      {
        ...candidate,
        traceId: "candidate-harness-mismatch",
        variant: {
          ...candidate.variant,
          harnessVersion: "incompatible-harness-v999",
        },
      },
    ],
    [
      "collector",
      {
        ...candidate,
        traceId: "candidate-collector-mismatch",
        capture: {
          ...candidate.capture,
          collector: "another-gui-collector",
        },
      },
    ],
  ] as const) {
    const comparison = compareTeamEffectVariants(testCase, baseline, changed);
    assert.equal(comparison.baselineQuality.passed, true, name);
    assert.equal(comparison.candidateQuality.passed, true, name);
    assert.equal(comparison.status, "notCompared", name);
    assert.equal(comparison.reason, "measurement_cohort_mismatch", name);
    assert.equal(comparison.efficiency, null, name);
    assert.deepEqual(comparison.efficiencyFailures, [], name);
  }
});

test("compares by member ID while allowing prompt, AgentVersion, and capability treatments", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const treatment: TeamEffectGuiTrace = {
    ...candidate,
    traceId: "candidate-treatment-with-reordered-members",
    variant: {
      ...candidate.variant,
      agents: [...candidate.variant.agents].reverse().map((agent) => ({
        ...agent,
        capabilityProfileId: "portable-text-v2",
      })),
    },
  };

  assert.notEqual(
    baseline.variant.promptVariantId,
    treatment.variant.promptVariantId,
  );
  assert.notEqual(
    baseline.variant.agents[0]!.agentVersionId,
    candidate.variant.agents[0]!.agentVersionId,
  );
  assert.equal(
    compareTeamEffectVariants(testCase, baseline, treatment).status,
    "compared",
  );
});

test("reports authored efficiency regressions after correctness passes", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const regressed: TeamEffectGuiTrace = {
    ...candidate,
    efficiency: {
      ...candidate.efficiency,
      modelRunCount: 5,
      logicalPhaseCount: 4,
    },
  };

  const comparison = compareTeamEffectVariants(testCase, baseline, regressed);
  assert.equal(comparison.status, "compared");
  assert.deepEqual(comparison.efficiencyFailures, [
    {
      code: "regression_exceeded",
      metric: "modelRunCount",
      baseline: 4,
      candidate: 5,
      maxRegressionPercent: 0,
      regressionPercent: 25,
      detail:
        "modelRunCount regressed by 25%; maximum allowed regression is 0%.",
    },
    {
      code: "regression_exceeded",
      metric: "logicalPhaseCount",
      baseline: 3,
      candidate: 4,
      maxRegressionPercent: 0,
      regressionPercent: 33.33,
      detail:
        "logicalPhaseCount regressed by 33.33%; maximum allowed regression is 0%.",
    },
  ]);
});

test("enforces minimum efficiency improvements and rejects reused trace identity", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const unchangedWork: TeamEffectGuiTrace = {
    ...candidate,
    traceId: "example-candidate-no-work-improvement",
    efficiency: {
      ...candidate.efficiency,
      modelRunCount: baseline.efficiency.modelRunCount,
      logicalPhaseCount: baseline.efficiency.logicalPhaseCount,
    },
  };

  const comparison = compareTeamEffectVariants(
    testCase,
    baseline,
    unchangedWork,
  );
  assert.equal(comparison.status, "compared");
  assert.deepEqual(comparison.efficiencyFailures, [
    {
      code: "minimum_improvement_not_met",
      metric: "modelRunCount",
      baseline: 4,
      candidate: 4,
      minImprovementPercent: 1,
      improvementPercent: 0,
      detail:
        "modelRunCount improved by 0%; minimum required improvement is 1%.",
    },
    {
      code: "minimum_improvement_not_met",
      metric: "logicalPhaseCount",
      baseline: 3,
      candidate: 3,
      minImprovementPercent: 1,
      improvementPercent: 0,
      detail:
        "logicalPhaseCount improved by 0%; minimum required improvement is 1%.",
    },
  ]);

  assert.throws(
    () =>
      compareTeamEffectVariants(testCase, baseline, {
        ...candidate,
        traceId: baseline.traceId,
      }),
    /team_effect_comparison_trace_id_duplicate/u,
  );
});

test("fails closed for missing gated metrics while keeping values unknown", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const partiallyMeasured: TeamEffectGuiTrace = {
    ...candidate,
    efficiency: {
      ...candidate.efficiency,
      modelRunCount: null,
      settledDurationMs: 60_000,
    },
  };

  const comparison = compareTeamEffectVariants(
    testCase,
    baseline,
    partiallyMeasured,
  );
  assert.equal(comparison.status, "compared");
  assert.equal(comparison.efficiency?.modelRunCount, null);
  assert.equal(comparison.efficiency?.settledDurationMs?.candidate, 60_000);
  assert.deepEqual(comparison.efficiencyFailures, [
    {
      code: "measurement_missing",
      metric: "modelRunCount",
      baseline: 4,
      candidate: null,
      maxRegressionPercent: 0,
      minImprovementPercent: 1,
      improvementPercent: null,
      regressionPercent: null,
      detail:
        "modelRunCount has an enabled efficiency gate but the candidate measurement is missing; the gate fails closed.",
    },
  ]);
});

test("reports missing, duplicate, empty, fragment, conflict, and unknown failures", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const failingTrace: TeamEffectGuiTrace = {
    ...candidate,
    answer: {
      text: candidate.answer.text
        .replace(
          "证据B: monitoring 告警链路已经验证。",
          "证据B: 告警链路已经验证。",
        )
        .replace("\n证据D: rehearsal 尚未覆盖恢复阶段。", "")
        .replace(
          "冲突: planner 支持发布，verifier 要求先补齐回滚证据。",
          "冲突:",
        )
        .replace("\n未知: 生产故障的实际恢复时长。", "")
        .concat("\n证据A: duplicate rollback evidence"),
    },
  };

  const result = evaluateTeamEffectQuality(testCase, failingTrace);
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.failures.map(({ code, kind, labelId }) => ({
      code,
      kind,
      labelId,
    })),
    [
      {
        code: "label_duplicate",
        kind: "evidence",
        labelId: "evidence-a",
      },
      {
        code: "label_content_too_short",
        kind: "evidence",
        labelId: "evidence-b",
      },
      {
        code: "expected_fragment_missing",
        kind: "evidence",
        labelId: "evidence-b",
      },
      {
        code: "label_missing",
        kind: "evidence",
        labelId: "evidence-d",
      },
      {
        code: "label_syntax_invalid",
        kind: "conflict",
        labelId: "conflict",
      },
      {
        code: "label_missing",
        kind: "unknown",
        labelId: "unknown",
      },
    ],
  );
});

test("enforces exact decisions, authored order, answer length, and labelled-only text", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const exactMismatch = evaluateTeamEffectQuality(testCase, {
    ...candidate,
    answer: {
      text: candidate.answer.text.replace("结论: NO-GO", "结论: GO"),
    },
  });
  assert.deepEqual(
    exactMismatch.failures.map(({ code }) => code),
    ["label_content_too_short", "label_exact_content_mismatch"],
  );

  const keywordOnlyEvidence = evaluateTeamEffectQuality(testCase, {
    ...candidate,
    answer: {
      text: candidate.answer.text.replace(
        "证据A: rollback 证据仍缺失。",
        "证据A: rollback",
      ),
    },
  });
  assert.deepEqual(
    keywordOnlyEvidence.failures.map(({ code }) => code),
    ["label_content_too_short"],
  );

  const reorderedLines = candidate.answer.text.split("\n");
  [reorderedLines[0], reorderedLines[1]] = [
    reorderedLines[1]!,
    reorderedLines[0]!,
  ];
  const reordered = evaluateTeamEffectQuality(testCase, {
    ...candidate,
    answer: { text: reorderedLines.join("\n") },
  });
  assert.deepEqual(
    reordered.failures.map(({ code }) => code),
    ["label_order_invalid"],
  );

  const tooLong = evaluateTeamEffectQuality(
    {
      ...testCase,
      qualityGate: { ...testCase.qualityGate, maxAnswerCharacters: 1 },
    },
    candidate,
  );
  assert.deepEqual(
    tooLong.failures.map(({ code }) => code),
    ["answer_too_long"],
  );

  const unlabelled = evaluateTeamEffectQuality(testCase, {
    ...candidate,
    answer: { text: `${candidate.answer.text}\n额外的无标签说明。` },
  });
  assert.deepEqual(
    unlabelled.failures.map(({ code }) => code),
    ["unlabelled_text"],
  );
});

test("uses strict labelled-line spacing and NFC matching without rewriting raw answer evidence", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  for (const malformedDecision of [
    "结论:NO-GO",
    "结论:  NO-GO",
    "结论: NO-GO ",
  ]) {
    const result = evaluateTeamEffectQuality(testCase, {
      ...candidate,
      answer: {
        text: candidate.answer.text.replace("结论: NO-GO", malformedDecision),
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.failures[0]?.code, "label_syntax_invalid");
  }

  const doubledDelimiter = evaluateTeamEffectQuality(testCase, {
    ...candidate,
    answer: {
      text: candidate.answer.text.replace(
        "证据A: rollback 证据仍缺失。",
        "证据A:: rollback 证据仍缺失。",
      ),
    },
  });
  assert.ok(
    doubledDelimiter.failures.some(
      ({ code, labelId }) =>
        code === "label_syntax_invalid" && labelId === "evidence-a",
    ),
  );

  const canonicalLabelCase = {
    ...testCase,
    qualityGate: {
      ...testCase.qualityGate,
      labels: testCase.qualityGate.labels.map((label) =>
        label.id === "evidence-a" ? { ...label, label: "Café:" } : label,
      ),
    },
  };
  const decomposedAnswer = candidate.answer.text.replace(
    "证据A: rollback 证据仍缺失。",
    "Cafe\u0301: rollback 证据仍缺失。",
  );
  const parsedTrace = parseTeamEffectGuiTrace({
    ...candidate,
    answer: { text: decomposedAnswer },
  });
  assert.equal(parsedTrace.answer.text, decomposedAnswer);
  assert.equal(
    evaluateTeamEffectQuality(canonicalLabelCase, parsedTrace).passed,
    true,
  );

  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        qualityGate: {
          ...testCase.qualityGate,
          labels: testCase.qualityGate.labels.map((label) =>
            label.id === "decision"
              ? { ...label, exactContent: "NO-GO " }
              : label,
          ),
        },
      }),
    /team_effect_label_0_exact_content_whitespace_invalid/u,
  );
});

test("blocks efficiency comparison for duplicate messages, UI errors, or pending state", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const failingCandidate: TeamEffectGuiTrace = {
    ...candidate,
    ui: {
      userMessageCopies: 2,
      errorText: "执行失败，请重试",
      pending: true,
    },
    efficiency: {
      modelRunCount: null,
      logicalPhaseCount: null,
      timeToFirstVisibleOutputMs: null,
      settledDurationMs: null,
    },
  };

  const comparison = compareTeamEffectVariants(
    testCase,
    baseline,
    failingCandidate,
  );
  assert.equal(comparison.status, "notCompared");
  assert.equal(comparison.reason, "correctness_gate_failed");
  assert.equal(comparison.efficiency, null);
  assert.deepEqual(
    comparison.candidateQuality.failures.map(({ code }) => code),
    ["user_message_copy_count_invalid", "ui_error_visible", "ui_pending"],
  );
});

test("keeps absent efficiency measurements explicit instead of inventing zeroes", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = withoutEfficiency(parseTeamEffectGuiTrace(baselineFixture));
  const candidate = withoutEfficiency(
    parseTeamEffectGuiTrace(candidateFixture),
  );

  const comparison = compareTeamEffectVariants(testCase, baseline, candidate);
  assert.equal(comparison.status, "notCompared");
  assert.equal(comparison.reason, "gated_efficiency_metric_unavailable");
  assert.equal(comparison.efficiency, null);
  assert.deepEqual(
    comparison.efficiencyFailures.map(({ code, metric }) => ({
      code,
      metric,
    })),
    [
      { code: "measurement_missing", metric: "modelRunCount" },
      { code: "measurement_missing", metric: "logicalPhaseCount" },
    ],
  );

  const fullyUngated = compareTeamEffectVariants(
    {
      ...testCase,
      efficiencyGate: {
        modelRunCount: {
          maxRegressionPercent: null,
          minImprovementPercent: null,
        },
        logicalPhaseCount: {
          maxRegressionPercent: null,
          minImprovementPercent: null,
        },
        timeToFirstVisibleOutputMs: {
          maxRegressionPercent: null,
          minImprovementPercent: null,
        },
        settledDurationMs: {
          maxRegressionPercent: null,
          minImprovementPercent: null,
        },
      },
    },
    baseline,
    candidate,
  );
  assert.equal(fullyUngated.status, "notCompared");
  assert.equal(fullyUngated.reason, "efficiency_metrics_unavailable");
  assert.deepEqual(fullyUngated.efficiencyFailures, []);
});

test("trace parsing fails closed for non-GUI sources and malformed provenance", () => {
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        capture: { ...candidate.capture, source: "api" },
      }),
    /team_effect_capture_source_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        capture: {
          ...candidate.capture,
          capturedAt: "2026-09-03 12:21:00",
        },
      }),
    /team_effect_capture_time_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        variant: {
          ...candidate.variant,
          agents: candidate.variant.agents.map((agent, index) =>
            index === 0
              ? { ...agent, agentVersionDigest: "candidate-latest" }
              : agent,
          ),
        },
      }),
    /team_effect_variant_agent_0_version_digest_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        variant: {
          ...candidate.variant,
          agents: candidate.variant.agents.map((agent, index) =>
            index === 1
              ? { ...agent, memberId: candidate.variant.agents[0]!.memberId }
              : agent,
          ),
        },
      }),
    /team_effect_variant_member_id_duplicate/u,
  );
  const sharedAgentVersion = parseTeamEffectGuiTrace({
    ...candidate,
    variant: {
      ...candidate.variant,
      agents: candidate.variant.agents.map((agent, index) =>
        index === 1
          ? {
              ...agent,
              agentVersionId: candidate.variant.agents[0]!.agentVersionId,
            }
          : agent,
      ),
    },
  });
  assert.equal(
    sharedAgentVersion.variant.agents[0]!.agentVersionId,
    sharedAgentVersion.variant.agents[1]!.agentVersionId,
  );

  const agentTemplate = candidate.variant.agents[0]!;
  const sixMembers = Array.from({ length: 6 }, (_, index) => ({
    ...agentTemplate,
    memberId: `member-${index}`,
    agentVersionId: "shared-agent-version",
  }));
  assert.equal(
    parseTeamEffectGuiTrace({
      ...candidate,
      variant: { ...candidate.variant, agents: sixMembers },
    }).variant.agents.length,
    6,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        variant: { ...candidate.variant, agents: [agentTemplate] },
      }),
    /team_effect_variant_agents_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        variant: {
          ...candidate.variant,
          agents: [
            ...sixMembers,
            {
              ...agentTemplate,
              memberId: "member-6",
              agentVersionId: "shared-agent-version",
            },
          ],
        },
      }),
    /team_effect_variant_agents_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectGuiTrace({
        ...candidate,
        variant: { ...candidate.variant, providerId: "fake-single-provider" },
      }),
    /team_effect_shape_invalid/u,
  );
  assert.throws(
    () => parseTeamEffectGuiTrace({ ...candidate, unexpected: true }),
    /team_effect_shape_invalid/u,
  );
});

test("case member contract rejects an omitted Team member", () => {
  const testCase = parseTeamEffectCase(caseFixture);
  const baseline = parseTeamEffectGuiTrace(baselineFixture);
  const candidate = parseTeamEffectGuiTrace(candidateFixture);
  const missingVerifier: TeamEffectGuiTrace = {
    ...candidate,
    variant: {
      ...candidate.variant,
      agents: candidate.variant.agents.filter(
        ({ memberId }) => memberId !== "verifier",
      ),
    },
  };

  assert.throws(
    () => evaluateTeamEffectQuality(testCase, missingVerifier),
    /team_effect_trace_members_mismatch/u,
  );
  assert.throws(
    () => compareTeamEffectVariants(testCase, baseline, missingVerifier),
    /team_effect_trace_members_mismatch/u,
  );
});

test("completed trace metrics reject impossible zero counts and duration", () => {
  const candidate = parseTeamEffectGuiTrace(candidateFixture);

  for (const [metric, code] of [
    ["modelRunCount", "team_effect_model_run_count_invalid"],
    ["logicalPhaseCount", "team_effect_logical_phase_count_invalid"],
    ["settledDurationMs", "team_effect_settled_duration_invalid"],
  ] as const) {
    assert.throws(
      () =>
        parseTeamEffectGuiTrace({
          ...candidate,
          efficiency: { ...candidate.efficiency, [metric]: 0 },
        }),
      new RegExp(code, "u"),
    );
  }

  assert.equal(
    parseTeamEffectGuiTrace({
      ...candidate,
      efficiency: {
        ...candidate.efficiency,
        timeToFirstVisibleOutputMs: 0,
      },
    }).efficiency.timeToFirstVisibleOutputMs,
    0,
  );
});

test("case parsing rejects unknown versions and ambiguous or incomplete gates", () => {
  const testCase = parseTeamEffectCase(caseFixture);

  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        schemaVersion: "crewon.team-effect-case.v2",
      }),
    /team_effect_case_schema_version_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        schemaVersion: testCase.schemaVersion,
        caseId: testCase.caseId,
        title: testCase.title,
        expectedMemberIds: testCase.expectedMemberIds,
        qualityGate: testCase.qualityGate,
        efficiencyGate: testCase.efficiencyGate,
      }),
    /team_effect_shape_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        qualityGate: {
          ...testCase.qualityGate,
          labels: testCase.qualityGate.labels.filter(
            ({ kind }) => kind !== "unknown",
          ),
        },
      }),
    /team_effect_unknown_gate_missing/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        qualityGate: {
          ...testCase.qualityGate,
          labels: testCase.qualityGate.labels.map((label) =>
            label.id === "unknown" ? { ...label, label: "证据" } : label,
          ),
        },
      }),
    /team_effect_label_prefix_ambiguous/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        qualityGate: {
          ...testCase.qualityGate,
          authoredOrder: testCase.qualityGate.authoredOrder.slice(1),
        },
      }),
    /team_effect_authored_order_invalid/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        qualityGate: {
          ...testCase.qualityGate,
          labels: testCase.qualityGate.labels.map((label) =>
            label.id === "decision" ? { ...label, exactContent: null } : label,
          ),
        },
      }),
    /team_effect_exact_decision_gate_missing/u,
  );
  assert.throws(
    () =>
      parseTeamEffectCase({
        ...testCase,
        efficiencyGate: {
          ...testCase.efficiencyGate,
          modelRunCount: {
            ...testCase.efficiencyGate.modelRunCount,
            maxRegressionPercent: -1,
          },
        },
      }),
    /team_effect_model_run_count_max_regression_invalid/u,
  );
});

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function withoutEfficiency(trace: TeamEffectGuiTrace): TeamEffectGuiTrace {
  return {
    ...trace,
    efficiency: {
      modelRunCount: null,
      logicalPhaseCount: null,
      timeToFirstVisibleOutputMs: null,
      settledDurationMs: null,
    },
  };
}
