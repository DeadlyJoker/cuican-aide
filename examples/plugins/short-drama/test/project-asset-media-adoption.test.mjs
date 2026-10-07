import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assetControllerFixture,
  open,
  draft,
  settle,
  details,
  copy,
} from "./asset-controller.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
const digest = "sha256:" + "b".repeat(64);
export const candidate = {
  projectId: "project-a",
  candidateId: "result-" + "a".repeat(64),
  runId: "run-a",
  resultIndex: 1,
  executionId: "execution-a",
  mediaInputId: "input-a",
  inputRevision: 1,
  workflowId: "krea2-reference-four-view",
  item: { kind: "character-reference", assetId: "asset-a" },
  contentDigest: digest,
  media: {
    type: "image/png",
    byteDigest: digest,
    byteLength: 64,
    width: 512,
    height: 512,
    observedAt: "2026-10-07T00:00:00.000Z",
  },
};
async function prepared() {
  const f = assetControllerFixture(),
    c = await open(f);
  draft(c);
  await c.save();
  await c.selectContent();
  await c.attachReference({
    conceptAssetId: "concept-original",
    selectionRevision: 1,
  });
  await c.selectReference(1);
  return { f, c };
}
test("review is read-only; explicit adoption uses the exact result and immutable version before ACK", async () => {
  const { f, c } = await prepared();
  try {
    const writes = f.receipts.size;
    await c.reviewMediaReference(candidate);
    assert.equal(f.receipts.size, writes);
    assert.equal(c.canAdoptMediaReference(candidate), true);
    await c.adoptMediaReference(candidate);
    const command = f.calls.find(([m]) => m === "adoptMediaReference")[1];
    assert.deepEqual(
      { ...command, idempotencyKey: "key" },
      {
        projectId: "project-a",
        assetId: "asset-a",
        expectedAssetRevision: 4,
        assetContentRevision: 1,
        runId: "run-a",
        resultIndex: 1,
        candidateId: candidate.candidateId,
        candidateDigest: digest,
        idempotencyKey: "key",
      },
    );
    assert.equal(f.acknowledges, 5);
    assert.equal(
      c.getSnapshot().view.selectedReferenceRevision.source.candidateId,
      candidate.candidateId,
    );
    assert.equal(c.getSnapshot().view.asset.selectedReferenceRevision, 2);
    assert.equal(c.canEdit, true);
  } finally {
    c.dispose();
  }
});
test("foreign projects, other assets, storyboard outputs, locked targets and dirty drafts cannot adopt", async () => {
  const { f, c } = await prepared();
  try {
    const invalid = [
      { ...candidate, projectId: "project-b" },
      { ...candidate, item: { ...candidate.item, assetId: "asset-b" } },
      {
        ...candidate,
        workflowId: "flux2-three-reference-storyboard",
        item: { kind: "storyboard-exploration", scriptArtifactId: "script-a" },
      },
    ];
    for (const value of invalid) {
      assert.equal(c.canAdoptMediaReference(value), false);
      await c.adoptMediaReference(value);
    }
    await c.setLocked();
    await c.adoptMediaReference(candidate);
    await c.setLocked();
    c.setDraft({ ...c.getSnapshot().draft.content, name: "未保存" });
    await c.adoptMediaReference(candidate);
    assert.equal(
      f.calls.some(([m]) => m === "adoptMediaReference"),
      false,
    );
  } finally {
    c.dispose();
  }
});
for (const where of ["before", "after"])
  test(`cold adoption ${where} reply loss never automatically replays or clears the original record`, async () => {
    const { f, c: initial } = await prepared();
    let c = initial;
    try {
      f.loss(where);
      await c.adoptMediaReference(candidate);
      const original = copy(f.record.request);
      c.dispose();
      c = await open(f);
      await c.restoreRecovery();
      assert.equal(
        f.calls.filter(([m]) => m === "adoptMediaReference").length,
        1,
      );
      assert.equal(f.acknowledges, 4);
      if (where === "before") {
        await c.retry();
        assert.deepEqual(
          f.calls.filter(([m]) => m === "adoptMediaReference")[1][1],
          original.input,
        );
      } else {
        await c.acknowledgeRecovery();
      }
      assert.equal(f.references.size, 2);
      assert.equal(c.canEdit, true);
    } finally {
      c.dispose();
    }
  });
test("cancellation requires review, retains a cancelled record, and never retries the business write", async () => {
  const { f, c } = await prepared();
  try {
    f.loss("before");
    await c.adoptMediaReference(candidate);
    await c.cancelPendingRecovery();
    assert.equal(f.record.phase, "pending");
    await c.restoreRecovery();
    await c.cancelPendingRecovery();
    assert.equal(f.record.phase, "cancelled");
    assert.equal(c.canEdit, false);
    await c.retry();
    assert.equal(
      f.calls.filter(([m]) => m === "adoptMediaReference").length,
      1,
    );
    await c.acknowledgeRecovery();
    assert.equal(c.canEdit, true);
    assert.equal(f.references.size, 1);
  } finally {
    c.dispose();
  }
});
test("commit winning the cancellation race is displayed as accepted and retains its reference", async () => {
  const { f, c } = await prepared();
  try {
    f.loss("before");
    await c.adoptMediaReference(candidate);
    await c.restoreRecovery();
    await f.client.adoptMediaReference(f.record.request.input);
    await c.cancelPendingRecovery();
    assert.equal(c.recovery.getSnapshot().intent.phase, "accepted");
    assert.equal(
      c.getSnapshot().references[0].source.candidateId,
      candidate.candidateId,
    );
    assert.equal(f.acknowledges, 4);
    await c.acknowledgeRecovery();
    assert.equal(c.canEdit, true);
  } finally {
    c.dispose();
  }
});
test("withdrawn cancellation cannot clear or acknowledge a journal after reconnect", async () => {
  const { f, c } = await prepared(),
    gate = deferred();
  try {
    f.loss("before");
    await c.adoptMediaReference(candidate);
    await c.restoreRecovery();
    const cancel = f.recovery.cancelPending;
    f.recovery.cancelPending = async (...args) => {
      await gate.promise;
      return cancel(...args);
    };
    const task = c.cancelPendingRecovery();
    await settle();
    await c.retry();
    assert.equal(
      f.calls.filter(([m]) => m === "adoptMediaReference").length,
      1,
    );
    c.setReady(false);
    gate.resolve();
    await task;
    assert.equal(c.recovery.getSnapshot().phase, "waiting");
    c.setReady(true);
    await settle();
    await c.restoreRecovery();
    assert.equal(c.recovery.getSnapshot().intent.phase, "cancelled");
    assert.equal(f.acknowledges, 4);
  } finally {
    gate.resolve();
    c.dispose();
  }
});
test("target review ignores a late read after project switch", async () => {
  const { f, c } = await prepared(),
    gate = deferred();
  try {
    const list = f.client.listAssets;
    f.client.listAssets = async (...args) => {
      await gate.promise;
      return list(...args);
    };
    const task = c.reviewMediaReference(candidate);
    await settle();
    const other = details();
    c.setProject({
      ...other,
      project: { ...other.project, projectId: "project-b" },
    });
    gate.resolve();
    await task;
    await settle();
    assert.equal(c.getSnapshot().projectId, "project-b");
    assert.equal(c.getSnapshot().view, null);
  } finally {
    gate.resolve();
    c.dispose();
  }
});
