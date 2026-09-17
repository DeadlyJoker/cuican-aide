import assert from "node:assert/strict";
import test from "node:test";
import {
  formatThreadMessageWindowCursor,
  parseThreadMessageWindowQuery,
  parseThreadMessageWindowResponse,
} from "./thread-message-window-contract.ts";

const threadId = "thread-1";
const position = {
  direction: "older" as const,
  messageSequence: 3,
  threadRevision: 4,
};
const message = (sequence: number) => ({
  messageId: `message-${sequence}`,
  threadId,
  sequence,
  role: "user",
  content: `message ${sequence}`,
  proposedPlan: null,
  createdAt: "2026-09-10T00:00:00Z",
});
const response = () => ({
  schemaVersion: "crewon.message-window.v0",
  threadId,
  threadRevision: 4,
  eventSequence: 4,
  headMessageSequence: 3,
  data: [message(1), message(2)],
  olderCursor: null,
  newerCursor: formatThreadMessageWindowCursor(threadId, {
    ...position,
    direction: "newer",
    messageSequence: 2,
  }),
});

test("message window cursors are canonical, thread-bound and separate from forward message cursors", () => {
  const cursor = formatThreadMessageWindowCursor(threadId, position);
  assert.deepEqual(
    parseThreadMessageWindowQuery({ cursor, limit: "2" }, threadId),
    { position, limit: 2 },
  );
  assert.deepEqual(parseThreadMessageWindowQuery({}, threadId), {
    position: null,
    limit: 100,
  });
  for (const input of [
    { cursor: cursor + "=" },
    { cursor: "bnVsbA" },
    { cursor: "%%%" },
    { view: "audit" },
    { limit: 101 },
    { limit: "01" },
    { limit: -1 },
    { cursor: "x".repeat(2049) },
  ])
    assert.throws(() => parseThreadMessageWindowQuery(input, threadId));
  assert.throws(
    () => parseThreadMessageWindowQuery({ cursor }, "another-thread"),
    /message_window_cursor_invalid/,
  );
  const unicodeThread = "线程甲";
  assert.deepEqual(
    parseThreadMessageWindowQuery(
      { cursor: formatThreadMessageWindowCursor(unicodeThread, position) },
      unicodeThread,
    ).position,
    position,
  );
});

test("message window responses verify order, boundary, version, roles and both navigation edges", () => {
  const query = { position, limit: 2 };
  const value = response();
  assert.deepEqual(
    parseThreadMessageWindowResponse(value, threadId, query),
    value,
  );
  const variants = [
    { ...value, schemaVersion: "unknown" },
    { ...value, threadId: "other" },
    { ...value, threadRevision: 5 },
    { ...value, eventSequence: 99 },
    { ...value, headMessageSequence: 1 },
    { ...value, extra: "unexpected" },
    { ...value, data: [message(2), message(1)] },
    { ...value, data: [message(1), message(1)] },
    { ...value, data: [message(3)] },
    { ...value, data: [message(1), message(2), message(3)] },
    { ...value, data: [{ ...message(1), invalidation: {} }] },
    { ...value, data: [{ ...message(1), role: "developer" }] },
    { ...value, newerCursor: undefined },
    {
      ...value,
      newerCursor: formatThreadMessageWindowCursor(threadId, {
        ...position,
        direction: "newer",
        messageSequence: 1,
      }),
    },
    {
      ...value,
      olderCursor: formatThreadMessageWindowCursor(threadId, {
        ...position,
        direction: "newer",
        messageSequence: 1,
      }),
    },
  ];
  for (const variant of variants)
    assert.throws(() =>
      parseThreadMessageWindowResponse(variant, threadId, query),
    );
  const tool = {
    ...value,
    data: [{ ...message(1), role: "tool" }],
    newerCursor: null,
  };
  assert.deepEqual(
    parseThreadMessageWindowResponse(tool, threadId, query),
    tool,
  );
});

test("message window rejects mismatched proposed Plan provenance and clones accepted data", () => {
  const value = response();
  const planned = {
    ...message(2),
    role: "assistant",
    content: "Plan",
    proposedPlan: {
      schemaVersion: "crewon.proposed-plan.v0",
      planId: "plan",
      threadId,
      runId: "run",
      messageId: "message-2",
      content: "Plan",
      createdAt: "2026-09-10T00:00:00Z",
    },
  };
  const query = { position, limit: 2 };
  const accepted = { ...value, data: [planned] };
  assert.deepEqual(
    parseThreadMessageWindowResponse(accepted, threadId, query),
    accepted,
  );
  for (const wrong of [
    { threadId: "other" },
    { messageId: "other" },
    { content: "Different" },
    { runId: "" },
    { schemaVersion: "future" },
  ])
    assert.throws(() =>
      parseThreadMessageWindowResponse(
        {
          ...accepted,
          data: [
            { ...planned, proposedPlan: { ...planned.proposedPlan, ...wrong } },
          ],
        },
        threadId,
        query,
      ),
    );
  const parsed = parseThreadMessageWindowResponse(value, threadId, query);
  value.data[0]!.content = "mutated";
  assert.equal(parsed.data[0]!.content, "message 1");
});
