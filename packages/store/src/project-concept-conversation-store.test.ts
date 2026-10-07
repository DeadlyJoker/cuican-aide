import assert from "node:assert/strict";
import test from "node:test";
import { publicationFixture } from "./project-generation-publication.test-support.ts";
import { projectQueryFixture } from "./project-query.test-support.ts";
import { projectHistoricalQueryFixture } from "./project-historical-query.test-support.ts";
import { bindConceptThread } from "./project-concept-conversation.test-support.ts";
import { activeAuthority } from "./project-generation.test-support.ts";
import { creationRecipe } from "./creative-project-store.test-support.ts";
import { selectionRecipe } from "./plugin-installation-store.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

function cause(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    (error.message === code || cause(code)(error.cause));
}
for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15000,
  };
  test(
    `${backend}: published concept stays in its project conversation; replay after revocation creates no new task`,
    options,
    async (t) => {
      const f = await publicationFixture(t, backend, { maxPoolSize: 1 });
      const c = await bindConceptThread(f, f.inputValue);
      const saved = await f.commit();
      assert.equal(saved.turn.threadState.threadId, c.binding.threadId);
      assert.equal(
        saved.turn.threadState.workspaceId ?? null,
        c.binding.workspaceId,
      );
      assert.equal(
        (await f.first.store.loadProjectGenerationLink(saved.binding))
          ?.projectId,
        c.binding.projectId,
      );
      const counts = await f.counts();
      await c.revoke();
      const replay = await f.commit();
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, saved.binding);
      assert.deepEqual(await f.counts(), counts);
    },
  );
  test(
    `${backend}: bound concept requires actual publication and refuses another project without writes`,
    options,
    async (t) => {
      const f = await publicationFixture(t, backend);
      await bindConceptThread(f, f.inputValue);
      const counts = await f.counts();
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.inputValue, activeAuthority),
        cause("project_stage_admission_required"),
      );
      assert.deepEqual(await f.counts(), counts);
      const other = await publicationFixture(t, backend);
      await other.metadata.commitProjectCreation(
        creationRecipe("other-project", "other-create", other.actor, timestamp),
      );
      await bindConceptThread(other, other.inputValue, "other-project");
      const before = await other.counts();
      await assert.rejects(
        other.commit(),
        cause("project_concept_conversation_mismatch"),
      );
      assert.deepEqual(await other.counts(), before);
    },
  );
  test(
    `${backend}: revoked or stale conversation cannot admit a new concept despite an otherwise valid publication`,
    options,
    async (t) => {
      const f = await publicationFixture(t, backend),
        c = await bindConceptThread(f, f.inputValue);
      const counts = await f.counts();
      await c.revoke();
      await assert.rejects(
        f.commit(),
        cause("project_concept_conversation_source_changed"),
      );
      assert.deepEqual(await f.counts(), counts);
      const stale = await publicationFixture(t, backend);
      await bindConceptThread(stale, stale.inputValue);
      const disabled = await stale.selection("source", "disabled");
      const enabled = await stale.installs.commitSelection(
        selectionRecipe(disabled.selection, "source-reenabled", {
          actor: stale.actor,
        }),
      );
      await assert.rejects(
        stale.first.store.commitExtensionTurn(stale.inputValue, {
          ...stale.commitOptions,
          projectGenerationPublication: {
            ...stale.commitOptions.projectGenerationPublication,
            sourcePin: {
              ...stale.sourcePin,
              selectionRevision: enabled.selection.revision,
            },
          },
        }),
        cause("project_concept_conversation_source_changed"),
      );
      assert.equal(await stale.count("run_snapshots"), 0);
    },
  );
  for (const kind of ["query", "historical"] as const) {
    test(
      `${backend}: ${kind} concept observation uses the bound project and current source, preserving old generation`,
      options,
      async (t) => {
        const f =
          kind === "query"
            ? await projectQueryFixture(t, backend)
            : await projectHistoricalQueryFixture(t, backend);
        const input = await f.queryInput();
        const c = await bindConceptThread(f, input);
        const before = await f.first.store.loadProjectGenerationLink(
          f.generation.binding,
        );
        const saved = await f.first.store.commitExtensionTurn(
          input,
          f.commitOptions,
        );
        assert.equal(saved.turn.threadState.threadId, c.binding.threadId);
        assert.equal(saved.binding.source?.runId, f.generation.binding.runId);
        assert.deepEqual(
          await f.first.store.loadProjectGenerationLink(f.generation.binding),
          before,
        );
        const replay = await f.first.store.commitExtensionTurn(
          input,
          f.commitOptions,
        );
        assert.equal(replay.run.disposition, "replayed");
      },
    );
  }
}
