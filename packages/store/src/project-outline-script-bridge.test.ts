import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ProjectTextApplicationService } from "@crewon/application";
import { parseProjectTextArtifactRevision } from "@crewon/domain";
import {
  structuredOutlineFixture,
  candidate,
  selection,
  actor,
  digester,
  time,
  proposalRecipe,
  confirmationRecipe,
  code,
} from "./project-structured-outline.test-support.ts";

type Fixture = Awaited<ReturnType<typeof structuredOutlineFixture>>;
function application(host: Fixture["first"]) {
  return new ProjectTextApplicationService({
    store: host.text,
    projects: host.projects,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => time(5) },
    ids: { nextId: () => randomUUID() },
    digester,
  });
}
async function setup(f: Fixture) {
  const prepared = candidate(f, "outline-script-source");
  await f.first.text.commitStructuredOutlineCandidate(prepared);
  await f.first.text.commitStructuredOutlineSelection(
    selection(
      f,
      "outline-script-source-adopt",
      prepared.artifact,
      prepared.contentRevision,
    ),
  );
  return {
    projectId: f.scope.projectId,
    episodeId: f.document.episodes[0]!.episodeId,
    expectedArtifactRevision: 0,
    briefRevision: f.created.brief!.briefRevision,
    outline: {
      artifactId: prepared.artifact.artifactId,
      contentRevision: prepared.contentRevision.contentRevision,
    },
    content: {
      title: "第一集：渡口来信",
      scenes: [
        {
          sceneId: "original-scene-1",
          location: "渡口",
          timeOfDay: "晨",
          action: "主角打开来信。",
          dialogue: [{ speaker: "主角", text: "这是谁留下的？" }],
        },
      ],
    },
    idempotencyKey: "original-script-candidate",
  };
}
async function changePlan(f: Fixture) {
  const plan = await f.foundations.commitProposal(
    proposalRecipe(
      f.created.project,
      f.confirmed.foundation,
      "script-new-plan",
      f.proposal,
      6,
    ),
  );
  await f.foundations.commitFoundationChange(
    confirmationRecipe(
      f.created.project,
      f.confirmed.foundation,
      plan.proposal!,
      "script-confirm-new-plan",
      7,
    ),
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: structured outline feeds the original script slot, selection, edits and cold receipt replay`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = await setup(f);
      const producer = application(f.first);
      const saved = await producer.saveScriptCandidate(actor, command);
      assert.equal(
        saved.contentRevision!.schemaVersion,
        "crewon.project-text-revision.v1",
      );
      const source = await f.first.text.loadOutlineSourceRevision({
        ...f.scope,
        ...command.outline,
      });
      assert.ok(source);
      await assert.rejects(
        f.first.text.loadOutlineSourceRevision({
          ...f.scope,
          artifactId: saved.artifact.artifactId,
          contentRevision: 1,
        }),
        code("project_text_outline_reference_invalid"),
      );
      assert.deepEqual(saved.contentRevision!.outline, {
        ...command.outline,
        contentDigest: source.contentDigest,
      });
      assert.throws(() => parseProjectTextArtifactRevision(source, digester));
      await assert.rejects(
        f.first.text.loadRevision({ ...f.scope, ...command.outline }),
        code("project_text_protocol_upgrade_required"),
      );
      const adopted = await producer.selectRevision(actor, {
        projectId: command.projectId,
        artifactId: saved.artifact.artifactId,
        expectedArtifactRevision: saved.artifact.revision,
        contentRevision: 1,
        idempotencyKey: "script-adopt",
      });
      const edit = await producer.saveScriptCandidate(actor, {
        ...command,
        expectedArtifactRevision: adopted.artifact.revision,
        content: { ...command.content, title: "人工修改标题" },
        idempotencyKey: "script-human-edit",
      });
      assert.equal(edit.artifact.selectedContentRevision, 1);
      const host = await f.open();
      const cold = application(host);
      const view = await cold.getScript(actor, {
        projectId: command.projectId,
        episodeId: command.episodeId,
      });
      assert.equal(view?.dependencyState, "current");
      assert.equal(view?.artifact.artifactId, saved.artifact.artifactId);
      assert.deepEqual(view?.selectedRevision?.content, command.content);
      await changePlan(f);
      const replay = await cold.saveScriptCandidate(actor, command);
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.contentRevision, saved.contentRevision);
      await assert.rejects(
        cold.saveScriptCandidate(actor, {
          ...command,
          expectedArtifactRevision: edit.artifact.revision,
          idempotencyKey: "stale-source-cannot-write",
        }),
        /project_outline_inputs_stale/,
      );
      await assert.rejects(
        cold.selectRevision(actor, {
          projectId: command.projectId,
          artifactId: saved.artifact.artifactId,
          expectedArtifactRevision: edit.artifact.revision,
          contentRevision: 2,
          idempotencyKey: "stale-source-cannot-adopt",
        }),
        /project_outline_inputs_stale/,
      );
      assert.equal(await f.count("project_text_revisions"), 3);
      assert.equal(await f.count("project_text_artifacts"), 2);
      assert.deepEqual(
        await host.text.loadOutlineSourceRevision({
          ...f.scope,
          ...command.outline,
        }),
        source,
      );
    },
  );
  test(
    `${backend}: unknown episode and foreign source cannot create a script artifact or receipt`,
    options,
    async (t) => {
      const f = await structuredOutlineFixture(t, backend);
      const command = await setup(f);
      const service = application(f.first);
      await assert.rejects(
        service.saveScriptCandidate(actor, {
          ...command,
          episodeId: "invented-episode",
          idempotencyKey: "unknown-episode",
        }),
        /project_text_outline_reference_invalid/,
      );
      assert.equal(
        await f.first.text.loadOutlineSourceRevision({
          ...f.scope,
          owner: { ...f.scope.owner, principalId: "foreign" },
          ...command.outline,
        }),
        null,
      );
      await assert.rejects(
        service.saveScriptCandidate(
          { ...actor, principalId: "foreign" },
          command,
        ),
      );
      assert.equal(await f.count("project_text_artifacts"), 1);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 2);
    },
  );
}
