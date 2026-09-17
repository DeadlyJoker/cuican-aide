import assert from "node:assert/strict";
import test from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import { toolHistory } from "./model-history-append.test-support.ts";
import { outputFixture } from "./run-output-store-conformance.test-support.ts";
import { InMemoryModelHistoryAppendIndex } from "./in-memory-model-history-append.ts";
import { validateModelHistoryAppend } from "./store-invariants.ts";
import { RunStoreError } from "@crewon/application";
import { createHash } from "node:crypto";
import { appendMessageCommit } from "./thread-store-conformance.test-support.ts";

const locator = { tenantId: "tenant-1", threadId: "thread-1" };

test("InMemory appends after 100,000 items without iterating the canonical history", async (context) => {
  const fixture = await outputFixture(
    context,
    (clock) => new InMemoryRunStore({ clock }),
  );
  const lease = fixture.input([1], 2, "unused").lease;
  let revision = 2;
  let head = 0;
  const append = async (items: ModelHistoryItem[]) => {
    const event = fixture.input([head + 1], revision, "unused").entries[0]!
      .event;
    const result = await fixture.store.commitLeasedRun({
      lease,
      commit: {
        tenantId: "tenant-1",
        expectedRevision: revision,
        idempotency: {
          scope: "history-cost",
          key: String(head),
          requestFingerprint: String(head),
        },
        events: [{ ...event, sequence: revision + 1 }],
        outbox: [],
        workItems: [],
      },
      history: { expectedLastSequence: head, items },
    });
    revision = result.state.revision;
    head += items.length;
    return result;
  };
  const initial = Array.from({ length: 100_000 }, (_, index) =>
    toolHistory(
      index + 1,
      `old-${Math.floor(index / 2)}`,
      index % 2 === 0 ? "tool_call" : "tool_result",
      "run-store-1",
    ),
  );
  const wanted = createHash("sha256");
  for (const item of initial) wanted.update(JSON.stringify(item) + "\n");
  await append(initial);
  const originalIterator = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function (this: unknown[]) {
    if (
      this.length >= 100_000 &&
      (this[0] as ModelHistoryItem | undefined)?.schemaVersion ===
        "crewon.model-history-item.v0"
    )
      throw new Error("unbounded_canonical_history_iteration");
    return originalIterator.call(this);
  };
  const next = [
    toolHistory(100_001, "new", "tool_call", "run-store-1"),
    toolHistory(100_002, "new", "tool_result", "run-store-1"),
  ];
  try {
    await append(next);
  } finally {
    Array.prototype[Symbol.iterator] = originalIterator;
  }
  assert.deepEqual(
    await fixture.store.listModelHistoryItems(
      { tenantId: "tenant-1", threadId: "thread-1" },
      100_000,
      100,
    ),
    next,
  );
  assert.equal(
    (
      await fixture.store.loadModelHistoryHead({
        tenantId: "tenant-1",
        threadId: "thread-1",
      })
    )?.lastSequence,
    100_002,
  );
  const actual = createHash("sha256");
  for (let after = 0; after < 100_000; after += 100) {
    const page = await fixture.store.listModelHistoryItems(locator, after, 100);
    assert.equal(page.length, 100);
    for (const item of page) actual.update(JSON.stringify(item) + "\n");
  }
  assert.equal(
    actual.digest("hex"),
    wanted.digest("hex"),
    "all original model-visible history remains byte-identical",
  );
});

test("InMemory pairing decisions preserve full validation errors and validation never changes state", () => {
  const history: ModelHistoryItem[] = [];
  const index = new InMemoryModelHistoryAppendIndex(() => history);
  const ids = new Set<string>();
  const append = (items: ModelHistoryItem[]) => {
    const input = { expectedLastSequence: history.length, items };
    index.validate(input, locator, (id) => ids.has(id));
    history.push(...structuredClone(items));
    index.committed(items);
    for (const item of items) ids.add(item.itemId);
  };
  const error = (operation: () => void) => {
    try {
      operation();
      return null;
    } catch (value) {
      assert.ok(value instanceof RunStoreError);
      return value.code;
    }
  };
  for (let round = 0; round < 50; round++) {
    const n = history.length + 1;
    const call = `call-${round}`;
    append([toolHistory(n, call, "tool_call")]);
    const result = toolHistory(n + 1, call, "tool_result");
    const candidates = [
      [result],
      [
        {
          ...appendMessageCommit(1, 2).history.items[0]!,
          sequence: n + 1,
          itemId: `boundary-${n}`,
        },
      ],
      [toolHistory(n + 1, call, "tool_call")],
      [toolHistory(n + 1, "absent", "tool_result")],
      [{ ...result, segmentId: "other" }],
      [{ ...result, runId: "other" }],
      [{ ...result, tenantId: "other" }],
      [{ ...result, sequence: n + 3 }],
      [result, { ...result, itemId: "second-result", sequence: n + 2 }],
      [null as unknown as ModelHistoryItem],
    ];
    const before = index.state(locator, [result]);
    for (const items of candidates) {
      const input = { expectedLastSequence: history.length, items };
      const expected = error(() =>
        validateModelHistoryAppend(input, locator, history, (id) =>
          ids.has(id),
        ),
      );
      assert.equal(
        error(() => index.validate(input, locator, (id) => ids.has(id))),
        expected,
      );
      assert.deepEqual(index.state(locator, [result]), before);
    }
    append([result]);
    const duplicate = {
      expectedLastSequence: history.length,
      items: [toolHistory(n + 2, call, "tool_call")],
    };
    assert.throws(
      () => index.validate(duplicate, locator, (id) => ids.has(id)),
      code("model_history_tool_call_duplicate"),
    );
  }
});

test("InMemory head and tool lookups stay bounded, retain no bodies, and reject stale or cross-tenant indexes", () => {
  const history = Array.from({ length: 20_000 }, (_, n) =>
    toolHistory(
      n + 1,
      `call-${Math.floor(n / 2)}`,
      n % 2 === 0 ? "tool_call" : "tool_result",
    ),
  );
  let reads = 0;
  const bounded = new Proxy(history, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      if (key === Symbol.iterator) throw new Error("history_scan");
      return Reflect.get(target, key, receiver);
    },
  });
  const index = new InMemoryModelHistoryAppendIndex(() => bounded);
  index.committed(history);
  const state = index.state(locator, [
    toolHistory(20_001, "call-0", "tool_result"),
  ]);
  assert.ok(reads <= 2);
  assert.equal(state.referencedToolCalls.size, 1);
  assert.equal(state.pendingToolCallCount, 0);
  assert.deepEqual([...state.referencedToolCalls.values()][0], {
    runId: "run-1",
    callId: "call-0",
    segmentId: "segment-1",
    kind: "function",
    completed: true,
  });
  assert.throws(
    () => index.state({ ...locator, tenantId: "other" }, []),
    code("model_history_append_state_stale"),
  );
  history.push(toolHistory(20_001, "uncommitted", "tool_call"));
  assert.throws(
    () => index.state(locator, []),
    code("model_history_append_state_stale"),
  );
});

test("InMemory failed commits and exact replays do not advance pairing state", async (context) => {
  const fixture = await outputFixture(
    context,
    (clock) => new InMemoryRunStore({ clock }),
  );
  const base = fixture.input([1], 2, "append");
  const call = toolHistory(1, "atomic", "tool_call", "run-store-1");
  const input = {
    lease: base.lease,
    commit: {
      tenantId: "tenant-1",
      expectedRevision: 2,
      idempotency: {
        scope: "atomic-history",
        key: "one",
        requestFingerprint: "one",
      },
      events: [{ ...base.entries[0]!.event, sequence: 3 }],
      outbox: [],
      workItems: [],
    },
    history: { expectedLastSequence: 0, items: [call] },
  };
  await assert.rejects(
    fixture.store.commitLeasedRun({
      ...input,
      commit: {
        ...input.commit,
        outbox: [
          {
            messageId: "invalid-after-history-validation",
            topic: "",
            createdAt: call.createdAt,
            tenantId: "tenant-1",
            runId: "run-store-1",
            payload: {},
          },
        ],
      },
    }),
    code("outbox_topic_invalid"),
  );
  assert.equal(
    (await fixture.store.loadModelHistoryHead(locator))?.lastSequence,
    0,
  );
  const committed = await fixture.store.commitLeasedRun(input);
  assert.deepEqual(await fixture.store.commitLeasedRun(input), {
    ...committed,
    disposition: "replayed",
  });
  const finish = fixture.input([2], 3, "finish");
  await fixture.store.commitLeasedRun({
    lease: base.lease,
    commit: {
      ...input.commit,
      expectedRevision: 3,
      idempotency: { ...input.commit.idempotency, key: "two" },
      events: [{ ...finish.entries[0]!.event, sequence: 4 }],
    },
    history: {
      expectedLastSequence: 1,
      items: [toolHistory(2, "atomic", "tool_result", "run-store-1")],
    },
  });
  assert.equal(
    (await fixture.store.loadModelHistoryHead(locator))?.lastSequence,
    2,
  );
  assert.deepEqual(await fixture.store.listModelHistoryItems(locator, 0, 10), [
    call,
    toolHistory(2, "atomic", "tool_result", "run-store-1"),
  ]);
});

function code(expected: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === expected;
}
