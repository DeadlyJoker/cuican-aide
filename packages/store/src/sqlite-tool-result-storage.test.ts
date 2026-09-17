import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import { stableJson } from "./store-invariants.ts";
import { createToolResultFixture as fixture } from "./sqlite-tool-result.test-support.ts";

function stored(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT state_json FROM tool_execution_receipts WHERE receipt_id='tool-receipt-1'",
    )
    .get()!.state_json as string;
}

test("SQLite Tool result encoding preserves exact compound replay, both lookup paths and canonical history after reopen", async (t) => {
  const f = await fixture(t),
    completed = await f.store.commitToolExecutionCompletion(f.input);
  const encoded = stored(f.db);
  assert.equal(typeof JSON.parse(encoded).result.output, "object");
  assert(
    Buffer.byteLength(encoded) <
      Buffer.byteLength(stableJson(completed.receipt)) / 2,
  );
  const events = await f.store.listRunEvents(f.locator, 0, 100),
    history = await f.store.listModelHistoryItems(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      100,
    );
  await f.reopen();
  assert.deepEqual(
    await f.store.loadToolExecutionReceipt(f.locator),
    completed.receipt,
  );
  assert.deepEqual(
    await f.store.loadToolExecutionReceiptByAction({
      ...f.locator,
      actionDigest: completed.receipt.actionDigest,
    }),
    completed.receipt,
  );
  const replay = await f.store.commitToolExecutionCompletion(f.input);
  assert.equal(replay.run.disposition, "replayed");
  assert.deepEqual(replay.receipt, completed.receipt);
  assert.deepEqual(await f.store.listRunEvents(f.locator, 0, 100), events);
  assert.deepEqual(
    await f.store.listModelHistoryItems(
      { tenantId: "tenant-1", threadId: "thread-1" },
      0,
      100,
    ),
    history,
  );
  assert.equal(history.at(-1)!.type, "tool_result");
  assert.equal(
    "output" in history.at(-1)! &&
      (history.at(-1) as { output: string }).output,
    f.output,
  );
});

test("SQLite 39 upgrades Tool body readers without rewriting existing plaintext receipts or source history", async (t) => {
  const f = await fixture(t),
    completed = await f.store.commitToolExecutionCompletion(f.input),
    ordinary = stableJson(completed.receipt);
  const events = await f.store.listRunEvents(f.locator, 0, 100);
  await f.store.close();
  f.db
    .prepare(
      "UPDATE tool_execution_receipts SET state_json=? WHERE receipt_id=?",
    )
    .run(ordinary, f.locator.receiptId);
  f.db.exec("PRAGMA user_version=39");
  await f.reopen();
  assert.equal(
    f.db.prepare("PRAGMA user_version").get()!.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.equal(stored(f.db), ordinary);
  assert.deepEqual(
    await f.store.loadToolExecutionReceipt(f.locator),
    completed.receipt,
  );
  assert.deepEqual(await f.store.listRunEvents(f.locator, 0, 100), events);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const replay = await f.store.commitToolExecutionCompletion(f.input);
  assert.equal(replay.run.disposition, "replayed");
  assert.equal(stored(f.db), ordinary);
});

test("Tool result encoding rolls back together with receipt, event and history when the compound update fails", async (t) => {
  const f = await fixture(t);
  f.db.exec(
    "CREATE TRIGGER reject_tool_result BEFORE UPDATE ON tool_execution_receipts BEGIN SELECT RAISE(ABORT,'test_tool_result_write_failed'); END;",
  );
  await assert.rejects(f.store.commitToolExecutionCompletion(f.input));
  assert.equal((await f.store.listRunEvents(f.locator, 0, 100)).length, 3);
  assert.equal(
    (
      await f.store.listModelHistoryItems(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
      )
    ).length,
    1,
  );
  assert.deepEqual(
    await f.store.loadToolExecutionReceipt(f.locator),
    f.prepared.receipt,
  );
  f.db.exec("DROP TRIGGER reject_tool_result");
  const committed = await f.store.commitToolExecutionCompletion(f.input);
  assert.equal(committed.receipt.result!.output, f.output);
  assert.equal(typeof JSON.parse(stored(f.db)).result.output, "object");
});

test("stored Tool result corruption and metadata changes fail closed on both lookup paths", async (t) => {
  const f = await fixture(t),
    completed = await f.store.commitToolExecutionCompletion(f.input),
    original = JSON.parse(stored(f.db));
  for (const state of [
    {
      ...original,
      result: {
        ...original.result,
        output: { ...original.result.output, digest: "0".repeat(64) },
      },
    },
    { ...original, providerReceiptId: "misbound" },
  ]) {
    f.db
      .prepare(
        "UPDATE tool_execution_receipts SET state_json=? WHERE receipt_id=?",
      )
      .run(JSON.stringify(state), f.locator.receiptId);
    await assert.rejects(f.store.loadToolExecutionReceipt(f.locator), {
      code: "stored_tool_receipt_invalid",
    });
    await assert.rejects(
      f.store.loadToolExecutionReceiptByAction({
        ...f.locator,
        actionDigest: completed.receipt.actionDigest,
      }),
      { code: "stored_tool_receipt_invalid" },
    );
  }
});
