import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectMediaGenerationRecoveryRequest,
  parseProjectMediaGenerationRecoveryResponse,
} from "./project-media-generation-recovery.ts";

test("media refusal is terminal only for its exact reason and first dispatch", () => {
  const request = {
    action: "crewon.project-media-generations.v1.generate",
    input: {
      projectId: "project",
      mediaInputId: "input",
      inputRevision: 1,
      expectedInputRevision: 1,
      executionId: "execution",
      threadId: "thread",
      expectedThreadRevision: 1,
      idempotencyKey: "key",
    },
  };
  const intent = {
    sourcePin: {
      pluginId: "crewon.short-drama",
      publisherId: "crewon.examples",
      version: "28.0.0",
      packageDigest: "sha256:" + "a".repeat(64),
      selectionRevision: 1,
      contributionId: "workbench",
    },
    request,
    phase: "refused",
    revision: 3,
    dispatchMayHaveOccurred: true,
    dispatchAttemptCount: 1,
    receipt: null,
    retryable: false,
    reasonCode: "project_media_generation_not_admitted",
  };
  assert.equal(
    parseProjectMediaGenerationRecoveryResponse({ intent }).intent?.phase,
    "refused",
  );
  for (const patch of [
    { retryable: true },
    { dispatchAttemptCount: 2 },
    { receipt: {} },
    { reasonCode: "network_timeout" },
    { reasonCode: "concept_selection_revision_conflict" },
  ])
    assert.throws(() =>
      parseProjectMediaGenerationRecoveryResponse({
        intent: { ...intent, ...patch },
      }),
    );
});

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
