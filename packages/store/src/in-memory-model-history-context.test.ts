import assert from "node:assert/strict";
import test from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import { InMemoryModelHistoryContextStore } from "./in-memory-model-history-context.ts";
import {
  locator,
  message,
  compaction,
  rollback,
  assertReplay,
  readWindow,
} from "./model-history-context.test-support.ts";
import { toolHistory } from "./model-history-append.test-support.ts";

test("Memory context references match canonical replay across compaction, tool pairs and repeated rollbacks", async () => {
  const history: ModelHistoryItem[] = [];
  const store = new InMemoryModelHistoryContextStore((query) =>
    query.tenantId === locator.tenantId && query.threadId === locator.threadId
      ? history
      : null,
  );
  const append = async (...items: ModelHistoryItem[]) => {
    history.push(...items);
    await assertReplay(store, history);
  };
  await append(message(1), message(2, "assistant"), compaction(3, 2));
  await append(message(4, "user", "goal_steering"), message(5));
  await append(
    toolHistory(6, "call", "tool_call", "run-store-1"),
    toolHistory(7, "call", "tool_result", "run-store-1"),
  );
  await append(message(8, "assistant"), compaction(9, 7));
  await append(rollback(history, 1));
  assert.equal(
    (await store.prepare(locator)).context?.lastCompaction?.sequence,
    3,
  );
  await append(message(11), compaction(12, 3));
  await append(rollback(history, 2));
  await append(rollback(history, 3));
  await append(
    message(15),
    message(16, "assistant"),
    compaction(17, 16),
    message(18),
  );
  const state = (await store.prepare(locator)).context!;
  const first = (await store.listItems(locator, state.checkpoint, 0, 100))[0]!;
  assert.equal(first.type, "message");
  if (first.type === "message") first.content = "mutated by caller";
  await assertReplay(store, history);
  await assert.rejects(
    store.listItems(
      { ...locator, tenantId: "other" },
      state.checkpoint,
      0,
      100,
    ),
    /model_history_context_changed/,
  );
});

test("Memory context reads skip 20,000 compacted bodies and fence concurrent appends", async (context) => {
  const history = Array.from({ length: 20_000 }, (_, index) =>
    message(index + 1),
  );
  history.push(compaction(20_001, 20_000), message(20_002));
  const accessed: number[] = [];
  const observed = new Proxy(history, {
    get(target, key) {
      if (typeof key === "string" && /^\d+$/.test(key))
        accessed.push(Number(key));
      return Reflect.get(target, key);
    },
  });
  const store = new InMemoryModelHistoryContextStore(() => observed);
  assert.equal((await store.prepare(locator)).processedThroughSequence, 100);
  await assertReplay(store, history);
  accessed.length = 0;
  const result = await readWindow(store);
  assert.equal(result.items.length, 1);
  assert.ok(accessed.length <= 10);
  assert.ok(accessed.every((index) => index >= 20_000));
  context.diagnostic(
    `20,002 canonical records: ${accessed.length} direct item reads after warmup; no compacted body read`,
  );
  history.push(message(20_003));
  await assert.rejects(
    store.listItems(locator, result.state.checkpoint, 0, 100),
    /model_history_context_changed/,
  );
  await assertReplay(store, history);
});

test("Memory context drops incomplete derived state when an old rollback is invalid", async () => {
  const history = [message(1), message(2, "assistant"), message(3)];
  const marker = rollback(history, 1);
  history.push({ ...marker, historyFromSequence: 2 });
  const store = new InMemoryModelHistoryContextStore(() => history);
  await assert.rejects(
    store.prepare(locator),
    /model_history_rollback_boundary_mismatch/,
  );
  history[3] = marker;
  await assertReplay(store, history);
});
