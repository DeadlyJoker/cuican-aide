import assert from "node:assert/strict";
import test from "node:test";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { mediaGenerationControlFixture } from "./project-media-generation-control.test-support.ts";
import { projectMediaGenerationTaskInput } from "@crewon/application";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const kind of ["T10", "D18"] as const)
    test(
      `${backend} ${kind}: real installed media admission binds original project, thread and workspace`,
      assetTestOptions(backend),
      async (t) => {
        const f = await mediaGenerationControlFixture(t, backend, kind);
        const before = await f.countRuns();
        const accepted = await f.generate();
        assert.equal(accepted.run.disposition, "committed");
        assert.equal(accepted.binding.threadId, f.binding.threadId);
        const thread = await f.parent.loadThreadInSpace({
          ...f.actor,
          threadId: f.binding.threadId,
        });
        assert.equal(thread?.workspaceId, f.binding.workspaceId);
        const counts = await f.countRuns(),
          io = [f.state.sourceGets, f.state.uploads, f.state.targetGets];
        assert.equal(counts.run_snapshots, before.run_snapshots! + 1);
        const replay = await f.generate();
        assert.equal(replay.run.disposition, "replayed");
        assert.deepEqual(replay.binding, accepted.binding);
        assert.deepEqual(await f.countRuns(), counts);
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
        await assert.rejects(
          f.generate({ ...f.command, expectedThreadRevision: 2 }),
          /conflict/u,
        );
        assert.deepEqual(
          [f.state.sourceGets, f.state.uploads, f.state.targetGets],
          io,
        );
      },
    );
  test(
    `${backend}: wrong project and ordinary thread fail before media I/O`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationControlFixture(t, backend);
      const before = await f.countRuns();
      for (const change of [
        { projectId: "another-project" },
        { threadId: "media-task-thread" },
      ])
        await assert.rejects(
          f.generate({ ...f.command, ...change }),
          /project_media_generation_scope_changed/u,
        );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        [0, 0, 0],
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: withdrawn binding or installation permission cannot prepare materials`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationControlFixture(t, backend);
      const before = await f.countRuns();
      f.controlState.packageAllowed = false;
      await assert.rejects(
        f.generate(),
        /project_media_generation_scope_changed/u,
      );
      f.controlState.packageAllowed = true;
      await f.revoke();
      await assert.rejects(
        f.generate(),
        /project_media_generation_scope_changed/u,
      );
      assert.deepEqual(
        [f.state.sourceGets, f.state.uploads, f.state.targetGets],
        [0, 0, 0],
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: binding changes during preparation prevent Run admission`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationControlFixture(t, backend);
      const before = await f.countRuns();
      let revoked = false;
      f.state.onGet = async () => {
        if (!revoked) {
          revoked = true;
          await f.revoke();
        }
      };
      await assert.rejects(
        f.generate(),
        /project_media_generation_scope_changed/u,
      );
      assert.ok(revoked);
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: original transaction independently rejects an unqualified or withdrawn project binding`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationControlFixture(t, backend);
      const {
        projectId,
        mediaInputId,
        inputRevision,
        expectedInputRevision,
        executionId,
      } = f.command;
      const task = await f.issuer.prepareTask(
        f.actor,
        {
          projectId,
          mediaInputId,
          inputRevision,
          expectedInputRevision,
          executionId,
        },
        f.signal(),
      );
      const q = await f.run(() =>
        f.admissions.resolve({
          actor: f.actor,
          command: f.command,
          previous: null,
          signal: f.requests.currentSignal(),
        }),
      );
      assert.ok(q.conversation);
      const originalCommand = {
        ...f.taskCommand(task),
        threadId: f.command.threadId,
        idempotencyKey: f.command.idempotencyKey,
        intent: {
          kind: "generate" as const,
          input: projectMediaGenerationTaskInput(task.reference),
        },
      };
      const create = (qualified: typeof task) =>
        f.run(() =>
          f.core.extensionTasks.createProjectMediaTaskFromHost({
            actor: f.actor,
            pin: q.pin,
            task: qualified,
            command: originalCommand,
          }),
        );
      const before = await f.countRuns();
      await assert.rejects(create(task), (error) => {
        assert.ok(error instanceof Error && error.cause instanceof Error);
        assert.equal(error.cause.message, "project_stage_admission_required");
        return true;
      });
      await f.revoke();
      // Deliberately omit the Control callbacks: the actual SQL transaction must
      // reject the stale binding even when the independent fixture PDP still allows.
      await assert.rejects(
        create({
          ...task,
          authority: { ...task.authority, conversation: q.conversation },
        }),
        /project_media_generation_conversation_changed/u,
      );
      assert.deepEqual(await f.countRuns(), before);
    },
  );
  test(
    `${backend}: concurrent page and Agent commands admit one original project Run`,
    assetTestOptions(backend),
    async (t) => {
      const f = await mediaGenerationControlFixture(t, backend);
      const before = await f.countRuns();
      const [a, b] = await Promise.all([f.generate(), f.generate()]);
      assert.equal(a.binding.runId, b.binding.runId);
      assert.deepEqual([a.run.disposition, b.run.disposition].sort(), [
        "committed",
        "replayed",
      ]);
      assert.equal(
        (await f.countRuns()).run_snapshots,
        before.run_snapshots! + 1,
      );
      assert.equal(f.state.uploads, 1);
    },
  );
}
