import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationError, type MessageRecord } from "@crewon/application";
import type { ThreadView } from "@crewon/contracts";
import { withThreadListTitles } from "./thread-list-titles.ts";

function thread(
  threadId: string,
  overrides: Partial<ThreadView> = {},
): ThreadView {
  return {
    threadId,
    title: null,
    status: "active",
    revision: 3,
    lastMessageSequence: 2,
    forkedFromThreadId: null,
    forkedThroughHistorySequence: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}
function message(threadId: string, content = "首条任务\n材料"): MessageRecord {
  return {
    messageId: `message-${threadId}`,
    tenantId: "tenant",
    threadId,
    sequence: 1,
    role: "user",
    content,
    contentDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-09-01T00:00:00Z",
  };
}

test("fills historical list titles without changing authority, manual titles, ordering, timestamps or revisions", async () => {
  const original = [
    thread("old"),
    thread("renamed", { title: "My name" }),
    thread("empty", { lastMessageSequence: 0 }),
  ];
  const reads: string[] = [];
  const result = await withThreadListTitles(original, async (id) => {
    reads.push(id);
    return [message(id), { ...message(id, "后续任务"), sequence: 2 }];
  });
  assert.deepEqual(reads, ["old"]);
  assert.equal(result[0]?.displayTitle, "首条任务");
  assert.deepEqual(original, [
    thread("old"),
    thread("renamed", { title: "My name" }),
    thread("empty", { lastMessageSequence: 0 }),
  ]);
  assert.deepEqual(
    result.map(({ displayTitle: _, ...head }) => head),
    original,
  );
});

test("bounds concurrency and does not leak a denied, deleted or cross-thread preview", async () => {
  let active = 0,
    peak = 0;
  const result = await withThreadListTitles(
    Array.from({ length: 20 }, (_, i) => thread(String(i))),
    async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (id === "0") throw new ApplicationError("authorization", "denied");
      if (id === "1") throw new ApplicationError("notFound", "deleted");
      return [message(id)];
    },
  );
  assert.ok(peak <= 4);
  assert.equal(result[0]?.displayTitle, undefined);
  assert.equal(result[1]?.displayTitle, undefined);
  assert.equal(result[2]?.displayTitle, "首条任务");
  await assert.rejects(
    withThreadListTitles([thread("a")], async () => [message("b")]),
    /identity_invalid/u,
  );
  await assert.rejects(
    withThreadListTitles([thread("a")], async () => {
      throw new Error("store failed");
    }),
    /store failed/u,
  );
});
