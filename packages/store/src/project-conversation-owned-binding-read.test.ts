import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions } from "@crewon/contracts/project-conversations";
import { ownedConversationUiFixture } from "./project-conversation-ui-owned.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: genuine owned UI reads the original binding and retains independent policy without another Thread or Run`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
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
      const ids = f.state.idCount;
      const threads = f.state.threadPreparations;
      assert.deepEqual(
        await f.invoke(actions.getBinding, {
          threadId: created.binding.threadId,
        }),
        { binding: created.binding },
      );
      assert.deepEqual(
        await f.invoke(actions.getBinding, { threadId: "missing-binding" }),
        { binding: null },
      );
      assert.equal(f.state.idCount, ids);
      assert.equal(f.state.threadPreparations, threads);
      assert.equal(f.state.taskCount, 0);
      assert.ok(f.state.context);
      await assert.rejects(
        f.app.metadataFromPluginUi({ ...f.state.context }, f.authority),
        /unavailable/,
      );
      f.state.afterThreadRead = () => {
        f.state.policyAllowed = false;
      };
      await assert.rejects(
        f.invoke(actions.getBinding, { threadId: created.binding.threadId }),
        /creative_project_access_denied/,
      );
      f.state.afterThreadRead = null;
      f.state.policyAllowed = false;
      await assert.rejects(
        f.invoke(actions.getBinding, { threadId: created.binding.threadId }),
        /creative_project_access_denied/,
      );
      f.state.policyAllowed = true;
      f.state.uiAllowed = false;
      await assert.rejects(
        f.invoke(actions.getBinding, { threadId: created.binding.threadId }),
        /plugin_ui_authorization_denied/,
      );
      assert.equal(f.state.idCount, ids);
      assert.equal(f.state.threadPreparations, threads);
      assert.equal(f.state.taskCount, 0);
    },
  );
