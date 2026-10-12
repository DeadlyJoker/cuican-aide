import assert from "node:assert/strict";
import test from "node:test";
import { ownedConversationUiFixture } from "./project-conversation-ui-owned.test-support.ts";
const action = "crewon.project-workspace-target.v1.resolveTarget";
for (const mismatch of [
  "matching",
  "actorId",
  "profileId",
  "pluginId",
  "publisherId",
] as const)
  test(`original SQLite workspace discovery ${mismatch} owner is checked before returning a target`, async (t) => {
    const f = await ownedConversationUiFixture(
      t,
      mismatch,
      "available",
      "nativeIdentity",
      { namespace: "deferred" },
    );
    const input = { projectId: f.reference.projectId };
    if (mismatch !== "matching") {
      await assert.rejects(f.invoke(action, input));
      return;
    }
    const result = await f.invoke(action, input);
    assert.deepEqual(result, {
      projectId: input.projectId,
      workspaceId: f.createInput.workspaceId,
    });
    assert.equal(f.state.threadPreparations, 0);
    assert.equal(f.state.idCount, 0);
    assert.equal(f.state.taskCount, 0);
    assert.ok(f.state.context);
    await assert.rejects(
      f.app.resolveWorkspaceTargetFromPluginUi(
        { ...f.state.context },
        f.authority,
      ),
    );
    f.state.afterHostTransactionCurrent = () => {
      f.state.policyAllowed = false;
    };
    await assert.rejects(f.invoke(action, input));
    f.state.afterHostTransactionCurrent = null;
    f.state.policyAllowed = true;
    f.state.uiAllowed = false;
    await assert.rejects(f.invoke(action, input));
  });
