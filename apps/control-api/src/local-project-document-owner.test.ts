import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalProjectDocumentOwner } from "./local-project-document-owner.ts";

const actor = {
  principalId: "user",
  actorId: "user",
  tenantId: "tenant",
  spaceId: "space",
};
test("Agent and page share file revisions, notify after save, and recheck revoked grants", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-owner-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  let enabled = true;
  const current = () => {
    if (!enabled) throw new Error("revoked");
  };
  const owner = new LocalProjectDocumentOwner(
    async ({ actor: who, projectId }) => {
      if (who.tenantId !== actor.tenantId || projectId !== "project")
        throw new Error("denied");
      current();
      return { root, assertCurrent: current };
    },
  );
  const events: number[] = [];
  const dispose = await owner.subscribe(actor, "project", (event) => {
    events.push(event.revision);
  });
  const input = {
    projectId: "project",
    documentId: "script",
    expectedRevision: 0,
    content: "场景一",
  };
  const saved = await owner.save(actor, input);
  assert.deepEqual(await owner.read(actor, input), saved);
  await owner.save(actor, input);
  assert.deepEqual(events, [1]);
  await assert.rejects(
    owner.save(actor, { ...input, content: "过期页面" }),
    /revision_conflict/,
  );
  await assert.rejects(
    owner.read({ ...actor, tenantId: "foreign" }, input),
    /denied/,
  );
  enabled = false;
  await assert.rejects(
    owner.save(actor, { ...input, expectedRevision: 1, content: "禁止写入" }),
    /revoked/,
  );
  assert.deepEqual(events, [1]);
  dispose();
});

test("a failing page listener cannot change a successful file commit", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "project-owner-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const owner = new LocalProjectDocumentOwner(async () => ({
    root,
    assertCurrent() {},
  }));
  const dispose = await owner.subscribe(actor, "project", () => {
    throw new Error("disconnected");
  });
  const saved = await owner.save(actor, {
    projectId: "project",
    documentId: "brief",
    expectedRevision: 0,
    content: "简报",
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual(
    await owner.read(actor, { projectId: "project", documentId: "brief" }),
    saved,
  );
  dispose();
});
