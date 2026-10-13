import assert from "node:assert/strict";
import test from "node:test";
import { ownedConversationUiFixture } from "./project-conversation-ui-owned.test-support.ts";
import {
  seedOffice,
  officeDefinition,
  officeBinding,
  createOfficeThread,
} from "./office-thread-store.test-support.ts";
import { createThreadCommitFixture } from "./thread-store-conformance.test-support.ts";
for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: group chat remains in its Team, while expert work conversations stay in ordinary catalog`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await ownedConversationUiFixture(
        t,
        "matching",
        "available",
        "fixture",
        { backend },
      );
      const group = {
        ...officeDefinition,
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        createdByActorId: f.actor.actorId,
      };
      await seedOffice(f.parent, group);
      const binding = {
        ...officeBinding,
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        boundByActorId: f.actor.actorId,
      };
      await f.parent.commitThread(createOfficeThread(binding));
      const expert = createThreadCommitFixture({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        actorId: f.actor.actorId,
        threadId: "expert-work-thread",
      });
      await f.parent.commitThread(expert);
      const rows = await f.parent.listThreads({
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        before: null,
        limit: 100,
      });
      assert.ok(rows.every((row) => row.threadId !== binding.threadId));
      assert.ok(rows.some((row) => row.threadId === "expert-work-thread"));
      assert.equal(
        (await f.parent.loadOfficeThreadBinding(binding))?.threadId,
        binding.threadId,
      );
      assert.equal(
        (
          await f.parent.loadThread({
            tenantId: f.actor.tenantId,
            threadId: binding.threadId,
          })
        )?.threadId,
        binding.threadId,
      );
    },
  );
}
