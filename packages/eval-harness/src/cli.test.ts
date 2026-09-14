import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runTeamEffectCli } from "./cli.ts";
import { parseTeamEffectGuiTrace } from "./team-effect-evaluation.ts";

const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/", import.meta.url),
);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const casePath = path.join(
  fixtureDirectory,
  "example-release-decision.case.v1.json",
);
const baselinePath = path.join(
  fixtureDirectory,
  "example-release-decision.baseline.gui-trace.v1.json",
);
const candidatePath = path.join(
  fixtureDirectory,
  "example-release-decision.candidate.gui-trace.v1.json",
);

test("offline CLI evaluates one GUI trace and compares two passing variants", () => {
  const evaluated = invokeCli(["evaluate", "--", casePath, candidatePath]);
  assert.equal(evaluated.exitCode, 0);
  assert.equal(evaluated.stderr, "");
  assert.deepEqual(JSON.parse(evaluated.stdout), {
    schemaVersion: "crewon.team-effect-quality-result.v1",
    caseId: "example-release-decision",
    caseRevision: "revision-1",
    traceId: "example-candidate-001",
    variantId: "role-directed",
    passed: true,
    failures: [],
  });

  const compared = invokeCli([
    "compare",
    casePath,
    baselinePath,
    candidatePath,
  ]);
  assert.equal(compared.exitCode, 0);
  assert.equal(compared.stderr, "");
  assert.equal(
    (JSON.parse(compared.stdout) as { status: unknown }).status,
    "compared",
  );
});

test("CLI exits non-zero for rejected evaluations and comparisons", () => {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "crewon-eval-harness-"),
  );
  const failingTracePath = path.join(temporaryDirectory, "failing-trace.json");
  const regressedTracePath = path.join(
    temporaryDirectory,
    "regressed-trace.json",
  );
  const missingMetricTracePath = path.join(
    temporaryDirectory,
    "missing-metric-trace.json",
  );
  const insufficientImprovementTracePath = path.join(
    temporaryDirectory,
    "insufficient-improvement-trace.json",
  );
  const modelCohortMismatchTracePath = path.join(
    temporaryDirectory,
    "model-cohort-mismatch-trace.json",
  );
  const measurementCohortMismatchTracePath = path.join(
    temporaryDirectory,
    "measurement-cohort-mismatch-trace.json",
  );
  try {
    const candidate = parseTeamEffectGuiTrace(
      JSON.parse(readFileSync(candidatePath, "utf8")) as unknown,
    );
    writeFileSync(
      failingTracePath,
      JSON.stringify({
        ...candidate,
        ui: { ...candidate.ui, userMessageCopies: 2 },
      }),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cliPath,
        "evaluate",
        casePath,
        failingTracePath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout) as {
      passed: unknown;
      failures: Array<{ code: unknown }>;
    };
    assert.equal(output.passed, false);
    assert.deepEqual(
      output.failures.map(({ code }) => code),
      ["user_message_copy_count_invalid"],
    );

    const compared = invokeCli([
      "compare",
      casePath,
      baselinePath,
      failingTracePath,
    ]);
    assert.equal(compared.exitCode, 1);
    assert.equal(compared.stderr, "");
    assert.equal(
      (JSON.parse(compared.stdout) as { status: unknown }).status,
      "notCompared",
    );

    writeFileSync(
      regressedTracePath,
      JSON.stringify({
        ...candidate,
        efficiency: {
          ...candidate.efficiency,
          modelRunCount: 5,
          logicalPhaseCount: 4,
        },
      }),
      "utf8",
    );
    const regressed = invokeCli([
      "compare",
      casePath,
      baselinePath,
      regressedTracePath,
    ]);
    assert.equal(regressed.exitCode, 1);
    assert.equal(regressed.stderr, "");
    const regressionOutput = JSON.parse(regressed.stdout) as {
      status: unknown;
      efficiencyFailures: Array<{ metric: unknown }>;
    };
    assert.equal(regressionOutput.status, "compared");
    assert.deepEqual(
      regressionOutput.efficiencyFailures.map(({ metric }) => metric),
      ["modelRunCount", "logicalPhaseCount"],
    );

    writeFileSync(
      missingMetricTracePath,
      JSON.stringify({
        ...candidate,
        efficiency: { ...candidate.efficiency, modelRunCount: null },
      }),
      "utf8",
    );
    const missingMetric = invokeCli([
      "compare",
      casePath,
      baselinePath,
      missingMetricTracePath,
    ]);
    assert.equal(missingMetric.exitCode, 1);
    assert.equal(missingMetric.stderr, "");
    assert.deepEqual(
      (
        JSON.parse(missingMetric.stdout) as {
          efficiencyFailures: Array<{ code: unknown; metric: unknown }>;
        }
      ).efficiencyFailures.map(({ code, metric }) => ({ code, metric })),
      [{ code: "measurement_missing", metric: "modelRunCount" }],
    );

    writeFileSync(
      insufficientImprovementTracePath,
      JSON.stringify({
        ...candidate,
        traceId: "candidate-without-work-improvement",
        efficiency: {
          ...candidate.efficiency,
          modelRunCount: 4,
          logicalPhaseCount: 3,
        },
      }),
      "utf8",
    );
    const insufficientImprovement = invokeCli([
      "compare",
      casePath,
      baselinePath,
      insufficientImprovementTracePath,
    ]);
    assert.equal(insufficientImprovement.exitCode, 1);
    assert.equal(insufficientImprovement.stderr, "");
    assert.deepEqual(
      (
        JSON.parse(insufficientImprovement.stdout) as {
          efficiencyFailures: Array<{ code: unknown; metric: unknown }>;
        }
      ).efficiencyFailures.map(({ code, metric }) => ({ code, metric })),
      [
        {
          code: "minimum_improvement_not_met",
          metric: "modelRunCount",
        },
        {
          code: "minimum_improvement_not_met",
          metric: "logicalPhaseCount",
        },
      ],
    );

    writeFileSync(
      modelCohortMismatchTracePath,
      JSON.stringify({
        ...candidate,
        traceId: "candidate-with-model-cohort-mismatch",
        variant: {
          ...candidate.variant,
          agents: candidate.variant.agents.map((agent) =>
            agent.memberId === "planner"
              ? { ...agent, modelId: "another-model" }
              : agent,
          ),
        },
      }),
      "utf8",
    );
    const cohortMismatch = invokeCli([
      "compare",
      casePath,
      baselinePath,
      modelCohortMismatchTracePath,
    ]);
    assert.equal(cohortMismatch.exitCode, 1);
    assert.equal(cohortMismatch.stderr, "");
    const cohortMismatchOutput = JSON.parse(cohortMismatch.stdout) as {
      status: unknown;
      reason: unknown;
      baselineQuality: { passed: unknown };
      candidateQuality: { passed: unknown };
    };
    assert.equal(cohortMismatchOutput.status, "notCompared");
    assert.equal(cohortMismatchOutput.reason, "model_cohort_mismatch");
    assert.equal(cohortMismatchOutput.baselineQuality.passed, true);
    assert.equal(cohortMismatchOutput.candidateQuality.passed, true);

    writeFileSync(
      measurementCohortMismatchTracePath,
      JSON.stringify({
        ...candidate,
        traceId: "candidate-with-measurement-cohort-mismatch",
        variant: {
          ...candidate.variant,
          harnessVersion: "incompatible-harness-v999",
        },
      }),
      "utf8",
    );
    const measurementCohortMismatch = invokeCli([
      "compare",
      casePath,
      baselinePath,
      measurementCohortMismatchTracePath,
    ]);
    assert.equal(measurementCohortMismatch.exitCode, 1);
    assert.equal(measurementCohortMismatch.stderr, "");
    const measurementCohortMismatchOutput = JSON.parse(
      measurementCohortMismatch.stdout,
    ) as {
      status: unknown;
      reason: unknown;
      efficiency: unknown;
      efficiencyFailures: unknown;
    };
    assert.equal(measurementCohortMismatchOutput.status, "notCompared");
    assert.equal(
      measurementCohortMismatchOutput.reason,
      "measurement_cohort_mismatch",
    );
    assert.equal(measurementCohortMismatchOutput.efficiency, null);
    assert.deepEqual(measurementCohortMismatchOutput.efficiencyFailures, []);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("offline CLI returns an actionable schema error and usage exit code", () => {
  const invalid = invokeCli(["evaluate", casePath, "missing-trace.json"]);
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.stdout, "");
  assert.deepEqual(JSON.parse(invalid.stderr), {
    schemaVersion: "crewon.team-effect-cli-error.v1",
    passed: false,
    error: {
      code: "team_effect_cli_file_read_failed",
      detail: 'Could not read local fixture "missing-trace.json".',
    },
  });

  const usage = invokeCli([]);
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /^Usage:/u);

  const duplicateTrace = invokeCli([
    "compare",
    casePath,
    baselinePath,
    baselinePath,
  ]);
  assert.equal(duplicateTrace.exitCode, 2);
  assert.equal(duplicateTrace.stdout, "");
  assert.equal(
    (
      JSON.parse(duplicateTrace.stderr) as {
        error: { code: unknown };
      }
    ).error.code,
    "team_effect_comparison_trace_id_duplicate",
  );
});

function invokeCli(args: readonly string[]): Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const exitCode = runTeamEffectCli(args, {
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
}
