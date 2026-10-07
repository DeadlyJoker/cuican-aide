import assert from "node:assert/strict";
import test from "node:test";
import { nativeMediaFlowFixture } from "./desktop-native-project-media-flow.test-support.ts";

test(
  "Native concept generation uses the original project-bound conversation and keeps its workspace",
  { timeout: 30000 },
  async (t) => {
    const f = await nativeMediaFlowFixture(t, { conceptConversation: true });
    const binding = await f.parent.projectConversationStore().loadBinding({
      actor: f.actor,
      profileId: f.scope.profileId,
      threadId: f.sourceThreadId,
    });
    assert.equal(binding?.projectId, f.query.projectId);
    assert.equal(binding?.workspaceId, "native-existing-workspace");
    const generation = await f.parent.extensionStore().loadExtensionRunBinding({
      ...f.actor,
      runId: f.sourceRunId,
    });
    assert.equal(generation?.threadId, f.sourceThreadId);
  },
);
