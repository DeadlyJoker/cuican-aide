import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  extensionCanonicalJson,
  createProjectTextPlanRunAdmission,
  type ProjectStageRunAdmission,
  type ProjectTextPlanRunAdmission,
} from "@crewon/domain";
import { planFixture } from "../../../packages/store/src/project-text-plan.test-support.ts";
import { projectToolsOwnerFixture } from "./project-tools-service-owner.test-support.ts";
import { readProjectTextPlanRuntimeScope } from "./plugins/project-text-plan-runtime-scope.ts";
const digester = {
  sha256: (text: string) =>
    `sha256:${createHash("sha256").update(text).digest("hex")}`,
};
async function scoped(t: Parameters<typeof projectToolsOwnerFixture>[0]) {
  let stage: ProjectStageRunAdmission | undefined,
    plan: ProjectTextPlanRunAdmission | undefined,
    p: Awaited<ReturnType<typeof planFixture>> | undefined;
  const f = await projectToolsOwnerFixture(t, {
    prepareAdmission: async (base) => {
      p = await planFixture(t, "sqlite", base);
      const started = await p.start(),
        admitted = await p.admit(started);
      stage = admitted.result.stageAdmission;
      const raw = await p.plans.loadRunAdmission({
        tenantId: p.actor.tenantId,
        spaceId: p.actor.spaceId,
        runId: admitted.result.result.binding.runId,
      });
      assert.ok(raw);
      plan = raw;
      return admitted.result.result;
    },
    stageAdmission: () => stage,
  });
  assert.ok(stage);
  assert.ok(plan);
  assert.ok(p);
  return { ...f, stage, plan, plans: p.plans };
}
test("actual planned Run requires its independent marker/admission; genuine legacy and plain Stage retain null plan scope", async (t) => {
  const f = await scoped(t),
    signal = new AbortController().signal,
    input = {
      plans: f.plans,
      admission: f.admission,
      binding: f.binding,
      stage: f.stage,
      signal,
    };
  assert.deepEqual(await readProjectTextPlanRuntimeScope(input), f.plan);
  await assert.rejects(
    readProjectTextPlanRuntimeScope({
      ...input,
      plans: {
        readRequiredPlanDigest: (locator) =>
          f.plans.readRequiredPlanDigest(locator),
        loadRunAdmission: async () => null,
      },
    }),
    /project_text_plan_missing/,
  );
  await assert.rejects(
    readProjectTextPlanRuntimeScope({
      ...input,
      plans: {
        readRequiredPlanDigest: async () => null,
        loadRunAdmission: async () => f.plan,
      },
    }),
    /project_text_plan_mismatch/,
  );
  await assert.rejects(
    readProjectTextPlanRuntimeScope({ ...input, stage: null }),
    /project_text_plan_mismatch/,
  );
  const legacy = await projectToolsOwnerFixture(t);
  assert.equal(
    await readProjectTextPlanRuntimeScope({
      plans: legacy.parent.projectTextPlanStore(),
      admission: legacy.admission,
      binding: legacy.binding,
      stage: null,
      signal,
    }),
    null,
  );
});
test("plan full Run/actor/installation/config/source identity cannot be substituted or normalized", async (t) => {
  const f = await scoped(t),
    signal = new AbortController().signal;
  const { contentDigest: _digest, schemaVersion: _schema, ...body } = f.plan;
  const altered = createProjectTextPlanRunAdmission(
    { ...body, runId: "other-run" },
    digester,
  );
  await assert.rejects(
    readProjectTextPlanRuntimeScope({
      plans: {
        readRequiredPlanDigest: async () => altered.contentDigest,
        loadRunAdmission: async () => altered,
      },
      admission: f.admission,
      binding: f.binding,
      stage: f.stage,
      signal,
    }),
    /project_text_plan_mismatch/,
  );
});
test("genuine Worker dispatch forwards immutable plan qualification into actual candidate COMMIT and cold same-receipt replay", async (t) => {
  const f = await scoped(t),
    owner = f.owner({ planAdmission: f.plan });
  const request = {
    projectId: f.stage.projectId,
    expectedArtifactRevision: 0,
    briefRevision: f.stage.sources.brief!.briefRevision,
    content: {
      title: "Plan outline",
      logline: "The keeper reads a letter.",
      synopsis: "A letter returns to the railway station.",
      episodes: f.plan.expectedEpisodeIds.map((episodeId) => ({
        episodeId,
        title: "Letter",
        summary: "The keeper answers.",
      })),
    },
  };
  const operation = await f.prepareOperation("outline_save", request),
    service = f.service(owner);
  await assert.rejects(
    service.saveOutlineCandidate({ command: operation.command, request }),
    /authority_denied/,
  );
  const first = await f.invoke(owner, operation, (command) =>
    service.saveOutlineCandidate({ command, request }),
  );
  assert.equal(first.disposition, "committed");
  await owner.close();
  const cold = f.owner({ planAdmission: f.plan });
  const replay = await f.invoke(
    cold,
    operation,
    (command) => f.service(cold).saveOutlineCandidate({ command, request }),
    { method: "reconcile" },
  );
  assert.equal(replay.disposition, "replayed");
  assert.deepEqual(replay.artifact, first.artifact);
  const wrong = {
    ...request,
    expectedArtifactRevision: 1,
    content: {
      ...request.content,
      episodes: [
        {
          episodeId: "foreign-episode",
          title: "Wrong",
          summary: "Wrong frozen episode ID.",
        },
      ],
    },
  };
  const second = await f.prepareOperation("outline_save", wrong);
  await assert.rejects(
    f.invoke(cold, second, (command) =>
      f.service(cold).saveOutlineCandidate({ command, request: wrong }),
    ),
    /plan_outline_episodes_invalid/,
  );
});
