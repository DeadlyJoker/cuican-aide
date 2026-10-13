import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture } from "../../../packages/store/src/project-conversation-ui-owned.test-support.ts";
import { registerThreadCatalogRoute } from "./thread-catalog-route.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: ordinary HTTP catalog/search hides plugin conversations while project UI can reopen them`,
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
      const created = (await f.invoke(
        actions.createConversation,
        f.createInput,
      )) as { binding: { threadId: string } };
      const app = Fastify();
      t.after(() => app.close());
      registerThreadCatalogRoute(app, {
        threads: f.threads,
        identity: { resolveActor: async () => f.actor },
      });
      for (const query of ["", "?search=", "?status=archived", "?limit=1"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/thread-catalog${query}`,
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(
          (response.json().data as { threadId: string }[]).every(
            (row) => row.threadId !== created.binding.threadId,
          ),
        );
      }
      const title = (
        await f.threads.getThread(f.actor, created.binding.threadId)
      ).title;
      const searched = await app.inject({
        method: "GET",
        url: `/api/v1/thread-catalog?search=${encodeURIComponent(title ?? "")}`,
      });
      assert.equal(searched.statusCode, 200, searched.body);
      assert.ok(
        (searched.json().data as { threadId: string }[]).every(
          (row) => row.threadId !== created.binding.threadId,
        ),
      );
      const opened = (await f.invoke(actions.openConversation, {
        projectId: f.createInput.projectId,
        threadId: created.binding.threadId,
      })) as { binding: { threadId: string } };
      assert.equal(opened.binding.threadId, created.binding.threadId);
    },
  );
}
