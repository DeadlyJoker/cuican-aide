import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ProjectTextApplicationService } from "@crewon/application";
import { planFixture } from "./project-text-plan.test-support.ts";
import { planOutline } from "./project-text-plan-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const savedBeforeChange of [false, true])
    test(
      `${backend}: current replacement outline cannot repin a frozen script plan; saved=${savedBeforeChange}`,
      options,
      async (t) => {
        const f = await planFixture(t, backend),
          text = new ProjectTextApplicationService({
            store: f.text,
            projects: f.metadata,
            authorization: {
              authorize: async () => ({ outcome: "allow" as const }),
            },
            clock: { now: () => new Date().toISOString() },
            ids: { nextId: () => randomUUID() },
            digester: f.digester,
          });
        const original = await text.saveOutlineCandidate(f.actor, {
          projectId: f.binding.projectId,
          expectedArtifactRevision: 0,
          briefRevision: 1,
          content: planOutline,
          idempotencyKey: randomUUID(),
        });
        const selected = await text.selectRevision(f.actor, {
          projectId: f.binding.projectId,
          artifactId: original.artifact.artifactId,
          expectedArtifactRevision: original.artifact.revision,
          contentRevision: 1,
          idempotencyKey: randomUUID(),
        });
        assert.ok(original.contentRevision);
        const d = f.definition({
            start: "script",
            targetStage: "script",
            episodeMode: "selectedOutline",
            sources: {
              ...f.definition().sources,
              outline: {
                artifactId: original.artifact.artifactId,
                contentRevision: 1,
                contentDigest: original.contentRevision.contentDigest,
              },
            },
            baselines: [
              {
                kind: "script",
                episodeId: "episode-one",
                artifactId: null,
                artifactRevision: 0,
                selectedContentRevision: null,
                locked: false,
              },
            ],
          }),
          p = await f.start(d);
        const accepted = savedBeforeChange ? await f.admit(p) : null;
        const replacement = await text.saveOutlineCandidate(f.actor, {
          projectId: f.binding.projectId,
          expectedArtifactRevision: selected.artifact.revision,
          briefRevision: 1,
          content: { ...planOutline, synopsis: "An actual later outline" },
          idempotencyKey: randomUUID(),
        });
        assert.ok(replacement.contentRevision);
        await text.selectRevision(f.actor, {
          projectId: f.binding.projectId,
          artifactId: replacement.artifact.artifactId,
          expectedArtifactRevision: replacement.artifact.revision,
          contentRevision: 2,
          idempotencyKey: randomUUID(),
        });
        if (accepted === null) {
          // A genuine current Stage could use this replacement, but this plan still owns its original source.
          await assert.rejects(
            f.admit(p, randomUUID(), d.instruction, {
              brief: d.sources.brief,
              outline: {
                artifactId: replacement.artifact.artifactId,
                contentRevision: 2,
                contentDigest: replacement.contentRevision.contentDigest,
              },
            }),
            hasCause("project_text_plan_source_changed"),
          );
          assert.equal(
            Number(
              (
                await f.rows(
                  `SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`,
                )
              )[0]?.n,
            ),
            0,
          );
        } else {
          const replay = await f.tasks.createProjectTextPlanTurnFromHost(
            f.actor,
            accepted.command,
            accepted.task,
            accepted.planAuthority,
          );
          assert.equal(replay.result.run.disposition, "replayed");
          assert.deepEqual(replay.planAdmission, accepted.result.planAdmission);
          assert.equal(
            replay.planAdmission.sources.outline?.contentRevision,
            1,
          );
          assert.equal(
            Number(
              (
                await f.rows(
                  `SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`,
                )
              )[0]?.n,
            ),
            1,
          );
        }
        assert.deepEqual(await f.creditObjects(), []);
      },
    );
}
function hasCause(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code || hasCause(code)(error.cause));
}
