import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadTranscriptWindowResponse } from "./thread-transcript-window-contract.ts";

const query = { position: null, limit: 2 } as const;
function response() {
  return {
    schemaVersion: "crewon.transcript-window.v0",
    messageWindow: {
      schemaVersion: "crewon.message-window.v0",
      threadId: "thread-1",
      threadRevision: 3,
      eventSequence: 3,
      headMessageSequence: 2,
      olderCursor: null,
      newerCursor: null,
      data: ["user", "assistant"].map((role, index) => ({
        messageId: `message-${index + 1}`,
        threadId: "thread-1",
        sequence: index + 1,
        role,
        content: "content",
        proposedPlan: null,
        createdAt: "2026-09-11T00:00:00Z",
      })),
    },
    runBindings: [
      { messageId: "message-1", runId: "run-1", source: "turnStartReceipt" },
      {
        messageId: "message-2",
        runId: "run-1",
        source: "messageCompletedEvent",
      },
    ],
  };
}

test("transcript window validates exact ordered bindings and isolates its returned value", () => {
  const input = response();
  const parsed = parseThreadTranscriptWindowResponse(input, "thread-1", query);
  assert.deepEqual(parsed, input);
  input.runBindings[0]!.runId = "changed";
  input.messageWindow.data[0]!.content = "changed";
  assert.equal(parsed.runBindings[0]?.runId, "run-1");
  assert.equal(parsed.messageWindow.data[0]?.content, "content");
});

test("transcript window rejects missing, misplaced, wrong-role and invented bindings", () => {
  const base = response();
  for (const runBindings of [
    [],
    base.runBindings.slice(0, 1),
    [...base.runBindings, base.runBindings[0]],
    [...base.runBindings].reverse(),
    [
      { ...base.runBindings[0], source: "messageCompletedEvent" },
      base.runBindings[1],
    ],
    [{ ...base.runBindings[0], source: "timestamp" }, base.runBindings[1]],
    [{ ...base.runBindings[0], source: "unassociated" }, base.runBindings[1]],
    [{ ...base.runBindings[0], runId: null }, base.runBindings[1]],
    [{ ...base.runBindings[0], unexpected: true }, base.runBindings[1]],
  ])
    assert.throws(() =>
      parseThreadTranscriptWindowResponse(
        { ...base, runBindings },
        "thread-1",
        query,
      ),
    );
  assert.throws(() =>
    parseThreadTranscriptWindowResponse(
      { ...base, extra: true },
      "thread-1",
      query,
    ),
  );
  assert.throws(() =>
    parseThreadTranscriptWindowResponse(base, "other-thread", query),
  );
  assert.throws(() =>
    parseThreadTranscriptWindowResponse(base, "thread-1", {
      ...query,
      position: { direction: "older", threadRevision: 2, messageSequence: 3 },
    }),
  );
});

test("legacy evidence absence is an explicit null rather than an inferred status", () => {
  const base = response();
  const runBindings = base.runBindings.map(({ messageId }) => ({
    messageId,
    runId: null,
    source: "unassociated",
  }));
  assert.deepEqual(
    parseThreadTranscriptWindowResponse(
      { ...base, runBindings },
      "thread-1",
      query,
    ).runBindings,
    runBindings,
  );
});
