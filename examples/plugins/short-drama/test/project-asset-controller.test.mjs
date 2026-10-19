import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  assetControllerFixture as fixture,
  copy,
  content,
  details,
  open,
  draft,
  acknowledge,
  settle,
} from "./asset-controller.test-support.mjs";

test("the new asset phase stays dormant until explicit exploration; activation and reconnect only read", async () => {
  const f = fixture(),
    c = f.create();
  try {
    c.setProject(details());
    c.setReady(true);
    await settle();
    assert.equal(f.calls.length, 0);
    c.activate();
    await settle();
    assert.equal(c.canEdit, true);
    c.setReady(false);
    c.setReady(true);
    await settle();
    assert.ok(f.calls.every(([m]) => ["getPending", "listAssets"].includes(m)));
  } finally {
    c.dispose();
  }
});

test("returning to an asset page rechecks another workbench's completed journal without repeating its write", async () => {
  const f = fixture(),
    owner = await open(f);
  let other;
  try {
    draft(owner, "scene");
    f.loss("before");
    await owner.save();
    other = await open(f);
    assert.equal(other.locked, true);
    await owner.retry();
    assert.equal(f.record, null);
    const writes = f.calls.filter(
      ([method]) => method === "saveCandidate",
    ).length;
    other.activate();
    await settle();
    assert.equal(other.locked, false);
    assert.equal(other.canEdit, true);
    assert.equal(other.getSnapshot().assets[0].assetId, "asset-a");
    assert.equal(
      f.calls.filter(([method]) => method === "saveCandidate").length,
      writes,
    );
  } finally {
    other?.dispose();
    owner.dispose();
  }
});

test("returning to an asset page preserves unsaved edits and its own unresolved request", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    const draftBefore = copy(c.getSnapshot().draft);
    const reads = f.calls.length;
    c.activate();
    await settle();
    assert.equal(f.calls.length, reads);
    assert.deepEqual(c.getSnapshot().draft, draftBefore);
    f.loss("before");
    await c.save();
    const pending = copy(c.getSnapshot().pending);
    c.activate();
    await settle();
    assert.deepEqual(c.getSnapshot().pending, pending);
    assert.equal(
      f.calls.filter(([method]) => method === "saveCandidate").length,
      1,
    );
    assert.equal(c.canEdit, false);
  } finally {
    c.dispose();
  }
});

test("returning observes another workbench's adopted reference without replacing the displayed setting draft", async () => {
  const f = fixture(),
    owner = await open(f);
  let other;
  try {
    draft(owner, "scene");
    await owner.save();
    await owner.selectContent();
    await owner.attachReference({
      conceptAssetId: "concept-a",
      selectionRevision: 1,
    });
    other = await open(f);
    await other.open("asset-a");
    const originalDraft = copy(other.getSnapshot().draft);
    assert.equal(other.getSnapshot().view.selectedReferenceRevision, null);
    await owner.selectReference(1);
    const before = f.calls.length;
    other.activate();
    other.activate();
    await settle();
    assert.equal(
      other.getSnapshot().view.selectedReferenceRevision.referenceRevision,
      1,
    );
    assert.deepEqual(other.getSnapshot().draft, originalDraft);
    assert.equal(
      f.calls.slice(before).filter(([method]) => method === "getPending")
        .length,
      1,
    );
    assert.ok(
      f.calls
        .slice(before)
        .every(([method]) =>
          ["getPending", "listAssets", "getAsset"].includes(method),
        ),
    );
  } finally {
    other?.dispose();
    owner.dispose();
  }
});

test("warm candidates preserve content and do not select; exact immutable review clears the journal", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    await c.save();
    assert.equal(f.asset.selectedContentRevision, null);
    assert.deepEqual(f.revisions.get(1).content, content);
    assert.equal(f.acknowledges, 1);
    assert.equal(f.record, null);
    assert.ok(
      f.calls.some(([m, q]) => m === "getRevision" && q.contentRevision === 1),
    );
    await c.acknowledgeRecovery();
    assert.equal(f.acknowledges, 1);
    assert.equal(c.canEdit, true);
    await c.selectContent();
    assert.equal(f.asset.selectedContentRevision, 1);
    assert.deepEqual(f.calls.find(([m]) => m === "selectRevision")[1].request, {
      expectedAssetRevision: 1,
      contentRevision: 1,
    });
  } finally {
    c.dispose();
  }
});

for (const where of ["before", "after"])
  test(`cold ${where}-dispatch loss restores the exact original request without automatic execution`, async () => {
    const f = fixture();
    let c = await open(f);
    try {
      draft(c, "scene");
      f.loss(where);
      await c.save();
      const original = copy(f.calls.find(([m]) => m === "saveCandidate")[1]);
      c.dispose();
      c = await open(f);
      await c.restoreRecovery();
      assert.deepEqual(c.getSnapshot().draft.content, content);
      assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
      if (where === "before") {
        await c.retry();
        assert.deepEqual(
          f.calls.filter(([m]) => m === "saveCandidate")[1][1],
          original,
        );
        await acknowledge(c);
      } else {
        await c.retry();
        assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
        await c.acknowledgeRecovery();
      }
      assert.equal(f.revisions.size, 1);
      assert.equal(c.canEdit, true);
    } finally {
      c.dispose();
    }
  });

test("a changed brief cannot replace a pending request or mint a new key", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c, "prop");
    f.loss("before");
    await c.save();
    const original = copy(f.record.request.input);
    c.setProject(details(3, 2));
    await settle();
    await c.retry();
    assert.deepEqual(
      f.calls.filter(([m]) => m === "saveCandidate")[1][1],
      original,
    );
    assert.equal(f.revisions.get(1).brief.briefRevision, 1);
  } finally {
    c.dispose();
  }
});

test("withdrawal never projects a late write and physical activity blocks replacement editing", async () => {
  const f = fixture(),
    c = await open(f),
    gate = deferred();
  try {
    draft(c);
    f.hold(gate.promise);
    f.physical(true);
    await c.save();
    assert.equal(f.receipts.size, 0, "busy host blocks dispatch");
    f.physical(false);
    const writing = c.save();
    await settle();
    c.setReady(false);
    gate.resolve();
    await writing;
    assert.equal(c.getSnapshot().phase, "waiting");
    assert.equal(c.getSnapshot().view, null);
    assert.equal(f.revisions.size, 1);
    c.setReady(true);
    await settle();
    assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
    assert.equal(
      c.canEdit,
      false,
      "unresolved original record remains guarded",
    );
  } finally {
    gate.resolve();
    c.dispose();
  }
});

test("locked selected versions allow additional exploration but cannot be replaced", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    await c.save();
    await acknowledge(c);
    await c.selectContent();
    await acknowledge(c);
    await c.setLocked();
    await acknowledge(c);
    c.setDraft({ ...content, name: "新候选" });
    await c.save();
    await acknowledge(c);
    assert.equal(f.asset.selectedContentRevision, 1);
    assert.equal(f.revisions.size, 2);
    await c.selectContent();
    assert.equal(f.calls.filter(([m]) => m === "selectRevision").length, 1);
    await c.loadHistory();
    const before = f.calls.length;
    await c.loadHistory({ more: true });
    assert.equal(
      f.calls.length,
      before,
      "finished histories do not restart from zero",
    );
  } finally {
    c.dispose();
  }
});

test("confirmed writes with unavailable current reads retain the receipt; unknown recovery never permits a fresh write", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    f.failCurrent(true);
    await c.save();
    assert.equal(c.getSnapshot().pending, null);
    assert.equal(f.record.phase, "accepted");
    await c.restoreRecovery();
    await c.acknowledgeRecovery();
    assert.equal(f.acknowledges, 0);
    f.failCurrent(false);
    await acknowledge(c);
    f.failRecovery(true);
    await c.recovery.check();
    assert.equal(c.canEdit, false);
    const before = f.calls.length;
    draft(c);
    await c.save();
    assert.equal(f.calls.length, before);
  } finally {
    c.dispose();
  }
});
