import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mediaInputFixture,
  openMedia,
  settle,
  characterDraft,
} from "./media-input.test-support.mjs";
import { deferred } from "./persistent-ui.test-support.mjs";
test("media input activation and cold reopen only read; confirmed versions remain discoverable", async () => {
  const f = mediaInputFixture();
  let c = f.create();
  try {
    c.setReady(true);
    c.setProject(f.details);
    await settle();
    assert.equal(f.calls.length, 0);
    c.activate();
    await settle();
    characterDraft(c);
    await c.save();
    const id = c.getSnapshot().input.mediaInputId;
    c.dispose();
    c = await openMedia(f);
    assert.equal(c.getSnapshot().draft, null);
    assert.equal(c.getSnapshot().inputs[0].mediaInputId, id);
    await c.open(id);
    assert.match(c.getSnapshot().draft.prompt, /林予/);
    assert.equal(
      f.calls.filter((r) => r.action.endsWith("saveInput")).length,
      1,
    );
  } finally {
    c.dispose();
  }
});
test("manual T10 confirms exact adopted references without media execution", async () => {
  const f = mediaInputFixture(),
    c = await openMedia(f);
  try {
    characterDraft(c);
    assert.equal(c.canSave, true);
    await c.save();
    const input = f.calls.find((r) => r.action.endsWith("saveInput")).input;
    assert.deepEqual(input.references, {
      character: {
        projectId: f.projectId,
        assetId: "character-a",
        kind: "character",
        expectedAssetRevision: 4,
        contentRevision: 1,
        referenceRevision: 1,
      },
    });
    assert.equal(input.configurationRevision, 1);
    assert.equal(input.item.kind, "character-reference");
    assert.equal(c.getSnapshot().input.inputRevision, 1);
    assert.equal(c.locked, false);
    assert.ok(
      f.calls.every((r) =>
        r.action.startsWith("crewon.project-media-inputs.v1."),
      ),
    );
  } finally {
    c.dispose();
  }
});
test("invalid text and changed configuration never create a pending write or silently rebind an input", async () => {
  const f = mediaInputFixture(),
    c = await openMedia(f);
  try {
    characterDraft(c);
    c.setPrompt("\ud800");
    assert.equal(c.canSave, false);
    await c.save();
    assert.equal(c.getSnapshot().pending, null);
    c.setPrompt('"'.repeat(8192));
    assert.equal(c.canSave, false);
    assert.equal(f.records.size, 0);
    c.setPrompt("保留林予五官。");
    f.configuration(2);
    await c.refresh();
    assert.equal(c.canSave, false);
    assert.equal(c.getSnapshot().draft.configurationRevision, 1);
    c.useCurrentSources();
    assert.equal(c.canSave, true);
    await c.save();
    assert.equal(c.getSnapshot().input.configurationRevision, 2);
  } finally {
    c.dispose();
  }
});
test("D18 requires two different characters and an adopted script and freezes role order", async () => {
  const f = mediaInputFixture(),
    script = await f.addScript(),
    c = await openMedia(f);
  try {
    c.newInput("flux2-three-reference-storyboard");
    c.setPrompt("雨夜车站，林予与许晟相遇。");
    c.chooseReference("scene", "scene-a");
    c.chooseReference("characterOne", "character-a");
    c.chooseReference("characterTwo", "character-a");
    c.chooseScript(script);
    assert.equal(c.canSave, false);
    c.chooseReference("characterTwo", "character-b");
    assert.equal(c.canSave, true);
    await c.save();
    const r = c.getSnapshot().input;
    assert.equal(r.script.artifactId, script);
    assert.deepEqual(r.item, {
      kind: "storyboard-frame-exploration",
      episodeId: "episode-1",
    });
    assert.equal(r.references.characterOne.assetId, "character-a");
    assert.equal(r.references.characterTwo.assetId, "character-b");
  } finally {
    c.dispose();
  }
});
test("refresh never silently replaces confirmed source revisions when only the prompt is edited", async () => {
  const f = mediaInputFixture(),
    c = await openMedia(f);
  try {
    characterDraft(c);
    await c.save();
    const v = f.views.get("character-a");
    v.asset.revision = 6;
    v.asset.latestReferenceRevision = 2;
    v.asset.selectedReferenceRevision = 2;
    v.selectedReferenceRevision.referenceRevision = 2;
    await c.refresh();
    c.setPrompt("改变光线，保留人物。");
    assert.equal(c.canSave, false);
    assert.equal(
      c.getSnapshot().draft.references.character.referenceRevision,
      1,
    );
    c.useCurrentSources();
    assert.equal(c.canSave, true);
    await c.save();
    assert.equal(
      c.getSnapshot().input.references.character.referenceRevision,
      2,
    );
    assert.equal(c.getSnapshot().input.inputRevision, 2);
  } finally {
    c.dispose();
  }
});
for (const where of ["before", "after"])
  test(`uncertain ${where} save retains exact command and key; explicit retry confirms original input`, async () => {
    const f = mediaInputFixture(),
      c = await openMedia(f);
    try {
      characterDraft(c);
      f.loss(where);
      await c.save();
      const original = c.getSnapshot().pending;
      assert.ok(original);
      c.newInput("flux2-three-reference-storyboard");
      assert.equal(c.getSnapshot().pending, original);
      c.setReady(false);
      c.setReady(true);
      await settle();
      assert.equal(
        f.calls.filter((r) => r.action.endsWith("saveInput")).length,
        1,
      );
      await c.retry();
      await settle();
      const requests = f.calls.filter((r) => r.action.endsWith("saveInput"));
      assert.deepEqual(requests[0], requests[1]);
      assert.equal(f.records.size, 1);
      assert.equal(c.getSnapshot().input.inputRevision, 1);
      assert.equal(c.canEdit, true);
    } finally {
      c.dispose();
    }
  });
test("physical activity and withdrawal guard replacement input while late save remains recoverable", async () => {
  const f = mediaInputFixture(),
    c = await openMedia(f),
    gate = deferred();
  try {
    characterDraft(c);
    f.physical(true);
    await c.save();
    assert.equal(f.records.size, 0);
    f.physical(false);
    f.hold(gate.promise);
    const pending = c.save();
    await settle();
    c.setReady(false);
    gate.resolve();
    await pending;
    assert.equal(c.getSnapshot().phase, "waiting");
    assert.equal(c.getSnapshot().input, null);
    assert.ok(c.getSnapshot().pending);
    c.setReady(true);
    await c.retry();
    assert.equal(f.records.size, 1);
    assert.equal(c.getSnapshot().input.inputRevision, 1);
  } finally {
    gate.resolve();
    c.dispose();
  }
});
