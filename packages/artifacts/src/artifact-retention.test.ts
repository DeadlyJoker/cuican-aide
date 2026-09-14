import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type {
  ArtifactRetentionGuard,
  PutArtifactInput,
} from "@crewon/application";
import { FilesystemArtifactStore } from "./filesystem-artifact-store.ts";
import { DEFAULT_ARTIFACT_RETENTION } from "./artifact-retention.ts";

const policy = {
  ...DEFAULT_ARTIFACT_RETENTION,
  minimumIntervalMs: 100,
  recoveryGraceMs: 0,
  maxDurationMs: 5000,
  maxRecords: 2,
};
const allow: ArtifactRetentionGuard = { canRetireArtifact: async () => true };
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "crewon-artifact-retention-"));
  const databasePath = path.join(root, "artifacts.sqlite");
  const stores: FilesystemArtifactStore[] = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const open = () => {
    const s = new FilesystemArtifactStore({
      rootDirectory: root,
      databasePath,
      encryptionKey: Buffer.alloc(32, 42),
      keyId: "key",
    });
    stores.push(s);
    return s;
  };
  const mutate = (sql: string) => {
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const due = () =>
    mutate(
      "UPDATE artifact_maintenance SET next_due_ms=0; UPDATE artifact_retention_queue SET next_check_ms=0",
    );
  const blob = (i: PutArtifactInput) => {
    const hash = createHash("sha256")
      .update(i.record.tenantId)
      .update("\0")
      .update(i.record.artifactId)
      .digest("hex");
    return path.join(
      root,
      "blobs",
      hash.slice(0, 2),
      hash.slice(2, 4),
      `${hash}.artifact`,
    );
  };
  return { root, databasePath, open, mutate, due, blob };
}
function input(
  id: string,
  expiresAt = "2020-02-01T00:00:00Z",
): PutArtifactInput {
  const content = Buffer.alloc(32 * 1024, id.charCodeAt(0));
  return {
    idempotencyKey: `idem-${id}`,
    content,
    record: {
      schemaVersion: "crewon.artifact.v0",
      artifactId: id,
      tenantId: "tenant",
      spaceId: "space",
      ownerActorId: "actor",
      kind: "toolOutput",
      mediaType: "text/plain",
      sensitivity: "workspaceSensitive",
      source: {
        kind: "toolOutput",
        runId: `run-${id}`,
        stepId: "step",
        attemptId: "attempt",
        callId: "call",
      },
      contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      byteLength: content.length,
      retention: { kind: "run", expiresAt },
      encryption: { scheme: "aes256gcm", keyId: "key" },
      scan: { status: "notRequired", scannedAt: null, scanner: null },
      createdAt: new Date(Date.parse(expiresAt) - 86400000).toISOString(),
    },
  };
}
const maintain = (
  store: FilesystemArtifactStore,
  guard = allow,
  signal = new AbortController().signal,
) => store.retention.maintainArtifacts({ policy, guard, signal });

test("expired terminal artifacts lose only bodies and preserve metadata/idempotency across restart and VACUUM", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a");
  await s.put(i);
  const metadata = await s.get(i.record);
  const report = await maintain(s);
  assert.equal(report.deleted, 1);
  assert.equal(report.deletedBytes, i.content.length);
  assert(!existsSync(f.blob(i)));
  assert.deepEqual(await s.get(i.record), metadata);
  assert.equal(await s.read(i.record), null);
  await s.close();
  f.mutate("VACUUM");
  const reopened = f.open();
  assert.deepEqual(
    await reopened.put({ ...i, record: { ...i.record, artifactId: "new-id" } }),
    { disposition: "replayed", record: i.record },
  );
  assert(!existsSync(f.blob(i)));
  assert.deepEqual(await reopened.get(i.record), metadata);
  assert.equal(i.record.source.kind, "toolOutput");
  if (i.record.source.kind !== "toolOutput")
    throw new Error("fixture_source_invalid");
  await assert.rejects(
    reopened.put({
      ...i,
      record: { ...i.record, source: { ...i.record.source, callId: "other" } },
    }),
  );
});

test("retained and writing candidates do not block later eligible bodies; count and byte budgets apply", async (t) => {
  const f = fixture(t),
    s = f.open();
  const values = ["a", "b", "c", "d", "e"].map((id) => input(id));
  for (const i of values) await s.put(i);
  f.mutate("UPDATE artifacts SET state='writing' WHERE artifact_id='b'");
  const checked: string[] = [];
  const guard = {
    canRetireArtifact: async (
      c: Parameters<ArtifactRetentionGuard["canRetireArtifact"]>[0],
    ) => {
      checked.push(c.record.artifactId);
      return c.record.artifactId !== "a";
    },
  };
  assert.equal((await maintain(s, guard)).deleted, 0);
  f.mutate("UPDATE artifact_maintenance SET next_due_ms=0");
  const next = await s.retention.maintainArtifacts({
    policy: { ...policy, maxBytes: 32768 },
    guard,
    signal: new AbortController().signal,
  });
  assert.equal(next.checked, 2);
  assert.equal(next.deleted, 1);
  assert.equal(next.deletedBytes, 32768);
  f.mutate(
    "UPDATE artifact_maintenance SET next_due_ms=0; UPDATE artifact_retention_queue SET next_check_ms=0 WHERE artifact_id IN ('c','d','e')",
  );
  await maintain(s, guard);
  f.mutate("UPDATE artifact_maintenance SET next_due_ms=0");
  await maintain(s, guard);
  assert(existsSync(f.blob(values[0]!)));
  assert(existsSync(f.blob(values[1]!)));
  for (const i of values.slice(2)) assert(!existsSync(f.blob(i)));
});

test("expiry plus recovery grace must pass before authority lookup or deletion", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a", new Date(Date.now() - 1000).toISOString());
  await s.put(i);
  let checks = 0;
  const guard = {
    canRetireArtifact: async () => {
      checks++;
      return true;
    },
  };
  assert.equal(
    (
      await s.retention.maintainArtifacts({
        policy: { ...policy, recoveryGraceMs: 60000 },
        guard,
        signal: new AbortController().signal,
      })
    ).deleted,
    0,
  );
  assert.equal(checks, 0);
  assert(existsSync(f.blob(i)));
});

test("lost maintenance ownership and cancellation reject late positive recovery evidence", async (t) => {
  for (const mode of ["cancel", "ownership"]) {
    const f = fixture(t),
      s = f.open(),
      i = input("a");
    await s.put(i);
    const controller = new AbortController();
    let release!: () => void, entered!: () => void;
    const began = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const work = maintain(
      s,
      {
        canRetireArtifact: async () => {
          entered();
          await gate;
          return true;
        },
      },
      controller.signal,
    );
    await began;
    assert.equal((await maintain(f.open())).disposition, "deferred");
    assert.equal((await maintain(s)).disposition, "deferred");
    if (mode === "cancel") controller.abort("test");
    else f.mutate("UPDATE artifact_maintenance SET owner='new-owner'");
    release();
    if (mode === "cancel") await assert.rejects(work);
    else assert.equal((await work).deleted, 0);
    assert(existsSync(f.blob(i)));
    assert.deepEqual(Buffer.from((await s.read(i.record))!.content), i.content);
  }
});

test("sealed deletion resumes after filesystem failure and never recreates the blob on replay", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a");
  await s.put(i);
  const parent = path.dirname(f.blob(i)),
    moved = `${parent}-moved`;
  renameSync(parent, moved);
  symlinkSync(moved, parent);
  await assert.rejects(maintain(s), {
    code: "artifact_retention_path_invalid",
  });
  assert.deepEqual(await s.put(i), {
    disposition: "replayed",
    record: i.record,
  });
  assert.equal(await s.read(i.record), null);
  assert(existsSync(f.blob(i)));
  rmSync(parent);
  renameSync(moved, parent);
  await s.close();
  const restarted = f.open();
  f.due();
  const result = await maintain(restarted, {
    canRetireArtifact: async () => {
      throw new Error("sealed proof should be reused");
    },
  });
  assert.equal(result.deleted, 1);
  assert(!existsSync(f.blob(i)));
});

test("v1 migration does not backfill on open; indexed key pages survive restart and new lower keys", async (t) => {
  const f = fixture(t),
    s = f.open();
  for (const id of ["b", "c", "d", "e", "f"]) await s.put(input(id));
  await s.close();
  f.mutate(
    "DROP TRIGGER artifact_enqueue_retention; DROP TABLE artifact_retention_queue; DROP TABLE artifact_maintenance; DROP TABLE artifact_schema; CREATE TABLE artifact_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER CHECK(version=1)); INSERT INTO artifact_schema VALUES(1,1)",
  );
  const reopened = f.open(),
    db = new DatabaseSync(f.databasePath);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM artifact_retention_queue").get()!.n,
    0,
  );
  db.close();
  const first = await maintain(reopened);
  assert.equal(first.indexed, 2);
  assert.equal(first.checked, 2);
  await reopened.put(input("a"));
  await reopened.close();
  const last = f.open();
  for (let n = 0; n < 5; n++) {
    f.due();
    const r = await maintain(last);
    assert(r.indexed <= 2 && r.checked <= 2);
  }
  for (const id of ["a", "b", "c", "d", "e", "f"])
    assert(!existsSync(f.blob(input(id))));
});

test("newer artifact authority is rejected without retirement DDL or metadata changes", async (t) => {
  const f = fixture(t),
    s = f.open();
  await s.put(input("a"));
  await s.close();
  f.mutate(
    "DROP TRIGGER artifact_enqueue_retention; DROP TABLE artifact_retention_queue; DROP TABLE artifact_maintenance; DROP TABLE artifact_schema; CREATE TABLE artifact_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO artifact_schema VALUES(1,3)",
  );
  const before = readFileSync(f.databasePath);
  assert.throws(() => f.open(), { code: "artifact_schema_unsupported" });
  const db = new DatabaseSync(f.databasePath);
  assert.equal(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='artifact_retention_queue'",
      )
      .get(),
    undefined,
  );
  db.close();
  assert.deepEqual(readFileSync(f.databasePath), before);
});

test("missing v2 retirement authority is not silently recreated", async (t) => {
  for (const sql of [
    "DROP TABLE artifact_retention_queue",
    "DROP TRIGGER artifact_enqueue_retention",
    "DELETE FROM artifact_maintenance",
  ]) {
    const f = fixture(t),
      s = f.open();
    await s.put(input("a"));
    await s.close();
    f.mutate(sql);
    assert.throws(() => f.open(), { code: "artifact_schema_incomplete" });
  }
});

test("unlink followed by failed metadata commit resumes without another authority decision", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a");
  await s.put(i);
  f.mutate(
    "CREATE TRIGGER fail_deleted BEFORE UPDATE OF deleted_at_ms ON artifact_retention_queue WHEN NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_after_unlink'); END",
  );
  await assert.rejects(maintain(s), /test_after_unlink/);
  assert(!existsSync(f.blob(i)));
  assert.equal(await s.read(i.record), null);
  assert.equal((await s.put(i)).disposition, "replayed");
  await s.close();
  f.mutate("DROP TRIGGER fail_deleted");
  const reopened = f.open();
  f.due();
  assert.equal(
    (
      await maintain(reopened, {
        canRetireArtifact: async () => {
          throw new Error("no new check");
        },
      })
    ).deleted,
    1,
  );
  assert(!existsSync(f.blob(i)));
});

test("foreground SQLite writers defer maintenance without waiting for the normal busy timeout", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a");
  await s.put(i);
  const writer = new DatabaseSync(f.databasePath);
  writer.exec("BEGIN IMMEDIATE");
  try {
    const before = performance.now();
    assert.equal((await maintain(s)).disposition, "deferred");
    assert(performance.now() - before < 500);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  assert.equal((await maintain(s)).deleted, 1);
});

test("byte admission counts unconfirmed deletions and resumes their confirmation in a later batch", async (t) => {
  const f = fixture(t),
    s = f.open(),
    a = input("a"),
    b = input("b");
  await s.put(a);
  await s.put(b);
  // Model a confirmation that cannot update the row, without timing a second writer.
  f.mutate(
    "CREATE TRIGGER skip_deleted BEFORE UPDATE OF deleted_at_ms ON artifact_retention_queue WHEN NEW.deleted_at_ms IS NOT NULL BEGIN SELECT RAISE(IGNORE); END",
  );
  const pass = () =>
    s.retention.maintainArtifacts({
      policy: { ...policy, maxBytes: a.content.length },
      guard: allow,
      signal: new AbortController().signal,
    });
  const first = await pass();
  assert.equal(first.deleted, 0);
  assert.equal(first.deletedBytes, 0);
  assert(!existsSync(f.blob(a)));
  assert(existsSync(f.blob(b)));
  f.mutate("DROP TRIGGER skip_deleted");
  f.due();
  assert.equal((await pass()).deleted, 1);
  assert(existsSync(f.blob(b)));
  f.due();
  assert.equal((await pass()).deleted, 1);
  assert(!existsSync(f.blob(b)));
});

test("changed retirement metadata cannot reuse old deletion proof", async (t) => {
  const f = fixture(t),
    s = f.open(),
    i = input("a");
  await s.put(i);
  const parent = path.dirname(f.blob(i)),
    moved = `${parent}-moved`;
  renameSync(parent, moved);
  symlinkSync(moved, parent);
  await assert.rejects(maintain(s));
  rmSync(parent);
  renameSync(moved, parent);
  f.mutate(
    "UPDATE artifacts SET record_json=json_set(record_json,'$.ownerActorId','other') WHERE artifact_id='a'",
  );
  f.due();
  assert.equal((await maintain(s)).deleted, 0);
  assert(existsSync(f.blob(i)));
});

test("legacy and due queries seek their indexes with many unrelated artifacts", async (t) => {
  const f = fixture(t),
    s = f.open();
  await s.put(input("a"));
  const db = new DatabaseSync(f.databasePath);
  try {
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000)
      INSERT INTO artifacts SELECT 'noise', 'artifact-'||x, 'idem-'||x, fingerprint, record_json, 'writing', 'noise-'||x, iv_base64 FROM n JOIN artifacts ON artifact_id='a'`);
    const plans = [
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT tenant_id,artifact_id FROM artifacts WHERE (tenant_id,artifact_id)>(?,?) ORDER BY tenant_id,artifact_id LIMIT ?",
        )
        .all("noise", "artifact-900", 2),
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT artifact_order FROM artifact_retention_queue INDEXED BY artifact_retention_due WHERE deleted_at_ms IS NULL AND next_check_ms<=? ORDER BY next_check_ms,artifact_order LIMIT ?",
        )
        .all(Date.now(), 2),
    ];
    for (const plan of plans)
      assert.match(JSON.stringify(plan), /SEARCH.*(?:INDEX|index)/);
    const result = await maintain(s);
    assert(result.indexed <= 2 && result.checked <= 2);
  } finally {
    db.close();
  }
});
