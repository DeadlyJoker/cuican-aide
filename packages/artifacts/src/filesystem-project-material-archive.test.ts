import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  truncateSync,
  symlinkSync,
  renameSync,
  rmSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { projectReferenceMaterialFreezeIdentity } from "@crewon/application";
import {
  materialArchiveInput,
  materialArchiveFixture,
  materialArchiveDigester,
} from "./project-material-archive.test-support.ts";

test("material archive encrypts exact large bytes, reopens and replays the original observation", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput(Buffer.alloc(1701417, 37));
  const first = await store.save(value);
  assert.equal(first.disposition, "created");
  const encrypted = readFileSync(f.blob(value.record.materialId));
  assert.equal(encrypted.includes(Buffer.from("original-run")), false);
  assert.equal(encrypted.includes(value.bytes), false);
  assert.deepEqual(
    (await store.load(value.record.request))!.bytes,
    value.bytes,
  );
  store.close();
  const reopened = f.open(),
    later = {
      ...value,
      record: {
        ...value.record,
        source: {
          ...value.record.source,
          observedAt: "2026-10-06T09:00:00.000Z",
        },
      },
    };
  const replay = await reopened.save(later);
  assert.equal(replay.disposition, "replayed");
  assert.equal(replay.record.source.observedAt, value.record.source.observedAt);
  assert.deepEqual(readFileSync(f.blob(value.record.materialId)), encrypted);
  const read = await reopened.load(value.record.request);
  read!.bytes[0] = 0;
  assert.deepEqual(
    (await reopened.load(value.record.request))!.bytes,
    value.bytes,
  );
});
test("material archive never replaces original bytes or accepts another request under the original key", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await store.save(value);
  await assert.rejects(
    store.save(materialArchiveInput(Buffer.alloc(1024, 38))),
    /idempotency_conflict/u,
  );
  const changed = {
    ...value.record.request,
    query: { ...value.record.request.query, expectedAssetRevision: 5 },
  };
  assert.equal(
    projectReferenceMaterialFreezeIdentity(
      changed,
      "archive",
      materialArchiveDigester,
    ).materialId,
    value.record.materialId,
  );
  await assert.rejects(store.load(changed), /idempotency_conflict/u);
  assert.deepEqual(
    (await store.load(value.record.request))!.bytes,
    value.bytes,
  );
});
test("material archive separates actual scope and archive identity instead of using filenames as identity", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await store.save(value);
  for (const field of [
    "tenantId",
    "spaceId",
    "principalId",
    "actorId",
  ] as const) {
    const request = {
      ...value.record.request,
      actor: { ...value.record.request.actor, [field]: "other" },
    };
    assert.equal(await store.load(request), null);
  }
  assert.equal(
    await store.load({
      ...value.record.request,
      query: { ...value.record.request.query, projectId: "other" },
    }),
    null,
  );
  const other = f.open({ archiveId: "other-archive" });
  assert.equal(await other.load(value.record.request), null);
  await assert.rejects(other.save(value), /identity_invalid/u);
});
test("material archive validates copied bytes and strict provenance metadata before creating files", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await assert.rejects(
    store.save({ ...value, bytes: Buffer.alloc(1024, 3) }),
    /bytes_invalid/u,
  );
  await assert.rejects(
    store.save({ ...value, bytes: Buffer.alloc(1025) }),
    /bytes_invalid/u,
  );
  await assert.rejects(
    store.save({
      ...value,
      record: {
        ...value.record,
        source: { ...value.record.source, referenceRevision: 2 },
      },
    }),
    /frozen_material_invalid/u,
  );
  let touched = 0;
  const getter = {
    ...value.record.request,
    get idempotencyKey() {
      touched++;
      return "key";
    },
  };
  await assert.rejects(store.load(getter));
  assert.equal(touched, 0);
  const proxy = new Proxy(value.record.request, {
    ownKeys() {
      touched++;
      throw new Error("trap");
    },
  });
  await assert.rejects(store.load(proxy));
  assert.equal(touched, 0);
  assert.deepEqual(readdirSync(f.root), []);
});
test("material archive snapshots caller buffers and metadata before asynchronous replay checks", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  const expected = Buffer.from(value.bytes),
    saving = store.save(value);
  value.bytes.fill(0);
  await saving;
  assert.deepEqual((await store.load(value.record.request))!.bytes, expected);
});
test("material archive exclusive publication coordinates two handles without overwriting the winner", async (t) => {
  const f = materialArchiveFixture(t),
    a = f.open(),
    b = f.open(),
    value = materialArchiveInput();
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).save(value)),
  );
  assert.equal(outcomes.filter((x) => x.disposition === "created").length, 1);
  assert.deepEqual(readdirSync(f.root), [
    `${value.record.materialId}.crwpm`,
    `${value.record.materialId}.intent-crwpm`,
  ]);
  assert.deepEqual((await a.load(value.record.request))!.bytes, value.bytes);
});
test("material archive preserves its original intent when bytes disappear and restores only the exact pinned content", async (t) => {
  const f = materialArchiveFixture(t),
    value = materialArchiveInput(),
    first = f.open();
  await first.save(value);
  first.close();
  unlinkSync(f.blob(value.record.materialId));
  const reopened = f.open();
  await assert.rejects(reopened.load(value.record.request), /content_missing/u);
  await assert.rejects(
    reopened.save(materialArchiveInput(Buffer.alloc(1024, 99))),
    /idempotency_conflict/u,
  );
  assert.equal((await reopened.save(value)).disposition, "created");
  assert.deepEqual(
    (await reopened.load(value.record.request))!.bytes,
    value.bytes,
  );
});
test("material archive authenticates ciphertext and key; corruption never causes silent repair", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await store.save(value);
  const before = readFileSync(f.blob(value.record.materialId)),
    wrong = f.open({ encryptionKey: Buffer.alloc(32, 74) });
  await assert.rejects(wrong.load(value.record.request), /ciphertext_invalid/u);
  await assert.rejects(wrong.save(value), /ciphertext_invalid/u);
  const corrupt = Buffer.from(before);
  corrupt[corrupt.length - 1] ^= 1;
  writeFileSync(f.blob(value.record.materialId), corrupt, { mode: 0o600 });
  await assert.rejects(store.load(value.record.request), /ciphertext_invalid/u);
  await assert.rejects(store.save(value), /ciphertext_invalid/u);
  assert.deepEqual(readFileSync(f.blob(value.record.materialId)), corrupt);
});
test("material archive rejects symlinks, exposed modes, non-regular files and oversize ciphertext before reading", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await store.save(value);
  const blob = f.blob(value.record.materialId);
  chmodSync(blob, 0o644);
  await assert.rejects(store.load(value.record.request), /file_invalid/u);
  chmodSync(blob, 0o600);
  truncateSync(blob, 17 * 1024 * 1024);
  await assert.rejects(store.load(value.record.request), /file_invalid/u);
  renameSync(blob, `${blob}.own-saved`);
  symlinkSync(`${blob}.own-saved`, blob);
  await assert.rejects(store.load(value.record.request), /file_invalid/u);
  unlinkSync(blob);
  mkdirSync(blob);
  await assert.rejects(store.load(value.record.request), /file_invalid/u);
});
test("material archive rejects a replaced root and closed handles", async (t) => {
  const f = materialArchiveFixture(t),
    store = f.open(),
    value = materialArchiveInput();
  await store.save(value);
  const moved = `${f.root}.moved`;
  renameSync(f.root, moved);
  symlinkSync(moved, f.root);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  await assert.rejects(store.load(value.record.request), /path_invalid/u);
  store.close();
  await assert.rejects(store.save(value), /closed/u);
  const g = materialArchiveFixture(t),
    current = g.open(),
    movedRoot = `${g.root}.moved`;
  renameSync(g.root, movedRoot);
  mkdirSync(g.root, { mode: 0o700 });
  t.after(() => rmSync(movedRoot, { recursive: true, force: true }));
  await assert.rejects(current.load(value.record.request), /path_invalid/u);
});
test("material archive survives independent process writers and a cold reader", async (t) => {
  const f = materialArchiveFixture(t),
    value = materialArchiveInput();
  f.open().close();
  const moduleUrl = new URL(
      "./filesystem-project-material-archive.ts",
      import.meta.url,
    ).href,
    supportUrl = new URL(
      "./project-material-archive.test-support.ts",
      import.meta.url,
    ).href;
  const code = `import {FilesystemProjectMaterialArchive} from ${JSON.stringify(moduleUrl)};import {materialArchiveInput} from ${JSON.stringify(supportUrl)};const store=new FilesystemProjectMaterialArchive({...JSON.parse(process.env.CREWON_MATERIAL_ARCHIVE_CONFIG),encryptionKey:Buffer.alloc(32,73)});await store.save(materialArchiveInput());store.close();`;
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", code],
        {
          env: {
            ...process.env,
            CREWON_MATERIAL_ARCHIVE_CONFIG: JSON.stringify({
              ...f.config,
              encryptionKey: undefined,
            }),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let error = "";
      child.stderr.on("data", (chunk) => {
        error += chunk;
      });
      child.on("error", reject);
      child.on("close", (exit) => {
        if (exit === 0) resolve();
        else reject(new Error(error));
      });
    });
  await Promise.all([run(), run()]);
  const read = await f.open().load(value.record.request);
  assert.deepEqual(read!.bytes, value.bytes);
  assert.deepEqual(readdirSync(f.root), [
    `${value.record.materialId}.crwpm`,
    `${value.record.materialId}.intent-crwpm`,
  ]);
});
