import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ProjectTextPlanApplicationService } from "@crewon/application";
import { extensionCanonicalJson } from "@crewon/domain";
import { planFixture } from "../../../packages/store/src/project-text-plan.test-support.ts";

test("known precommit remaining-scope rejection is a conflict and leaves the actual paused plan and receipt count intact", async (t) => {
  const f = await planFixture(t, "sqlite"),
    d = f.definition({
      start: "script",
      targetStage: "script",
      episodeMode: "independentScripts",
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
    p = await f.start(d),
    paused = await f.plans.commitControl(
      f.control("pause", d, p.result, randomUUID()),
      { authority: f.planAuthority(null) },
    );
  const request = {
    projectId: f.binding.projectId,
    planId: d.planId,
    expectedRevision: paused.plan.revision,
    expectedBriefRevision: 1,
    instruction: d.instruction,
    start: "outline" as const,
    target: "script" as const,
    episodes: { kind: "newOutline" as const, episodeCount: 1 },
    adoption: d.adoption,
    idempotencyKey: randomUUID(),
  };
  const authority = f.planAuthority({
    kind: "pluginUi",
    contributionId: "workbench",
    actionId: "crewon.project-text-plans.v1.reviseRemaining",
    invocationId: randomUUID(),
    idempotencyKey: request.idempotencyKey,
    inputDigest: f.digester.sha256(
      extensionCanonicalJson({
        action: "crewon.project-text-plans.v1.reviseRemaining",
        input: request,
      }),
    ),
  });
  const service = new ProjectTextPlanApplicationService({
    plans: f.plans,
    conversations: f.store,
    projects: f.metadata,
    texts: f.text,
    extensions: f.first.store,
    authorization: {
      async authorize() {
        return { outcome: "allow" };
      },
    },
    clock: { now: () => new Date().toISOString() },
    ids: { nextId: () => randomUUID() },
    digester: f.digester,
  });
  await assert.rejects(service.reviseRemaining(f.actor, request, authority), {
    category: "conflict",
    code: "project_text_plan_remaining_scope_invalid",
  });
  assert.deepEqual(
    await f.plans.loadPlan({ ...f.owner, planId: d.planId }),
    paused.plan,
  );
  assert.equal(
    Number(
      (
        await f.rows(
          `SELECT COUNT(*) AS n FROM ${f.prefix}project_text_plan_receipts`,
        )
      )[0]?.n,
    ),
    2,
  );
  assert.equal(
    Number(
      (await f.rows(`SELECT COUNT(*) AS n FROM ${f.prefix}run_snapshots`))[0]
        ?.n,
    ),
    0,
  );
});
