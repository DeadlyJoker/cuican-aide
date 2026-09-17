import assert from "node:assert/strict";
import test from "node:test";
import {
  AutomationStoreError,
  type AutomationDefinitionRecord,
  type ScheduledAutomationListQuery,
} from "@crewon/application";
import { InMemoryRunStore } from "./in-memory-run-store.ts";
import {
  InMemoryAutomationAuthority,
  type InMemoryAutomationState,
} from "./in-memory-automation-authority.ts";
import { InMemoryAutomationScheduleIndex } from "./in-memory-automation-schedule-index.ts";
import {
  automationApplicationService,
  automationCreateCommand,
  seedAutomationThread,
} from "./automation-store-conformance.test-support.ts";
import {
  automationActor,
  scheduleRecord,
  scheduleCursor,
  expectedScheduledPage,
  invalidScheduleQueries,
  assertScheduledInsertionOrder,
} from "./scheduled-automation.test-support.ts";

test("InMemory warm scheduled reads inspect only page records after 20,000 definitions", async () => {
  const store = new InMemoryRunStore();
  await seedAutomationThread(store);
  const base = await automationApplicationService(store).createAutomation(
    automationActor,
    automationCreateCommand(),
  );
  const records = Array.from({ length: 20_000 }, (_, index) =>
    scheduleRecord(base.record, index + 1),
  );
  class ObservedMap extends Map<string, AutomationDefinitionRecord> {
    enumerations = 0;
    gets = 0;
    override values() {
      this.enumerations += 1;
      return super.values();
    }
    override get(key: string) {
      this.gets += 1;
      return super.get(key);
    }
  }
  const automations = new ObservedMap(
    records.map((record) => [record.definition.automationId, record]),
  );
  const authority = new InMemoryAutomationAuthority(readState(automations));
  assert.equal(automations.enumerations, 1);
  automations.enumerations = 0;
  for (const before of [
    null,
    scheduleCursor(records[4999]!),
    scheduleCursor(records[100]!),
  ] as const) {
    const page = await authority.listScheduled({ before, limit: 37 });
    assert.deepEqual(page, expectedScheduledPage(records, before, 37));
    const first = page[0]!;
    (first.definition as { prompt: string }).prompt = "caller mutation";
  }
  assert.equal(automations.enumerations, 0);
  assert.equal(automations.gets, 111);
  for (const query of invalidScheduleQueries)
    await assert.rejects(
      authority.listScheduled(query as ScheduledAutomationListQuery),
      AutomationStoreError,
    );
  assert.equal(automations.gets, 111);
  const key = records.at(-1)!.definition.automationId;
  automations.set(key, {
    ...automations.get(key)!,
    definitionDigest: `sha256:${"0".repeat(64)}`,
  });
  await assert.rejects(
    authority.listScheduled({ before: null, limit: 1 }),
    AutomationStoreError,
  );
});

test("InMemory keeps scheduled insertion and receipt replay ordered across punctuation and case", async () => {
  const store = new InMemoryRunStore();
  await seedAutomationThread(store);
  await assertScheduledInsertionOrder(store);
});

test("ordered schedule keys handle ascending, descending and alternating insertions without retaining definitions", () => {
  const keys = Array.from({ length: 20_000 }, (_, index) => ({
    updatedAt: "2026-08-09T00:00:00Z",
    automationId: `automation-${String(index).padStart(6, "0")}`,
    prompt: "must not become index payload",
  }));
  for (const entries of [
    keys,
    [...keys].reverse(),
    keys
      .filter((_, i) => i % 2 === 0)
      .concat(keys.filter((_, i) => i % 2 === 1)),
  ]) {
    const index = new InMemoryAutomationScheduleIndex();
    for (const key of entries) index.insert(key);
    for (const offset of [0, 1, 500, 10_000, 19_999]) {
      const before = keys[offset]!;
      assert.deepEqual(
        index.list(before, 37),
        keys
          .slice(Math.max(0, offset - 37), offset)
          .reverse()
          .map(({ automationId, updatedAt }) => ({ automationId, updatedAt })),
      );
    }
    assert.equal(index.list(null, 100).length, 100);
    assert.deepEqual(Object.keys(index.list(null, 1)[0]!).sort(), [
      "automationId",
      "updatedAt",
    ]);
  }
});

function readState(
  automations: Map<string, AutomationDefinitionRecord>,
): InMemoryAutomationState {
  return {
    automations,
    createReceipts: new Map(),
    invocationReceipts: new Map(),
    pendingProviderSettings: new Map(),
    runs: new Map(),
    runEvents: new Map(),
    runEventIds: new Set(),
    threads: new Map(),
    threadEvents: new Map(),
    threadEventIds: new Set(),
    messages: new Map(),
    messageIds: new Set(),
    modelHistory: new Map(),
    modelHistoryItemIds: new Set(),
    modelHistoryAppendState: () => {
      throw new Error("unexpected history append in read fixture");
    },
    outbox: new Map(),
    retiredOutboxIds: new Set(),
    outboxReplayAuthority: new Map(),
    workItems: new Map(),
    appendModelHistory: () => {
      throw new Error("unexpected write in read fixture");
    },
  };
}
