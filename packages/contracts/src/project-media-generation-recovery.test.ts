import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectMediaGenerationRecoveryRequest,
  parseProjectMediaGenerationRecoveryResponse,
} from "./project-media-generation-recovery.ts";

test("media recovery selectors contain only project and original thread", () => {
  const selectors = { projectId: "项目/雨夜", threadId: "thread/one" };
  assert.deepEqual(
    parseProjectMediaGenerationRecoveryRequest(selectors),
    selectors,
  );
  assert.deepEqual(
    parseProjectMediaGenerationRecoveryResponse({ intent: null }),
    { intent: null },
  );
  for (const input of [
    null,
    [],
    {},
    { ...selectors, owner: "foreign" },
    { ...selectors, projectId: "" },
    { ...selectors, threadId: "x".repeat(2048) },
  ])
    assert.throws(() => parseProjectMediaGenerationRecoveryRequest(input));
  let invoked = false;
  assert.throws(() =>
    parseProjectMediaGenerationRecoveryRequest({
      projectId: selectors.projectId,
      get threadId() {
        invoked = true;
        return "thread";
      },
    }),
  );
  assert.equal(invoked, false);
});
