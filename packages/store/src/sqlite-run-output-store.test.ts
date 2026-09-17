import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";

test("upgrades v23 without rewriting exact receipts and replays compact output after reopening", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-output-migration-"));
  const path = join(directory, "store.sqlite");
  const fixture = await outputFixture(
    context,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const input = fixture.input([1], 2, "legacy");
  const legacy = {
    tenantId: input.tenantId,
    expectedRevision: 2,
    idempotency: input.entries[0]!.idempotency,
    events: [{ ...input.entries[0]!.event, sequence: 3 }],
    outbox: [],
    workItems: [],
  };
  await fixture.store.commitLeasedRun({
    lease: input.lease,
    commit: legacy,
    history: null,
  });
  await fixture.store.close();
  const old = new DatabaseSync(path);
  const exact = old
    .prepare(
      "SELECT result_json FROM idempotency_receipts ORDER BY scope, idempotency_key",
    )
    .all();
  old.exec(
    "DROP TRIGGER run_output_receipt_duplicate_guard; DROP TABLE run_output_receipts; PRAGMA user_version=23",
  );
  old.close();
  let store = new SqliteRunStore(path, { clock: fixture.clock });
  context.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const migrated = new DatabaseSync(path, { readOnly: true });
  assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, SQLITE_SCHEMA_VERSION);
  assert.deepEqual(
    migrated
      .prepare(
        "SELECT result_json FROM idempotency_receipts ORDER BY scope, idempotency_key",
      )
      .all(),
    exact,
  );
  migrated.close();
  const mixed = await store.appendRunOutputEvents(
    fixture.input([1, 2, 3], 3, "mixed"),
  );
  assert.equal(mixed.replayedCount, 1);
  assert.equal(mixed.appendedEvents.length, 2);
  await store.close();
  store = new SqliteRunStore(path, { clock: fixture.clock });
  const replay = await store.appendRunOutputEvents(
    fixture.input([1, 2, 3], 2, "retry-after-reopen"),
  );
  assert.equal(replay.replayedCount, 3);
  assert.equal(replay.state.lastSequence, 5);
  assert.equal(replay.appendedEvents.length, 0);
  const oldReplay = await store.commitLeasedRun({
    lease: input.lease,
    commit: legacy,
    history: null,
  });
  assert.equal(oldReplay.disposition, "replayed");
  assert.equal(oldReplay.state.lastSequence, 3);
});

test("rolls back snapshot, events, notification and receipts on a mid-transaction write failure", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-output-rollback-"));
  const path = join(directory, "store.sqlite");
  const fixture = await outputFixture(
    context,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const database = new DatabaseSync(path);
  context.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await fixture.append(fixture.input([1, 2], 2, "first"));
  const before = database.prepare("SELECT state_json FROM run_snapshots").all();
  database.exec(`CREATE TRIGGER injected_output_failure BEFORE INSERT ON run_output_receipts
    WHEN NEW.segment_sequence=4 BEGIN SELECT RAISE(ABORT, 'injected_write_failure'); END`);
  await assert.rejects(fixture.append(fixture.input([3, 4], 4, "failed")));
  assert.deepEqual(
    database.prepare("SELECT state_json FROM run_snapshots").all(),
    before,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM run_events").get()?.count,
    4,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM run_output_receipts").get()
      ?.count,
    2,
  );
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM outbox WHERE message_id='failed'")
      .get()?.count,
    0,
  );
  database.exec("DROP TRIGGER injected_output_failure");
  const retried = await fixture.append(fixture.input([3, 4], 4, "retry"));
  assert.equal(retried.replayedCount, 0);
  assert.deepEqual(
    retried.appendedEvents.map((event) => event.sequence),
    [5, 6],
  );
});
