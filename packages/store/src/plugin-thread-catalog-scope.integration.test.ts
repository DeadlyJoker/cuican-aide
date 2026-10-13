import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture } from "./project-conversation-ui-owned.test-support.ts";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { createThreadCommitFixture } from "./thread-store-conformance.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: plugin conversation remains in its project and out of ordinary catalog, including revoked ownership`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        "matching",
        "available",
        "fixture",
        { backend },
      );
      f.state.afterThreadPrepared = async () => {
        const rows = await f.parent.listThreads({
          tenantId: f.actor.tenantId,
          spaceId: f.actor.spaceId,
          before: null,
          limit: 100,
        });
        assert.ok(
          rows.every((row) => row.workspaceId !== "workspace-isolated"),
        );
      };
      const created = (await f.invoke(
        actions.createConversation,
        f.createInput,
      )) as {
        binding: { threadId: string; revision: number; workspaceId: string };
      };
      const ordinaryId = "ordinary-catalog-thread";
      const commit = createThreadCommitFixture({
        threadId: ordinaryId,
        occurredAt: "2026-10-13T12:00:00.000Z",
      });
      const first = commit.events[0]!;
      assert.equal(first.type, "thread.created");
      if (first.type !== "thread.created") throw new Error("fixture");
      await f.parent.commitThread({
        ...commit,
        tenantId: f.actor.tenantId,
        events: [
          {
            ...first,
            data: {
              ...first.data,
              spaceId: f.actor.spaceId,
              createdByActorId: f.actor.actorId,
              tenantId: f.actor.tenantId,
            },
          },
        ],
      });
      const query = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        before: null,
        limit: 1,
      };
      assert.deepEqual(
        (await f.parent.listThreads(query)).map((x) => x.threadId),
        [ordinaryId],
      );
      assert.deepEqual(
        (await f.second.parent.listThreads(query)).map((x) => x.threadId),
        [ordinaryId],
      );
      assert.equal(
        (
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: created.binding.threadId,
          })
        )?.workspaceId,
        created.binding.workspaceId,
      );
      const all = await f.parent.listThreads({ ...query, limit: 100 });
      assert.ok(all.some((row) => row.threadId === ordinaryId));
      assert.ok(all.every((row) => row.threadId !== created.binding.threadId));
      const older = await f.parent.listThreads({
        ...query,
        before: { updatedAt: all[0]!.updatedAt, threadId: all[0]!.threadId },
        limit: 100,
      });
      assert.ok(
        older.every((row) => row.threadId !== created.binding.threadId),
      );
      const projectPage = (await f.invoke(actions.listConversations, {
        projectId: f.createInput.projectId,
        afterThreadId: null,
        limit: 16,
      })) as { bindings: { threadId: string }[] };
      assert.deepEqual(
        projectPage.bindings.map((x) => x.threadId),
        [created.binding.threadId],
      );
      await f.invoke(actions.setState, {
        projectId: f.createInput.projectId,
        threadId: created.binding.threadId,
        expectedBindingRevision: created.binding.revision,
        state: "revoked",
        idempotencyKey: "catalog-revoke",
      });
      assert.deepEqual(
        (await f.parent.listThreads(query)).map((x) => x.threadId),
        [ordinaryId],
      );
      assert.ok(
        (await f.parent.listThreads({ ...query, limit: 100 })).every(
          (row) => row.threadId !== created.binding.threadId,
        ),
      );
    },
  );
}

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: legacy project conversation without a plugin workspace stays private to its project`,
    {
      skip:
        backend === "postgres" &&
        process.env.CREWON_TEST_POSTGRES_URL === undefined,
    },
    async (t) => {
      const f = await conversationFixture(t, backend);
      const prepared = await f.prepare("00000000-0000-4000-8000-000000000001", null);
      await f.store.commitBinding(prepared, { authority: f.authority });
      const rows = await f.parent.listThreads({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        before: null,
        limit: 100,
      });
      assert.ok(
        rows.every((row) => row.threadId !== prepared.binding.threadId),
      );
      assert.equal(
        (
          await f.store.loadBinding({
            ...f.owner,
            threadId: prepared.binding.threadId,
          })
        )?.threadId,
        prepared.binding.threadId,
      );
    },
  );
}
