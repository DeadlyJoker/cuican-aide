import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { decodePostgresThreadState } from "./postgres-thread-codec.ts";
import {
  createThreadCommitFixture,
  threadStateFixture,
} from "./thread-store-conformance.test-support.ts";

test("SQLite workspace ownership survives restart while legacy JSON and receipts normalize without event rewrites", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-thread-workspace-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "threads.sqlite");
  let store = new SqliteRunStore(path);
  const created = createThreadCommitFixture();
  const first = created.events[0]!;
  assert.equal(first.type, "thread.created");
  if (first.type !== "thread.created") throw new Error("fixture");
  const bound = {
    ...created,
    events: [{ ...first, data: { ...first.data, workspaceId: "workspace-a" } }],
  };
  await store.commitThread(bound);
  await store.close();
  store = new SqliteRunStore(path);
  const locator = { tenantId: "tenant-1", threadId: "thread-1" };
  assert.equal((await store.loadThread(locator))?.workspaceId, "workspace-a");
  assert.equal(
    (
      await store.listThreads({
        tenantId: "tenant-1",
        spaceId: "space-1",
        before: null,
        limit: 10,
      })
    )[0]?.workspaceId,
    "workspace-a",
  );
  await store.close();

  const legacyPath = join(directory, "legacy.sqlite");
  store = new SqliteRunStore(legacyPath);
  await store.commitThread(created);
  await store.close();
  const database = new DatabaseSync(legacyPath);
  database.exec(
    "UPDATE threads SET state_json = json_remove(state_json, '$.workspaceId')",
  );
  database.exec(
    "UPDATE thread_idempotency_receipts SET result_json = json_remove(result_json, '$.state.workspaceId')",
  );
  const eventsBefore = database
    .prepare("SELECT event_json FROM thread_events")
    .all();
  database.close();
  store = new SqliteRunStore(legacyPath);
  try {
    assert.equal((await store.loadThread(locator))?.workspaceId, null);
    assert.equal((await store.commitThread(created)).state.workspaceId, null);
  } finally {
    await store.close();
  }
  const after = new DatabaseSync(legacyPath);
  try {
    assert.deepEqual(
      after.prepare("SELECT event_json FROM thread_events").all(),
      eventsBefore,
    );
  } finally {
    after.close();
  }
});

test("PostgreSQL snapshot decoding normalizes old ownership and rejects path-shaped identities", () => {
  const { workspaceId: _, ...legacy } = threadStateFixture();
  const row = {
    tenant_id: legacy.tenantId,
    space_id: legacy.spaceId,
    thread_id: legacy.threadId,
    created_by_actor_id: legacy.createdByActorId,
    title: legacy.title,
    status: legacy.status,
    revision: legacy.revision,
    last_event_sequence: legacy.lastEventSequence,
    last_message_sequence: legacy.lastMessageSequence,
    state_json: legacy,
    created_at: legacy.createdAt,
    updated_at: legacy.updatedAt,
    archived_at: legacy.archivedAt,
    deleted_at: legacy.deletedAt,
    deleted_by_actor_id: legacy.deletedByActorId,
  };
  const locator = { tenantId: legacy.tenantId, threadId: legacy.threadId };
  assert.equal(decodePostgresThreadState(row, locator).workspaceId, null);
  assert.equal(
    decodePostgresThreadState(
      { ...row, state_json: { ...legacy, workspaceId: "workspace-a" } },
      locator,
    ).workspaceId,
    "workspace-a",
  );
  assert.throws(
    () =>
      decodePostgresThreadState(
        { ...row, state_json: { ...legacy, workspaceId: "/tmp/private" } },
        locator,
      ),
    /stored_thread_state_invalid/,
  );
});
