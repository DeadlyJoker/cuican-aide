import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import {
  createRunningCommitFixture,
  ManualLeaseClock,
} from "./run-store-conformance.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  prepareTextCompletion,
  textRunCompletionInput,
  textSegmentStartedEvent,
} from "./run-execution-store-conformance.test-support.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import { decodeSqliteExecutionReceipt } from "./sqlite-execution-receipt-codec.ts";
import { stableJson } from "./store-invariants.ts";

const tenantId = "tenant-1",
  runId = "run-store-1",
  threadId = "thread-1";
function idempotency(
  phase: string,
  command: unknown = { output: "完整结果🚀".repeat(1800) },
) {
  return {
    scope: stableJson({
      schemaVersion: "crewon.idempotency-scope.v0",
      namespace: "run-execution",
      tenantId,
      runId,
      workItemId: "work-item-1",
    }),
    key: phase,
    requestFingerprint: stableJson({
      schemaVersion: "crewon.run-execution-fingerprint.v0",
      runId,
      workItemId: "work-item-1",
      phase,
      command,
    }),
  };
}
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "crewon-receipt-codec-")),
    path = join(root, "store.sqlite");
  const clock = new ManualLeaseClock();
  let store = new SqliteRunStore(path, { clock });
  const db = new DatabaseSync(path);
  t.after(async () => {
    await store.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  await seedThread(store);
  return {
    get store() {
      return store;
    },
    db,
    path,
    clock,
    async reopen() {
      await store.close();
      store = new SqliteRunStore(path, { clock });
      return store;
    },
  };
}
function readReceipt(
  db: DatabaseSync,
  identity: ReturnType<typeof idempotency>,
) {
  return db
    .prepare(
      "SELECT tenant_id, run_id, fingerprint, result_json FROM idempotency_receipts WHERE scope=? AND idempotency_key=?",
    )
    .get(identity.scope, identity.key) as {
    tenant_id: string;
    run_id: string;
    fingerprint: string;
    result_json: string;
  };
}

test("new SQLite receipts restore exact public replay after reopen and reject changed fingerprint/tenant", async (t) => {
  const f = await fixture(t),
    input = {
      ...createRunningCommitFixture(),
      idempotency: idempotency("start"),
    };
  const committed = await f.store.commitRun(input);
  assert.match(
    readReceipt(f.db, input.idempotency).fingerprint,
    /^crewon\.sqlite-execution-receipt\.v1:/,
  );
  await f.reopen();
  await f.store.commitRun({
    tenantId,
    expectedRevision: 2,
    idempotency: idempotency("segment"),
    events: [textSegmentStartedEvent()],
    outbox: [],
    workItems: [],
  });
  assert.deepEqual(await f.store.commitRun(input), {
    ...committed,
    disposition: "replayed",
  });
  assert.deepEqual(
    await f.store.loadRunReceipt({
      tenantId,
      threadId,
      idempotency: input.idempotency,
    }),
    { ...committed, disposition: "replayed" },
  );
  await assert.rejects(
    f.store.commitRun({
      ...input,
      idempotency: idempotency("start", { changed: true }),
    }),
    /idempotency_conflict/,
  );
  await assert.rejects(
    f.store.loadRunReceipt({
      tenantId: "other",
      threadId,
      idempotency: input.idempotency,
    }),
    /tenant_id_mismatch/,
  );
  assert.deepEqual(await f.store.listRunEvents({ tenantId, runId }, 0, 100), [
    ...input.events,
    textSegmentStartedEvent(),
  ]);
});

test("v33 upgrade preserves old receipt bytes and mixed replay; newer storage is refused", async (t) => {
  const f = await fixture(t),
    input = {
      ...createRunningCommitFixture(),
      idempotency: idempotency("start"),
    };
  const committed = await f.store.commitRun(input);
  const legacy = decodeSqliteExecutionReceipt(
    readReceipt(f.db, input.idempotency),
    input.idempotency,
  );
  f.db
    .prepare(
      "UPDATE idempotency_receipts SET fingerprint=?, result_json=? WHERE scope=? AND idempotency_key=?",
    )
    .run(
      legacy.fingerprint,
      legacy.result_json,
      input.idempotency.scope,
      input.idempotency.key,
    );
  await f.store.close();
  f.db.exec("PRAGMA user_version=33");
  await f.reopen();
  assert.equal(
    f.db.prepare("PRAGMA user_version").get()!.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.deepEqual({ ...readReceipt(f.db, input.idempotency) }, legacy);
  assert.deepEqual(await f.store.commitRun(input), {
    ...committed,
    disposition: "replayed",
  });
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  await f.store.close();
  f.db.exec(`PRAGMA user_version=${SQLITE_SCHEMA_VERSION + 1}`);
  assert.throws(() => new SqliteRunStore(f.path), /sqlite_schema_too_new/);
});

test("compressed completion preserves canonical messages, model history, checkpoint and terminal replay", async (t) => {
  const f = await fixture(t);
  await f.store.commitRun(createRunningCommitFixture());
  f.clock.advance(2000);
  const claim = (await f.store.claimNextWorkItem({
    ownerId: "worker",
    leaseId: "lease",
    leaseDurationMs: 30000,
  }))!;
  await prepareTextCompletion(f.store, claim);
  const input = {
    ...textRunCompletionInput(claim),
    idempotency: idempotency("complete"),
  };
  const committed = await f.store.commitTextRunCompletion(input);
  assert.match(
    readReceipt(f.db, input.idempotency).fingerprint,
    /^crewon\.sqlite-execution-receipt\.v1:/,
  );
  await f.reopen();
  assert.deepEqual(await f.store.commitTextRunCompletion(input), {
    ...committed,
    disposition: "replayed",
  });
  assert.deepEqual(
    await f.store.listMessages({ tenantId, threadId }, 0, 100),
    input.thread.messages,
  );
  assert.deepEqual(
    await f.store.listModelHistoryItems({ tenantId, threadId }, 0, 100),
    input.history.items,
  );
  const before = await f.store.listRunEvents({ tenantId, runId }, 0, 100);
  f.db
    .prepare(
      "UPDATE idempotency_receipts SET result_json=? WHERE scope=? AND idempotency_key=?",
    )
    .run("{}", input.idempotency.scope, input.idempotency.key);
  await assert.rejects(
    f.store.commitTextRunCompletion(input),
    /idempotency_receipt_invalid/,
  );
  assert.deepEqual(
    await f.store.listRunEvents({ tenantId, runId }, 0, 100),
    before,
  );
});

test("receipt insertion failure rolls back completion history, attempt, snapshot and messages", async (t) => {
  const f = await fixture(t);
  await f.store.commitRun(createRunningCommitFixture());
  f.clock.advance(2000);
  const claim = (await f.store.claimNextWorkItem({
    ownerId: "worker",
    leaseId: "lease",
    leaseDurationMs: 30000,
  }))!;
  await prepareTextCompletion(f.store, claim);
  const input = {
    ...textRunCompletionInput(claim),
    idempotency: idempotency("complete"),
  };
  const events = await f.store.listRunEvents({ tenantId, runId }, 0, 100);
  f.db.exec(
    "CREATE TRIGGER injected_receipt_failure BEFORE INSERT ON idempotency_receipts WHEN NEW.fingerprint LIKE 'crewon.sqlite-execution-receipt.%' BEGIN SELECT RAISE(ABORT,'injected_receipt_failure'); END",
  );
  await assert.rejects(f.store.commitTextRunCompletion(input));
  assert.equal(readReceipt(f.db, input.idempotency), undefined);
  assert.deepEqual(
    await f.store.listRunEvents({ tenantId, runId }, 0, 100),
    events,
  );
  assert.deepEqual(
    await f.store.listModelHistoryItems({ tenantId, threadId }, 0, 100),
    [],
  );
  assert.deepEqual(
    await f.store.listMessages({ tenantId, threadId }, 0, 100),
    [],
  );
  assert.equal(
    (await f.store.loadRunAttempt({
      tenantId,
      runId,
      stepId: input.attempt.stepId,
      attemptId: input.attempt.attemptId,
    }))!.status,
    "running",
  );
  f.db.exec("DROP TRIGGER injected_receipt_failure");
  assert.equal(
    (await f.store.commitTextRunCompletion(input)).disposition,
    "committed",
  );
});

test("compressed legacy output replay keeps original event identity and expired leases remain fenced", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "crewon-receipt-output-")),
    path = join(root, "store.sqlite");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = await outputFixture(
    t,
    (clock) => new SqliteRunStore(path, { clock }),
  );
  const original = f.input([1], 2, "old");
  const identity = idempotency("output-1");
  const input = {
    ...original,
    entries: [{ ...original.entries[0]!, idempotency: identity }],
  };
  const commit = {
    tenantId,
    expectedRevision: 2,
    idempotency: identity,
    events: [{ ...input.entries[0]!.event, sequence: 3 }],
    outbox: [],
    workItems: [],
  };
  const committed = await f.store.commitLeasedRun({
    lease: input.lease,
    commit,
    history: null,
  });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  assert.match(
    readReceipt(db, identity).fingerprint,
    /^crewon\.sqlite-execution-receipt\.v1:/,
  );
  assert.equal((await f.store.appendRunOutputEvents!(input)).replayedCount, 1);
  await f.store.appendRunOutputEvents!(f.input([2], 3, "next"));
  assert.deepEqual(
    await f.store.commitLeasedRun({
      lease: input.lease,
      commit,
      history: null,
    }),
    { ...committed, disposition: "replayed" },
  );
  f.clock.advance(60000);
  await assert.rejects(
    f.store.commitLeasedRun({ lease: input.lease, commit, history: null }),
    /lease/,
  );
  assert.equal((await f.events()).length, 4);
});
