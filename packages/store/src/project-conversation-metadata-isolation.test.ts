import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ownedConversationSqlFixture as fixture } from "./project-conversation-owned.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: protected project uses the original Thread/binding/receipt transaction and keeps its owned workspace across replay and cold reads`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      const mount = await f.mounted();
      await mount.write();
      const input = await f.prepare(randomUUID(), "workspace-isolated");
      const result = await f.store.commitBinding(input, {
        authority: f.authority,
      });
      assert.equal(result.disposition, "committed");
      assert.equal(result.binding.workspaceId, "workspace-isolated");
      assert.equal(
        (await f.store.commitBinding(input, { authority: f.authority }))
          .disposition,
        "replayed",
      );
      const thread = await f.second.parent.loadThread({
        tenantId: f.actor.tenantId,
        threadId: input.binding.threadId,
      });
      assert.equal(thread?.workspaceId, "workspace-isolated");
      assert.deepEqual(
        await f.second.parent
          .projectConversationStore()
          .loadBinding({ ...f.owner, threadId: input.binding.threadId }),
        input.binding,
      );
      assert.equal(
        (
          await f.store.loadMutationReceipt({
            ...f.owner,
            receipt: input.receipt,
          })
        )?.binding.threadId,
        input.binding.threadId,
      );
    },
  );

  test(
    `${backend}: another metadata actor, profile, plugin or publisher cannot use the original Conversation writer even without a namespace`,
    options,
    async (t) => {
      for (const field of [
        "actorId",
        "profileId",
        "pluginId",
        "publisherId",
      ] as const) {
        const f = await fixture(t, backend, field);
        const input = await f.prepare();
        await assert.rejects(
          f.store.commitBinding(input, { authority: f.authority }),
          /plugin_project_workspace_metadata_owner_conflict/u,
        );
        assert.equal(
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: input.binding.threadId,
          }),
          null,
        );
        assert.equal(
          await f.store.loadMutationReceipt({
            ...f.owner,
            receipt: input.receipt,
          }),
          null,
        );
      }
    },
  );

  test(
    `${backend}: protected project cannot create a Thread before namespace registration or borrow a null workspace`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      for (const schema of ["absent", "present"] as const) {
        if (schema === "present")
          await f.parent.migratePluginProjectWorkspaceNamespaces();
        for (const workspace of [null, "workspace-ordinary"]) {
          const input = await f.prepare(randomUUID(), workspace);
          await assert.rejects(
            f.store.commitBinding(input, { authority: f.authority }),
            /plugin_project_workspace_scope_conflict/u,
          );
          assert.equal(
            await f.parent.loadThread({
              tenantId: f.actor.tenantId,
              threadId: input.binding.threadId,
            }),
            null,
          );
          assert.equal(
            await f.store.loadMutationReceipt({
              ...f.owner,
              receipt: input.receipt,
            }),
            null,
          );
        }
      }
    },
  );

  test(
    `${backend}: protected project namespace rejects a different workspace without persisting a Thread or receipt`,
    options,
    async (t) => {
      const f = await fixture(t, backend);
      await f.parent.migratePluginProjectWorkspaceNamespaces();
      await (await f.mounted()).write();
      const input = await f.prepare(randomUUID(), "workspace-other");
      await assert.rejects(
        f.store.commitBinding(input, { authority: f.authority }),
        /plugin_project_workspace_scope_conflict/u,
      );
      assert.equal(
        await f.parent.loadThread({
          tenantId: f.actor.tenantId,
          threadId: input.binding.threadId,
        }),
        null,
      );
      assert.equal(
        await f.store.loadMutationReceipt({
          ...f.owner,
          receipt: input.receipt,
        }),
        null,
      );
    },
  );
}
