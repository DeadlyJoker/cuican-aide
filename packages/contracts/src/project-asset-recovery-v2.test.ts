import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_ASSET_RECOVERY_V2_ACTIONS as actions,
  parseProjectAssetRecoveryV2Request as request,
  parseProjectAssetRecoveryV2Response as response,
  parseProjectAssetRecoveryV2Intent as intent,
} from "./project-asset-recovery-v2.ts";
const digest = "sha256:" + "a".repeat(64);
const write = {
  action: "crewon.project-assets.v2.setLocked",
  input: {
    projectId: "project",
    assetId: "character",
    request: { expectedAssetRevision: 3, locked: true },
    idempotencyKey: "lock",
  },
};
const staged = {
  intentId: "asset-v2-" + "a".repeat(64),
  revision: 1,
  request: write,
  requestDigest: digest,
  phase: "pending",
  confirmed: null,
};
test("V2 recovery has bounded exact actions, distinct phases and project-free lookup", () => {
  const q = request({ action: actions.getPending, input: {} });
  assert.deepEqual(response(q, { intent: staged }), { intent: staged });
  assert.throws(() =>
    request({ action: actions.getPending, input: { projectId: "different" } }),
  );
  assert.throws(() =>
    request({ action: actions.getPending.replace("v2", "v1"), input: {} }),
  );
  assert.throws(() =>
    request({
      action: actions.acknowledge,
      input: { intentId: staged.intentId, expectedRevision: 1 },
    }),
  );
  assert.throws(() => intent({ ...staged, revision: 2 }));
  assert.throws(() =>
    intent({
      ...staged,
      request: {
        ...write,
        input: { ...write.input, extra: "a".repeat(25 * 1024) },
      },
    }),
  );
  const cancelled = { ...staged, phase: "cancelled", revision: 2 };
  const cancel = request({
    action: actions.cancelPending,
    input: { intentId: staged.intentId, expectedRevision: 1 },
  });
  assert.deepEqual(response(cancel, { intent: cancelled }), {
    intent: cancelled,
  });
  assert.throws(() => response(cancel, { intent: staged }));
  assert.throws(() => response(q, { intent: { ...cancelled, revision: 3 } }));
});
test("V2 acceptance is tied to original asset identity, revision and operation result shape", () => {
  const confirmed = {
    assetId: "character",
    assetRevision: 4,
    contentRevision: null,
    referenceRevision: null,
    resultDigest: digest,
  };
  const accepted = { ...staged, revision: 2, phase: "accepted", confirmed };
  assert.deepEqual(intent(accepted), accepted);
  for (const patch of [
    { assetId: "foreign" },
    { assetRevision: 5 },
    { contentRevision: 1 },
    { referenceRevision: 1 },
    { resultDigest: "invalid" },
  ])
    assert.throws(() =>
      intent({ ...accepted, confirmed: { ...confirmed, ...patch } }),
    );
  assert.throws(() => intent({ ...accepted, confirmed: null }));
  const q = request({
    action: actions.acknowledge,
    input: { intentId: staged.intentId, expectedRevision: 2 },
  });
  assert.deepEqual(
    response(q, {
      intentId: staged.intentId,
      revision: 3,
      disposition: "replayed",
    }),
    { intentId: staged.intentId, revision: 3, disposition: "replayed" },
  );
  assert.throws(() =>
    response(q, {
      intentId: staged.intentId,
      revision: 2,
      disposition: "acknowledged",
    }),
  );
});
