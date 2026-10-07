import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred } from "./persistent-ui.test-support.mjs";
import {
  assetControllerFixture as fixture,
  open,
  draft,
  details,
  content,
  copy,
  settle,
  acknowledge,
} from "./asset-controller.test-support.mjs";

test("save → select → reference → adopt reference → lock needs no additional review button", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    await c.save();
    assert.equal(c.canEdit, true);
    await c.selectContent();
    assert.equal(c.canEdit, true);
    await c.attachReference({
      conceptAssetId: "concept-original",
      selectionRevision: 3,
    });
    assert.equal(c.canEdit, true);
    assert.equal(
      f.asset.selectedReferenceRevision,
      null,
      "saving a candidate does not select it",
    );
    await c.selectReference(1);
    assert.equal(c.canEdit, true);
    await c.setLocked();
    assert.equal(c.canEdit, true);
    assert.equal(f.asset.locked, true);
    assert.equal(f.acknowledges, 5);
    assert.equal(f.record, null);
    assert.equal(c.getSnapshot().pending, null);
    assert.equal(c.getSnapshot().view.asset.revision, 5);
    assert.equal(
      c.getSnapshot().references[0].source.operationId,
      "11111111-1111-4111-8111-111111111111",
    );
    const methods = f.calls.map(([method]) => method);
    for (const method of [
      "saveCandidate",
      "selectRevision",
      "saveReferenceCandidate",
      "selectReference",
      "setLocked",
    ]) {
      const dispatch = methods.indexOf(method),
        ack = methods.indexOf("acknowledge", dispatch);
      assert.ok(methods.indexOf("getRevision", dispatch) < ack);
      assert.equal(
        methods[ack + 1],
        "getPending",
        "the ACK must be followed by the real empty-slot read",
      );
    }
    assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
  } finally {
    c.dispose();
  }
});

for (const where of [
  "getPending",
  "getRevision",
  "getAsset",
  "acknowledge",
  "postAckRead",
])
  test(`a confirmed write remains saved and blocks replacement when ${where} fails`, async () => {
    const f = fixture(),
      c = await open(f);
    try {
      draft(c);
      const port = ["getRevision", "getAsset"].includes(where)
        ? f.client
        : f.recovery;
      const method = where === "postAckRead" ? "getPending" : where;
      const original = port[method];
      port[method] = async (...args) => {
        if (where !== "postAckRead" || f.acknowledges > 0)
          throw Error("named response failure");
        return original(...args);
      };
      await c.save();
      assert.equal(c.getSnapshot().pending, null);
      assert.match(c.getSnapshot().notice, /已保存/);
      assert.match(c.getSnapshot().error, /保存已确认/);
      assert.equal(c.canEdit, false);
      assert.equal(f.acknowledges, where === "postAckRead" ? 1 : 0);
      const before = f.receipts.size;
      c.newAsset("prop");
      await c.save();
      await c.selectContent();
      assert.equal(f.receipts.size, before);
      port[method] = original;
      if (where === "postAckRead") await c.recovery.check();
      else {
        await c.recovery.check();
        await acknowledge(c);
      }
      assert.equal(
        c.canEdit,
        true,
        "explicit reads/review recover the confirmed outcome without repeating the business write",
      );
      assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
    } finally {
      c.dispose();
    }
  });

test("a lost ACK response retains the original terminal record for an idempotent ACK retry", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    const original = f.recovery.acknowledge;
    f.recovery.acknowledge = async (...args) => {
      await original(...args);
      throw Error("ACK response lost");
    };
    await c.save();
    assert.equal(f.record, null);
    assert.equal(c.canEdit, false);
    await c.recovery.check();
    assert.equal(c.recovery.getSnapshot().intent.phase, "accepted");
    f.recovery.acknowledge = original;
    await c.acknowledgeRecovery();
    assert.equal(c.canEdit, true);
    assert.equal(f.acknowledges, 1);
    assert.equal(f.receipts.size, 1);
  } finally {
    c.dispose();
  }
});

for (const mismatch of ["action", "body", "key", "receipt", "immutable"])
  test(`warm success never ACKs a ${mismatch} mismatch`, async () => {
    const f = fixture(),
      c = await open(f);
    try {
      draft(c);
      const get = f.recovery.getPending;
      f.recovery.getPending = async (...args) => {
        const response = await get(...args);
        if (response.intent?.phase !== "accepted") return response;
        if (mismatch === "action")
          response.intent.request.action = "crewon.project-assets.v2.setLocked";
        if (mismatch === "body")
          response.intent.request.input.request.content.name =
            "a different request";
        if (mismatch === "key")
          response.intent.request.input.idempotencyKey = "another-key";
        if (mismatch === "receipt") response.intent.confirmed.assetRevision++;
        return response;
      };
      if (mismatch === "immutable") {
        const read = f.client.getRevision;
        f.client.getRevision = async (...args) => {
          const result = await read(...args);
          result.contentRevision.content.name = "different immutable data";
          return result;
        };
      }
      await c.save();
      assert.equal(f.acknowledges, 0);
      assert.equal(c.canEdit, false);
      assert.equal(c.getSnapshot().pending, null);
      assert.match(c.getSnapshot().notice, /已保存/);
    } finally {
      c.dispose();
    }
  });

for (const loss of ["before", "after"])
  test(`cold ${loss === "before" ? "pending" : "accepted"} activation, restore and checks are strictly read-only`, async () => {
    const f = fixture();
    let c = await open(f);
    try {
      draft(c);
      f.loss(loss);
      await c.save();
      const original = copy(f.record.request);
      c.dispose();
      c = await open(f);
      await c.recovery.check();
      await c.restoreRecovery();
      c.setReady(false);
      c.setReady(true);
      await settle();
      await c.restoreRecovery();
      assert.deepEqual(f.record.request, original);
      assert.equal(f.acknowledges, 0);
      assert.equal(f.calls.filter(([m]) => m === "saveCandidate").length, 1);
      assert.equal(c.canEdit, false);
    } finally {
      c.dispose();
    }
  });

for (const phase of ["getPending", "getRevision", "getAsset", "acknowledge"])
  test(`withdrawal during warm ${phase} ignores late completion and does not unlock replacement writes`, async () => {
    const f = fixture(),
      c = await open(f),
      gate = deferred();
    try {
      draft(c);
      const port = ["getPending", "acknowledge"].includes(phase)
          ? f.recovery
          : f.client,
        original = port[phase];
      port[phase] = async (...args) => {
        await gate.promise;
        return original(...args);
      };
      const saving = c.save();
      await settle();
      c.setReady(false);
      gate.resolve();
      await saving;
      assert.equal(c.getSnapshot().phase, "waiting");
      assert.equal(
        f.acknowledges,
        phase === "acknowledge" ? 1 : 0,
        "an already dispatched ACK can commit, but cannot project a late empty slot",
      );
      assert.equal(f.receipts.size, 1);
      c.setReady(true);
      await settle();
      assert.equal(c.canEdit, false);
    } finally {
      gate.resolve();
      c.dispose();
    }
  });

test("switching to a different project during immutable review does not ACK the old project", async () => {
  const f = fixture(),
    c = await open(f),
    gate = deferred();
  try {
    draft(c);
    const read = f.client.getRevision;
    f.client.getRevision = async (...args) => {
      await gate.promise;
      return read(...args);
    };
    const saving = c.save();
    await settle();
    const next = copy(details());
    next.project.projectId = "project-b";
    next.brief.projectId = "project-b";
    c.setProject(next);
    gate.resolve();
    await saving;
    await settle();
    assert.equal(f.acknowledges, 0);
    assert.equal(c.getSnapshot().projectId, "project-b");
    assert.equal(c.getSnapshot().content, null);
    assert.equal(c.canEdit, false);
  } finally {
    gate.resolve();
    c.dispose();
  }
});

test("a changed project epoch before ACK does not clear the original successful write", async () => {
  const f = fixture(),
    c = await open(f),
    gate = deferred();
  try {
    draft(c);
    const read = f.client.getRevision;
    f.client.getRevision = async (...args) => {
      await gate.promise;
      return read(...args);
    };
    const saving = c.save();
    await settle();
    c.setProject(details(3, 2));
    gate.resolve();
    await saving;
    await settle();
    assert.equal(f.acknowledges, 0);
    assert.equal(f.revisions.get(1).brief.briefRevision, 1);
    assert.equal(c.canEdit, false);
  } finally {
    gate.resolve();
    c.dispose();
  }
});

test("a higher current head is retained across receipt review and a subsequent stale read", async () => {
  const f = fixture(),
    c = await open(f);
  try {
    draft(c);
    const read = f.client.getAsset;
    f.client.getAsset = async (...args) => {
      f.editAsset((asset) => ({ ...asset, revision: 4, locked: true }));
      return read(...args);
    };
    await c.save();
    assert.equal(c.getSnapshot().view.asset.revision, 4);
    assert.equal(c.getSnapshot().view.asset.locked, true);
    assert.deepEqual(
      c.getSnapshot().content.content,
      content,
      "the original immutable candidate is reviewed, not a substituted latest version",
    );
    f.client.getAsset = read;
    f.editAsset((asset) => ({ ...asset, revision: 1, locked: false }));
    await c.refresh();
    assert.equal(c.getSnapshot().view.asset.revision, 4);
    assert.equal(c.getSnapshot().assets[0].revision, 4);
  } finally {
    c.dispose();
  }
});
