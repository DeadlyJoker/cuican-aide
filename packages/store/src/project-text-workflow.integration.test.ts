import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  ApplicationError,
  ProjectTextApplicationService,
} from "@crewon/application";
import type {
  ProjectOutlineContent,
  ProjectScriptContent,
} from "@crewon/domain";
import {
  actor,
  application,
  command,
  digester,
  fixture,
  timestamp,
} from "./creative-project-store.test-support.ts";

const outline: ProjectOutlineContent = {
  title: "修复师的三封信",
  logline: "修复师在旧画中发现失踪家人的线索。",
  synopsis: "女主修复一幅画，循三封信找出画作流转背后的真相。",
  episodes: [
    {
      episodeId: "episode-1",
      title: "雨中的画",
      summary: "旧画藏有第一封信。",
    },
    {
      episodeId: "episode-2",
      title: "消失的署名",
      summary: "第二封信指向旧友。",
    },
    {
      episodeId: "episode-3",
      title: "最后一层颜料",
      summary: "第三封信揭开真相。",
    },
  ],
};
function script(line: string): ProjectScriptContent {
  return {
    title: "第一集：雨中的画",
    scenes: [
      {
        sceneId: "scene-1",
        location: "修复工作室",
        timeOfDay: "夜",
        action: "女主停下画笔，从画布夹层取出一封信。",
        dialogue: [{ speaker: "林予", text: line }],
      },
    ],
  };
}

type Host = Awaited<ReturnType<typeof fixture>>["first"];
async function textService(host: Host, idPrefix: string) {
  const store = host.parent.projectTextStore();
  await store.migrate();
  let sequence = 0;
  return new ProjectTextApplicationService({
    store,
    projects: host.store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => timestamp },
    ids: { nextId: (kind) => `${idPrefix}-${kind}-${++sequence}` },
    digester,
  });
}
const conflict = (error: unknown) =>
  error instanceof ApplicationError && error.category === "conflict";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend} text workflow: shared commands preserve manual edits, dependencies and history across reopen`,
    options,
    async (t: TestContext) => {
      const f = await fixture(t, backend);
      const projects = application(f.first.store, "workflow-project").service;
      const created = await projects.createProject(
        actor,
        command("workflow-project"),
      );
      const projectId = created.project.projectId;
      const producer = await textService(f.first, "producer");
      const editor = await textService(f.second, "editor");

      const initialOutlineCommand = {
        projectId,
        expectedArtifactRevision: 0,
        briefRevision: 1,
        content: outline,
        idempotencyKey: "three-episode-outline",
      };
      const initialOutline = await producer.saveOutlineCandidate(
        actor,
        initialOutlineCommand,
      );
      assert.equal(initialOutline.artifact.selectedContentRevision, null);
      assert.equal(
        (await editor.getOutline(actor, { projectId }))?.dependencyState,
        "unselected",
      );
      const selectedOutline = await editor.selectRevision(actor, {
        projectId,
        artifactId: initialOutline.artifact.artifactId,
        expectedArtifactRevision: initialOutline.artifact.revision,
        contentRevision: 1,
        idempotencyKey: "select-outline-1",
      });
      const scriptCommand = {
        projectId,
        episodeId: "episode-1",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: {
          artifactId: initialOutline.artifact.artifactId,
          contentRevision: 1,
        },
        content: script("是谁把信藏在这里？"),
        idempotencyKey: "episode-one-script",
      };
      const initialScript = await producer.saveScriptCandidate(
        actor,
        scriptCommand,
      );
      const selectedScript = await editor.selectRevision(actor, {
        projectId,
        artifactId: initialScript.artifact.artifactId,
        expectedArtifactRevision: initialScript.artifact.revision,
        contentRevision: 1,
        idempotencyKey: "select-script-1",
      });
      const editedScript = await editor.saveScriptCandidate(actor, {
        ...scriptCommand,
        expectedArtifactRevision: selectedScript.artifact.revision,
        content: script("这笔迹……是母亲的。"),
        idempotencyKey: "manual-dialogue-edit",
      });
      assert.equal(editedScript.artifact.selectedContentRevision, 1);
      const selectedEdit = await editor.selectRevision(actor, {
        projectId,
        artifactId: initialScript.artifact.artifactId,
        expectedArtifactRevision: editedScript.artifact.revision,
        contentRevision: 2,
        idempotencyKey: "select-manual-edit",
      });

      await assert.rejects(
        producer.saveScriptCandidate(actor, {
          ...scriptCommand,
          expectedArtifactRevision: selectedScript.artifact.revision,
          content: script("较早执行产生的另一句对白。"),
          idempotencyKey: "late-outdated-result",
        }),
        conflict,
      );
      const exploration = await producer.saveScriptCandidate(actor, {
        ...scriptCommand,
        expectedArtifactRevision: selectedEdit.artifact.revision,
        content: script("另一个可比较的候选。"),
        idempotencyKey: "additional-exploration",
      });
      let view = await producer.getScript(actor, {
        projectId,
        episodeId: "episode-1",
      });
      assert.ok(view);
      assert.equal(view.dependencyState, "current");
      assert.equal(view.artifact.selectedContentRevision, 2);
      assert.deepEqual(
        view.selectedRevision?.content,
        script("这笔迹……是母亲的。"),
      );

      const changedOutline = await editor.saveOutlineCandidate(actor, {
        ...initialOutlineCommand,
        expectedArtifactRevision: selectedOutline.artifact.revision,
        content: {
          ...outline,
          synopsis: "新版本将第一封信改为旧友留下的线索。",
        },
        idempotencyKey: "outline-exploration",
      });
      assert.equal(
        (await producer.getScript(actor, { projectId, episodeId: "episode-1" }))
          ?.dependencyState,
        "current",
      );
      await editor.selectRevision(actor, {
        projectId,
        artifactId: changedOutline.artifact.artifactId,
        expectedArtifactRevision: changedOutline.artifact.revision,
        contentRevision: 2,
        idempotencyKey: "select-outline-2",
      });
      view = await producer.getScript(actor, {
        projectId,
        episodeId: "episode-1",
      });
      assert.ok(view);
      assert.equal(view.dependencyState, "stale");
      assert.deepEqual(view.staleReasons, ["outline-selection-changed"]);
      assert.equal(view.artifact.selectedContentRevision, 2);

      const locked = await editor.setLocked(actor, {
        projectId,
        artifactId: initialScript.artifact.artifactId,
        expectedArtifactRevision: exploration.artifact.revision,
        locked: true,
        idempotencyKey: "lock-edited-script",
      });
      await assert.rejects(
        producer.selectRevision(actor, {
          projectId,
          artifactId: initialScript.artifact.artifactId,
          expectedArtifactRevision: locked.artifact.revision,
          contentRevision: 1,
          idempotencyKey: "overwrite-locked-selection",
        }),
        conflict,
      );
      const projectBeforeBrief = await projects.getProject(actor, {
        projectId,
      });
      assert.equal(
        projectBeforeBrief.revision,
        created.project.revision,
        "text revisions must not rewrite the original project protocol",
      );
      await projects.appendBrief(actor, {
        projectId,
        text: "新增创作要求：家人最终团聚。",
        expectedProjectRevision: projectBeforeBrief.revision,
        idempotencyKey: "new-brief",
      });
      view = await producer.getScript(actor, {
        projectId,
        episodeId: "episode-1",
      });
      assert.ok(view);
      assert.equal(view.artifact.locked, true);
      assert.deepEqual(
        new Set(view.staleReasons),
        new Set(["brief-changed", "outline-selection-changed"]),
      );
      const remembered = view;

      await f.first.parent.close();
      await f.second.parent.close();
      const reopened = await f.open();
      const recovered = await textService(reopened, "reopened");
      assert.deepEqual(
        await recovered.getScript(actor, { projectId, episodeId: "episode-1" }),
        remembered,
      );
      const history = await recovered.listRevisions(actor, {
        projectId,
        artifactId: initialScript.artifact.artifactId,
        afterContentRevision: 0,
        limit: 16,
      });
      assert.deepEqual(
        history.revisions.map((revision) => revision.contentRevision),
        [1, 2, 3],
      );
      assert.deepEqual(
        history.revisions[1]?.content,
        script("这笔迹……是母亲的。"),
      );
      const replay = await recovered.saveOutlineCandidate(
        actor,
        initialOutlineCommand,
      );
      assert.equal(replay.disposition, "replayed");
      assert.deepEqual(replay.artifact, initialOutline.artifact);
      assert.equal(
        (await recovered.getOutline(actor, { projectId }))?.artifact
          .latestContentRevision,
        2,
      );
      assert.equal(
        await f.count("creative_project_mutation_receipts"),
        2,
        "text mutations have an independent receipt ledger",
      );
    },
  );

  test(
    `${backend} text workflow: an imported script remains usable without an invented outline`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const projects = application(f.first.store, "import-project").service;
      const created = await projects.createProject(
        actor,
        command("import-project"),
      );
      const projectId = created.project.projectId;
      const service = await textService(f.first, "import");
      const imported = await service.saveScriptCandidate(actor, {
        projectId,
        episodeId: "existing-episode",
        expectedArtifactRevision: 0,
        briefRevision: 1,
        outline: null,
        content: script("用户已有剧本里的对白。"),
        idempotencyKey: "import-script",
      });
      assert.equal(imported.contentRevision?.outline, null);
      assert.equal(await service.getOutline(actor, { projectId }), null);
      await service.selectRevision(actor, {
        projectId,
        artifactId: imported.artifact.artifactId,
        expectedArtifactRevision: imported.artifact.revision,
        contentRevision: 1,
        idempotencyKey: "select-import",
      });
      const view = await service.getScript(actor, {
        projectId,
        episodeId: "existing-episode",
      });
      assert.ok(view);
      assert.equal(view.dependencyState, "current");
      assert.deepEqual(view.staleReasons, []);
    },
  );

  test(
    `${backend} text workflow: concurrent same command returns one durable identity to both callers`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      const created = await application(
        f.first.store,
        "concurrent-project",
      ).service.createProject(actor, command("concurrent-project"));
      const first = await textService(f.first, "first");
      const second = await textService(f.second, "second");
      const save = {
        projectId: created.project.projectId,
        briefRevision: 1,
        expectedArtifactRevision: 0,
        content: outline,
        idempotencyKey: "shared-command",
      };
      const results = await Promise.all([
        first.saveOutlineCandidate(actor, save),
        second.saveOutlineCandidate(actor, save),
      ]);
      assert.deepEqual(
        new Set(results.map((result) => result.disposition)),
        new Set(["committed", "replayed"]),
      );
      assert.deepEqual(results[0]!.artifact, results[1]!.artifact);
      assert.deepEqual(
        results[0]!.contentRevision,
        results[1]!.contentRevision,
      );
      assert.equal(await f.count("project_text_artifacts"), 1);
      assert.equal(await f.count("project_text_revisions"), 1);
      assert.equal(await f.count("project_text_mutation_receipts"), 1);
    },
  );
}
