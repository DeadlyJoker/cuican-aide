import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { certifyTeamEffectCapability } from "./capability-certification.ts";
import type {
  TeamEffectCase,
  TeamEffectGuiTrace,
} from "./team-effect-evaluation.ts";

const fixtureDirectory = new URL("../fixtures/", import.meta.url);
const caseFixture = readFixture<TeamEffectCase>(
  "example-release-decision.case.v1.json",
);
const baselineFixture = readFixture<TeamEffectGuiTrace>(
  "example-release-decision.baseline.gui-trace.v1.json",
);
const candidateFixture = readFixture<TeamEffectGuiTrace>(
  "example-release-decision.candidate.gui-trace.v1.json",
);

test("refuses to certify one successful case", () => {
  const result = certifyTeamEffectCapability({
    capabilityProfileId: "portable-text-v1",
    candidatePromptVariantId: "team-role-directed-v1",
    minimumCaseCount: 3,
    comparisons: [comparisonFixture(1)],
  });

  assert.equal(result.status, "notCertified");
  assert.equal(result.observedCaseCount, 1);
  assert.deepEqual(
    result.failures.map(({ code }) => code),
    ["insufficient_cases"],
  );
  assert.equal(result.cases[0]?.passed, true);
});

test("certifies distinct cases only for one stable model cohort and strict topology wins", () => {
  const result = certifyTeamEffectCapability({
    capabilityProfileId: "portable-text-v1",
    candidatePromptVariantId: "team-role-directed-v1",
    minimumCaseCount: 3,
    comparisons: [
      comparisonFixture(1),
      comparisonFixture(2),
      comparisonFixture(3),
    ],
  });

  assert.equal(result.status, "certified");
  assert.deepEqual(result.failures, []);
  assert.equal(
    result.cases.every(({ passed }) => passed),
    true,
  );
  assert.deepEqual(
    result.modelCohort?.map(({ memberId, providerId, modelId }) => ({
      memberId,
      providerId,
      modelId,
    })),
    [
      {
        memberId: "manager",
        providerId: "fixture-provider-a",
        modelId: "fixture-manager-model",
      },
      {
        memberId: "planner",
        providerId: "fixture-provider-a",
        modelId: "fixture-planner-model",
      },
      {
        memberId: "verifier",
        providerId: "fixture-provider-b",
        modelId: "fixture-verifier-model",
      },
    ],
  );
});

test("fails closed for reused evidence and candidate configuration drift", () => {
  const first = comparisonFixture(1);
  const duplicate = {
    ...comparisonFixture(1),
    candidate: {
      ...comparisonFixture(1).candidate,
      variant: {
        ...comparisonFixture(1).candidate.variant,
        promptVariantId: "another-prompt",
        agents: comparisonFixture(1).candidate.variant.agents.map((agent) =>
          agent.memberId === "planner"
            ? {
                ...agent,
                modelId: "another-model",
                capabilityProfileId: "another-profile",
              }
            : agent,
        ),
      },
    },
  };
  const missingTopologyGate = comparisonFixture(3, {
    efficiencyGate: {
      ...caseFixture.efficiencyGate,
      logicalPhaseCount: {
        maxRegressionPercent: 0,
        minImprovementPercent: null,
      },
    },
  });
  const result = certifyTeamEffectCapability({
    capabilityProfileId: "portable-text-v1",
    candidatePromptVariantId: "team-role-directed-v1",
    minimumCaseCount: 3,
    comparisons: [first, duplicate, missingTopologyGate],
  });

  assert.equal(result.status, "notCertified");
  assert.equal(result.modelCohort, null);
  assert.deepEqual(
    new Set(result.failures.map(({ code }) => code)),
    new Set([
      "duplicate_case",
      "trace_reused",
      "candidate_prompt_mismatch",
      "candidate_profile_mismatch",
      "suite_model_cohort_mismatch",
      "topology_gate_missing",
      "comparison_not_passed",
    ]),
  );
});

test("fails closed when a candidate does not pass the authored comparison", () => {
  const regressionFixture = comparisonFixture(3);
  const regressed = {
    ...regressionFixture,
    candidate: {
      ...regressionFixture.candidate,
      efficiency: {
        ...regressionFixture.candidate.efficiency,
        modelRunCount: 5,
      },
    },
  };
  const answerFixture = comparisonFixture(2);
  const invalidAnswer = {
    ...answerFixture,
    candidate: {
      ...answerFixture.candidate,
      answer: { text: "结论: GO" },
    },
  };
  const result = certifyTeamEffectCapability({
    capabilityProfileId: "portable-text-v1",
    candidatePromptVariantId: "team-role-directed-v1",
    minimumCaseCount: 3,
    comparisons: [comparisonFixture(1), invalidAnswer, regressed],
  });

  assert.equal(result.status, "notCertified");
  assert.deepEqual(
    new Set(result.failures.map(({ code }) => code)),
    new Set(["comparison_not_passed", "efficiency_gate_failed"]),
  );
});

function comparisonFixture(
  sequence: number,
  caseOverride: Partial<TeamEffectCase> = {},
) {
  const caseId = `release-decision-${sequence}`;
  const caseRevision = `revision-${sequence}`;
  return {
    testCase: structuredClone({
      ...caseFixture,
      ...caseOverride,
      caseId,
      caseRevision,
    }),
    baseline: structuredClone({
      ...baselineFixture,
      caseId,
      caseRevision,
      traceId: `baseline-${sequence}`,
    }),
    candidate: structuredClone({
      ...candidateFixture,
      caseId,
      caseRevision,
      traceId: `candidate-${sequence}`,
    }),
  };
}

function readFixture<T>(filename: string): T {
  return JSON.parse(
    readFileSync(new URL(filename, fixtureDirectory), "utf8"),
  ) as T;
}
