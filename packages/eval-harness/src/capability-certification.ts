import {
  compareTeamEffectVariants,
  parseTeamEffectCase,
  parseTeamEffectGuiTrace,
  type TeamEffectCase,
  type TeamEffectGuiTrace,
} from "./team-effect-evaluation.ts";

export const TEAM_EFFECT_CAPABILITY_CERTIFICATION_SCHEMA_VERSION =
  "crewon.team-effect-capability-certification.v1" as const;

const MAX_CERTIFICATION_CASES = 100;

export type TeamEffectCapabilityCertificationFailureCode =
  | "insufficient_cases"
  | "duplicate_case"
  | "trace_reused"
  | "candidate_profile_mismatch"
  | "candidate_prompt_mismatch"
  | "suite_model_cohort_mismatch"
  | "topology_gate_missing"
  | "comparison_not_passed"
  | "efficiency_gate_failed";

export type TeamEffectModelCohortMember = Readonly<{
  memberId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
}>;

export type TeamEffectCapabilityCertificationFailure = Readonly<{
  code: TeamEffectCapabilityCertificationFailureCode;
  caseId: string | null;
  caseRevision: string | null;
  detail: string;
}>;

export type TeamEffectCapabilityCertificationCase = Readonly<{
  caseId: string;
  caseRevision: string;
  baselineTraceId: string;
  candidateTraceId: string;
  passed: boolean;
  failures: readonly TeamEffectCapabilityCertificationFailure[];
}>;

export type TeamEffectCapabilityCertification = Readonly<{
  schemaVersion: typeof TEAM_EFFECT_CAPABILITY_CERTIFICATION_SCHEMA_VERSION;
  status: "certified" | "notCertified";
  capabilityProfileId: string;
  candidatePromptVariantId: string;
  minimumCaseCount: number;
  observedCaseCount: number;
  modelCohort: readonly TeamEffectModelCohortMember[] | null;
  cases: readonly TeamEffectCapabilityCertificationCase[];
  failures: readonly TeamEffectCapabilityCertificationFailure[];
}>;

export type TeamEffectCapabilityCertificationInput = Readonly<{
  capabilityProfileId: string;
  candidatePromptVariantId: string;
  minimumCaseCount: number;
  comparisons: readonly Readonly<{
    testCase: unknown;
    baseline: unknown;
    candidate: unknown;
  }>[];
}>;

/**
 * Certifies one prompt/profile treatment only after it wins across distinct GUI
 * cases in one stable per-member model cohort. This is an offline readiness
 * gate; it does not mutate production AgentVersions or planning policy.
 */
export function certifyTeamEffectCapability(
  input: TeamEffectCapabilityCertificationInput,
): TeamEffectCapabilityCertification {
  const capabilityProfileId = requireCertificationId(
    input.capabilityProfileId,
    "team_effect_certification_capability_profile_id_invalid",
  );
  const candidatePromptVariantId = requireCertificationId(
    input.candidatePromptVariantId,
    "team_effect_certification_prompt_variant_id_invalid",
  );
  if (
    !Number.isSafeInteger(input.minimumCaseCount) ||
    input.minimumCaseCount < 3 ||
    input.minimumCaseCount > MAX_CERTIFICATION_CASES
  ) {
    throw new TypeError("team_effect_certification_minimum_case_count_invalid");
  }
  if (
    !Array.isArray(input.comparisons) ||
    input.comparisons.length > MAX_CERTIFICATION_CASES
  ) {
    throw new TypeError("team_effect_certification_comparisons_invalid");
  }

  const parsed = input.comparisons.map(({ testCase, baseline, candidate }) => ({
    testCase: parseTeamEffectCase(testCase),
    baseline: parseTeamEffectGuiTrace(baseline),
    candidate: parseTeamEffectGuiTrace(candidate),
  }));
  const failures: TeamEffectCapabilityCertificationFailure[] = [];
  if (parsed.length < input.minimumCaseCount) {
    failures.push({
      code: "insufficient_cases",
      caseId: null,
      caseRevision: null,
      detail: `Observed ${parsed.length} distinct-case candidates; certification requires at least ${input.minimumCaseCount}.`,
    });
  }

  const seenCases = new Set<string>();
  const seenTraces = new Set<string>();
  let referenceCohort: readonly TeamEffectModelCohortMember[] | null = null;
  let stableModelCohort = true;
  const cases = parsed.map(({ testCase, baseline, candidate }) => {
    const caseFailures: TeamEffectCapabilityCertificationFailure[] = [];
    const fail = (
      code: TeamEffectCapabilityCertificationFailureCode,
      detail: string,
    ) => {
      const failure = {
        code,
        caseId: testCase.caseId,
        caseRevision: testCase.caseRevision,
        detail,
      } as const;
      caseFailures.push(failure);
      failures.push(failure);
    };
    const caseKey = `${testCase.caseId}\u0000${testCase.caseRevision}`;
    if (seenCases.has(caseKey)) {
      fail(
        "duplicate_case",
        `Case ${JSON.stringify(testCase.caseId)} revision ${JSON.stringify(testCase.caseRevision)} was reused.`,
      );
    }
    seenCases.add(caseKey);

    for (const traceId of [baseline.traceId, candidate.traceId]) {
      if (seenTraces.has(traceId)) {
        fail("trace_reused", `Trace ${JSON.stringify(traceId)} was reused.`);
      }
      seenTraces.add(traceId);
    }

    if (candidate.variant.promptVariantId !== candidatePromptVariantId) {
      fail(
        "candidate_prompt_mismatch",
        `Candidate prompt variant ${JSON.stringify(candidate.variant.promptVariantId)} does not match ${JSON.stringify(candidatePromptVariantId)}.`,
      );
    }
    const profileMismatches = candidate.variant.agents
      .filter(
        ({ capabilityProfileId: actual }) => actual !== capabilityProfileId,
      )
      .map(({ memberId, capabilityProfileId: actual }) => ({
        memberId,
        actual,
      }));
    if (profileMismatches.length > 0) {
      fail(
        "candidate_profile_mismatch",
        `Candidate members do not all use capability profile ${JSON.stringify(capabilityProfileId)}: ${JSON.stringify(profileMismatches)}.`,
      );
    }

    const cohort = modelCohort(candidate);
    if (referenceCohort === null) {
      referenceCohort = cohort;
    } else if (!sameModelCohort(referenceCohort, cohort)) {
      stableModelCohort = false;
      fail(
        "suite_model_cohort_mismatch",
        "Candidate per-member provider, model, or reasoning-effort cohort changed across cases.",
      );
    }

    if (!hasRequiredTopologyGates(testCase)) {
      fail(
        "topology_gate_missing",
        "modelRunCount and logicalPhaseCount must each forbid regression and require a positive improvement.",
      );
    }

    const comparison = compareTeamEffectVariants(testCase, baseline, candidate);
    if (comparison.status !== "compared") {
      fail(
        "comparison_not_passed",
        `Baseline/candidate comparison was not allowed: ${comparison.reason}.`,
      );
    } else if (comparison.efficiencyFailures.length > 0) {
      fail(
        "efficiency_gate_failed",
        `Candidate failed ${comparison.efficiencyFailures.length} authored efficiency gate(s).`,
      );
    }

    return {
      caseId: testCase.caseId,
      caseRevision: testCase.caseRevision,
      baselineTraceId: baseline.traceId,
      candidateTraceId: candidate.traceId,
      passed: caseFailures.length === 0,
      failures: caseFailures,
    };
  });

  return {
    schemaVersion: TEAM_EFFECT_CAPABILITY_CERTIFICATION_SCHEMA_VERSION,
    status: failures.length === 0 ? "certified" : "notCertified",
    capabilityProfileId,
    candidatePromptVariantId,
    minimumCaseCount: input.minimumCaseCount,
    observedCaseCount: parsed.length,
    modelCohort: stableModelCohort ? referenceCohort : null,
    cases,
    failures,
  };
}

function modelCohort(
  trace: TeamEffectGuiTrace,
): readonly TeamEffectModelCohortMember[] {
  return trace.variant.agents
    .map(({ memberId, providerId, modelId, reasoningEffort }) => ({
      memberId,
      providerId,
      modelId,
      reasoningEffort,
    }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
}

function sameModelCohort(
  left: readonly TeamEffectModelCohortMember[],
  right: readonly TeamEffectModelCohortMember[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasRequiredTopologyGates(testCase: TeamEffectCase): boolean {
  return [
    testCase.efficiencyGate.modelRunCount,
    testCase.efficiencyGate.logicalPhaseCount,
  ].every(
    ({ maxRegressionPercent, minImprovementPercent }) =>
      maxRegressionPercent === 0 &&
      minImprovementPercent !== null &&
      minImprovementPercent > 0,
  );
}

function requireCertificationId(value: unknown, error: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 160 ||
    value !== value.trim()
  ) {
    throw new TypeError(error);
  }
  return value;
}
