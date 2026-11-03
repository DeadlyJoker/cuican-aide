import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LocalProjectDocuments,
  localProjectDocumentScope,
} from "./local-project-documents.ts";

test("projects sharing one folder retain independent files and notifications while legacy files remain intact", async (t) => {
  const { root, store: legacy } = fixture(t);
  legacy.save({ documentId: "script", content: "legacy", expectedRevision: 0 });
  const scopeA = localProjectDocumentScope({
    tenantId: "tenant",
    spaceId: "space",
    projectId: "a",
  });
  const scopeB = localProjectDocumentScope({
    tenantId: "tenant",
    spaceId: "space",
    projectId: "b",
  });
  assert.notEqual(
    scopeA,
    localProjectDocumentScope({
      tenantId: "other",
      spaceId: "space",
      projectId: "a",
    }),
  );
  const a = new LocalProjectDocuments(root, { scope: scopeA });
  const b = new LocalProjectDocuments(root, { scope: scopeB });
  assert.equal(a.read("script"), null);
  let aEvents = 0;
  const stopA = a.subscribe("script", () => aEvents++);
  let stopB = () => {};
  t.after(() => {
    stopA();
    stopB();
  });
  const notified = new Promise<void>((resolve) => {
    stopB = b.subscribe("script", resolve);
  });
  b.save({ documentId: "script", content: "only-b", expectedRevision: 0 });
  await Promise.race([
    notified,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("missing notification")), 3000).unref(),
    ),
  ]);
  assert.equal(aEvents, 0);
  assert.equal(a.read("script"), null);
  a.save({ documentId: "script", content: "only-a", expectedRevision: 0 });
  assert.equal(
    new LocalProjectDocuments(root, { scope: scopeA }).read("script")?.content,
    "only-a",
  );
  assert.equal(b.read("script")?.content, "only-b");
  assert.equal(legacy.read("script")?.content, "legacy");
  assert.throws(
    () => new LocalProjectDocuments(root, { scope: "../escape" }),
    /scope_invalid/,
  );
});

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crewon-documents-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: new LocalProjectDocuments(root) };
}

test("documents retain revisions across reopen and reject stale edits without overwriting", (t) => {
  const { root, store } = fixture(t);
  assert.equal(store.read("script-01"), null);
  const first = store.save({
    documentId: "script-01",
    expectedRevision: 0,
    content: "场一\n台词：别走。\n",
  });
  assert.deepEqual(new LocalProjectDocuments(root).read("script-01"), first);
  assert.deepEqual(
    store.save({
      documentId: "script-01",
      expectedRevision: 0,
      content: first.content,
    }),
    first,
  );
  const second = store.save({
    documentId: "script-01",
    expectedRevision: 1,
    content: "场一\n台词：请留下。\n",
  });
  assert.equal(second.revision, 2);
  assert.throws(
    () =>
      store.save({
        documentId: "script-01",
        expectedRevision: 1,
        content: "过期编辑",
      }),
    /revision_conflict/,
  );
  assert.equal(
    readFileSync(join(root, "documents/script-01/0000000001.md"), "utf8"),
    first.content,
  );
  assert.deepEqual(store.read("script-01"), second);
});

test("documents reject traversal and linked content, ignore interrupted temporary files", (t) => {
  const { root, store } = fixture(t);
  assert.throws(
    () =>
      store.save({
        documentId: "../escape",
        expectedRevision: 0,
        content: "x",
      }),
    /id_invalid/,
  );
  mkdirSync(join(root, "documents"));
  mkdirSync(join(root, "documents/script"));
  writeFileSync(join(root, "documents/script/.pending-interrupted"), "partial");
  assert.equal(store.read("script"), null);
  const saved = store.save({
    documentId: "script",
    expectedRevision: 0,
    content: "complete",
  });
  symlinkSync(join(root, "documents/script"), join(root, "documents/linked"));
  assert.throws(() => store.read("linked"), /directory_invalid/);
  symlinkSync(
    join(root, "documents/script/0000000001.md"),
    join(root, "documents/script/0000000002.md"),
  );
  assert.throws(() => store.read("script"), /file_invalid/);
  assert.equal(saved.content, "complete");
});

test("an occupied writer lock fails closed without removing another writer's lock", (t) => {
  const { root, store } = fixture(t);
  store.save({ documentId: "brief", expectedRevision: 0, content: "brief" });
  const lock = join(root, "documents/brief/.write-lock");
  writeFileSync(lock, "other-writer");
  assert.throws(
    () =>
      store.save({ documentId: "brief", expectedRevision: 1, content: "new" }),
    /busy/,
  );
  assert.equal(readFileSync(lock, "utf8"), "other-writer");
  assert.equal(store.read("brief")?.revision, 1);
});
