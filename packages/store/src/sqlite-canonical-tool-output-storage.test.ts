import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createToolResultFixture } from "./sqlite-tool-result.test-support.ts";
import { stableJson } from "./store-invariants.ts";
import { SQLITE_SCHEMA_VERSION } from "./sqlite-schema.ts";
import {
  assertReplay,
  locator,
  readWindow,
} from "./model-history-context.test-support.ts";

test("canonical tool storage reopens, replays and rebuilds context with exact original hashes", async (t) => {
  const f = await createToolResultFixture(t);
  const committed = await f.store.commitToolExecutionCompletion(f.input);
  const item = f.input.history.items[0]!,
    event = f.input.commit.events[0]!;
  const history = await f.store.listModelHistoryItems(locator, 0, 100);
  const read = () =>
    f.db
      .prepare("SELECT item_json FROM model_history_items WHERE item_id=?")
      .get(item.itemId)!.item_json as string;
  const eventJson = f.db
    .prepare("SELECT event_json FROM run_events WHERE event_id=?")
    .get(event.eventId)!.event_json as string;
  assert.equal(typeof JSON.parse(read()).output, "object");
  assert.equal(typeof JSON.parse(eventJson).data.output, "object");
  await assertReplay(f.store.modelHistoryContext, history);
  const before = await readWindow(f.store.modelHistoryContext);
  const digest = f.db
    .prepare(
      "SELECT item_digest FROM model_history_context_refs WHERE item_id=?",
    )
    .get(item.itemId)!.item_digest;
  assert.equal(
    digest,
    createHash("sha256").update(stableJson(item)).digest("hex"),
  );
  await f.reopen();
  assert.deepEqual(await readWindow(f.store.modelHistoryContext), before);
  const replay = await f.store.commitToolExecutionCompletion(f.input);
  assert.equal(replay.run.disposition, "replayed");
  assert.deepEqual(replay.receipt, committed.receipt);
  assert.deepEqual(
    (await f.store.listRunEvents(f.locator, 0, 100)).at(-1),
    event,
  );
  // Only the derived projection is discarded; source records are never rewritten.
  f.db.exec(
    "DELETE FROM model_history_context_refs; DELETE FROM model_history_context_state;",
  );
  await f.reopen();
  const rebuilt = await readWindow(f.store.modelHistoryContext);
  assert.deepEqual(rebuilt.items, before.items);
  // A rebuild deliberately issues a fresh cursor generation; content digests stay unchanged.
  assert.notEqual(
    rebuilt.state.checkpoint.fingerprint,
    before.state.checkpoint.fingerprint,
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT item_digest FROM model_history_context_refs WHERE item_id=?",
      )
      .get(item.itemId)!.item_digest,
    digest,
  );
});

test("schema 43 upgrade keeps legacy canonical JSON unchanged and preserves receipt replay", async (t) => {
  const f = await createToolResultFixture(t);
  await f.store.commitToolExecutionCompletion(f.input);
  const item = f.input.history.items[0]!,
    event = f.input.commit.events[0]!;
  await f.store.close();
  f.db
    .prepare("UPDATE model_history_items SET item_json=? WHERE item_id=?")
    .run(stableJson(item), item.itemId);
  f.db
    .prepare("UPDATE run_events SET event_json=? WHERE event_id=?")
    .run(stableJson(event), event.eventId);
  f.db.exec("PRAGMA user_version=43");
  await f.reopen();
  assert.equal(
    f.db.prepare("PRAGMA user_version").get()!.user_version,
    SQLITE_SCHEMA_VERSION,
  );
  assert.equal(
    f.db
      .prepare("SELECT item_json FROM model_history_items WHERE item_id=?")
      .get(item.itemId)!.item_json,
    stableJson(item),
  );
  assert.equal(
    f.db
      .prepare("SELECT event_json FROM run_events WHERE event_id=?")
      .get(event.eventId)!.event_json,
    stableJson(event),
  );
  assert.deepEqual(
    (await readWindow(f.store.modelHistoryContext)).items.at(-1),
    item,
  );
  assert.deepEqual(
    (await f.store.listRunEvents(f.locator, 0, 100)).at(-1),
    event,
  );
  assert.equal(
    (await f.store.commitToolExecutionCompletion(f.input)).run.disposition,
    "replayed",
  );
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("corrupt encoded canonical history is rejected by history paging and cold context rebuild", async (t) => {
  const f = await createToolResultFixture(t);
  await f.store.commitToolExecutionCompletion(f.input);
  const item = f.input.history.items[0]!;
  f.db
    .prepare(
      "UPDATE model_history_items SET item_json=json_set(item_json,'$.output.digest',?) WHERE item_id=?",
    )
    .run("0".repeat(64), item.itemId);
  await f.reopen();
  await assert.rejects(f.store.listModelHistoryItems(locator, 0, 100), {
    code: "stored_model_history_item_invalid",
  });
  await assert.rejects(readWindow(f.store.modelHistoryContext));
});

test("corrupt or transplanted canonical event output fails after reopen", async (t) => {
  const f = await createToolResultFixture(t);
  await f.store.commitToolExecutionCompletion(f.input);
  const event = f.input.commit.events[0]!;
  f.db
    .prepare(
      "UPDATE run_events SET event_json=json_set(event_json,'$.data.callId',?) WHERE event_id=?",
    )
    .run("other-call", event.eventId);
  await f.reopen();
  await assert.rejects(f.store.listRunEvents(f.locator, 0, 100), {
    code: "stored_event_invalid",
  });
});
