import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { planFixture } from "./project-text-plan.test-support.ts";
import { projectRunCommitFixture } from "./creative-project-run-commit.test-support.ts";
import { completePlanFixtureRun } from "./project-text-plan-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: sixteen genuine sequential script stages preserve a >64KiB control receipt on cold replay`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await planFixture(t, backend),
        episodeIds = Array.from({ length: 16 }, (_, i) => `episode-${i + 1}`);
      const original = await f.start(
        f.definition({
          start: "script",
          targetStage: "script",
          episodeMode: "independentScripts",
          episodeIds,
          baselines: episodeIds.map((episodeId) => ({
            kind: "script" as const,
            episodeId,
            artifactId: null,
            artifactRevision: 0,
            selectedContentRevision: null,
            locked: false,
          })),
        }),
      );
      let current = original;
      let lastInput: ReturnType<typeof f.control> | null = null;
      for (const episodeId of episodeIds) {
        assert.equal(current.result.plan.state, "ready");
        const step = current.result.steps.find(
          (s) => s.stepId === current.result.plan.activeStepId,
        );
        assert.equal(step?.episodeId, episodeId);
        let admitted: Awaited<ReturnType<typeof f.admit>> | null = null;
        const run = await projectRunCommitFixture(
          t,
          backend,
          async () => {
            admitted = await f.admit(
              current,
              `actual-script-${episodeId}`,
              "x".repeat(1999),
            );
            return admitted.result.result;
          },
          f.originalTaskFixture,
        );
        function actual() {
          assert.ok(admitted);
          return admitted;
        }
        const a = actual(),
          base = await run.prepareOperation(
            "script_save",
            {
              projectId: f.binding.projectId,
              episodeId,
              expectedArtifactRevision: 0,
              briefRevision: 1,
              outline: null,
              content: {
                title: episodeId,
                scenes: [
                  {
                    sceneId: "scene-original",
                    location: "A saved room",
                    timeOfDay: "Night",
                    action: "An actual text candidate",
                    dialogue: [],
                  },
                ],
              },
            },
            a.result.stageAdmission,
          );
        const transaction = {
            ...base.transaction,
            projectTextPlanAdmission: a.result.planAdmission,
          },
          options = {
            authority: {
              ...base.options.authority!,
              runTransaction: transaction,
            },
          };
        const saved = await run.text.saveScriptCandidate(
          f.actor,
          base.commandBody as never,
          options,
        );
        const observed = await completePlanFixtureRun({
          run,
          f,
          p: current,
          admission: a.result.planAdmission,
          op: base,
        });
        assert.equal(observed.plan.state, "waitingSelection");
        await run.parent.completeWorkItem(run.lease);
        await run.text.selectRevision(f.actor, {
          projectId: f.binding.projectId,
          artifactId: saved.artifact.artifactId,
          contentRevision: 1,
          expectedArtifactRevision: saved.artifact.revision,
          idempotencyKey: randomUUID(),
        });
        const plan = await f.plans.loadPlan({
          ...f.owner,
          planId: original.d.planId,
        });
        assert.ok(plan);
        const steps = await f.plans.listSteps({
          ...f.owner,
          planId: original.d.planId,
          planRevision: 1,
        });
        lastInput = f.control(
          "continue",
          original.d,
          { ...current.result, plan, steps },
          randomUUID(),
        );
        const result = await f.plans.commitControl(lastInput, {
          authority: f.planAuthority(null),
        });
        current = { ...current, result };
      }
      assert.ok(lastInput);
      assert.equal(current.result.plan.state, "completed");
      assert.equal(
        current.result.steps.filter((s) => s.state === "succeeded").length,
        16,
      );
      const stored = (
        await f.rows(
          `SELECT result_json FROM ${f.prefix}project_text_plan_receipts WHERE idempotency_key='${lastInput.receipt.idempotencyKey}'`,
        )
      )[0]?.result_json;
      const bytes = Buffer.byteLength(
        typeof stored === "string" ? stored : JSON.stringify(stored),
      );
      assert.ok(bytes > 65536);
      assert.ok(bytes < 512 * 1024);
      const cold = f.second.parent.projectTextPlanStore(),
        replay = await cold.commitControl(lastInput, {
          authority: f.planAuthority(null),
        });
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.plan, current.result.plan);
      assert.deepEqual(replay.steps, current.result.steps);
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        16,
      );
      assert.equal(
        Number(
          (
            await f.rows(
              `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_revisions`,
            )
          )[0]?.n,
        ),
        16,
      );
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
}
