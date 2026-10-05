import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  ProjectTextPlanApplicationService,
  ProjectTextApplicationService,
} from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { planFixture } from "../../../packages/store/src/project-text-plan.test-support.ts";
import { planOutline } from "../../../packages/store/src/project-text-plan-run.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: resume preserves the chosen outline; explicit reviseRemaining can adopt the human's new choice`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await planFixture(t, backend),
        common = {
          authorization: {
            async authorize() {
              return { outcome: "allow" as const };
            },
          },
          clock: { now: () => new Date().toISOString() },
          ids: { nextId: () => randomUUID() },
          digester: f.digester,
        },
        text = new ProjectTextApplicationService({
          ...common,
          store: f.text,
          projects: f.metadata,
        }),
        service = new ProjectTextPlanApplicationService({
          ...common,
          plans: f.plans,
          conversations: f.store,
          projects: f.metadata,
          texts: f.text,
          extensions: f.first.store,
        });
      const first = await text.saveOutlineCandidate(f.actor, {
        projectId: f.binding.projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: planOutline,
        idempotencyKey: randomUUID(),
      });
      const selected = await text.selectRevision(f.actor, {
        projectId: f.binding.projectId,
        artifactId: first.artifact.artifactId,
        expectedArtifactRevision: first.artifact.revision,
        contentRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const d = f.definition({
        start: "script",
        targetStage: "script",
        episodeMode: "selectedOutline",
        sources: {
          brief: f.definition().sources.brief,
          outline: {
            artifactId: first.artifact.artifactId,
            contentRevision: 1,
            contentDigest: first.contentRevision!.contentDigest,
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
      });
      const p = await f.start(d),
        paused = await f.plans.commitControl(
          f.control("pause", d, p.result, randomUUID()),
          { authority: f.planAuthority(null) },
        );
      const human = await text.saveOutlineCandidate(f.actor, {
        projectId: f.binding.projectId,
        expectedArtifactRevision: selected.artifact.revision,
        briefRevision: 1,
        content: {
          ...planOutline,
          synopsis: "A human explicitly selected another outline",
        },
        idempotencyKey: randomUUID(),
      });
      await text.selectRevision(f.actor, {
        projectId: f.binding.projectId,
        artifactId: human.artifact.artifactId,
        expectedArtifactRevision: human.artifact.revision,
        contentRevision: 2,
        idempotencyKey: randomUUID(),
      });
      const request = {
        projectId: f.binding.projectId,
        planId: d.planId,
        expectedRevision: paused.plan.revision,
        idempotencyKey: randomUUID(),
      };
      const issue = (
        method: "resume" | "reviseRemaining",
        body: unknown,
        key: string,
      ) =>
        f.planAuthority({
          kind: "pluginUi",
          contributionId: "workbench",
          actionId: `crewon.project-text-plans.v1.${method}`,
          invocationId: randomUUID(),
          idempotencyKey: key,
          inputDigest: f.digester.sha256(
            extensionCanonicalJson({
              action: `crewon.project-text-plans.v1.${method}`,
              input: body,
            }),
          ),
        });
      await assert.rejects(
        service.resume(
          f.actor,
          request,
          issue("resume", request, request.idempotencyKey),
        ),
        { code: "project_text_plan_source_changed" },
      );
      assert.deepEqual(
        await f.plans.loadPlan({ ...f.owner, planId: d.planId }),
        paused.plan,
      );
      const revised = {
        ...request,
        idempotencyKey: randomUUID(),
        expectedBriefRevision: 1,
        instruction: d.instruction,
        start: "script" as const,
        target: "script" as const,
        episodes: {
          kind: "selectedOutline" as const,
          episodeIds: ["episode-one"],
        },
        adoption: d.adoption,
      };
      const result = await service.reviseRemaining(
        f.actor,
        revised,
        issue("reviseRemaining", revised, revised.idempotencyKey),
      );
      assert.equal(result.view.plan.currentPlanRevision, 2);
      assert.equal(result.view.definition.sources.outline?.contentRevision, 2);
      assert.equal(result.view.plan.state, "ready");
      assert.equal(
        Number(
          (
            await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`)
          )[0]?.n,
        ),
        0,
      );
      assert.deepEqual(await f.creditObjects(), []);
    },
  );
}
