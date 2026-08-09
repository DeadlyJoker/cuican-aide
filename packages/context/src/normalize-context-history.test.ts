import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ContextHistoryError,
  boundedContextTail,
  normalizeContextHistory,
  type ContextHistoryItem,
  type ContextHistoryRepair,
} from "./normalize-context-history.ts";

const reference = JSON.parse(
  readFileSync(
    new URL(
      "../../test-contracts/fixtures/context-normalization.reference.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Readonly<{
  cases: readonly Readonly<{
    name: string;
    input: readonly ContextHistoryItem[];
    expected: readonly ContextHistoryItem[];
    repairs: readonly ContextHistoryRepair[];
  }>[];
}>;

for (const fixture of reference.cases) {
  test(`matches AR-028: ${fixture.name}`, () => {
    const normalized = normalizeContextHistory(fixture.input);

    assert.deepEqual(normalized.items, fixture.expected);
    assert.deepEqual(normalized.repairs, fixture.repairs);
    assert.equal(normalized.historyRewritten, fixture.repairs.length > 0);
    if (fixture.repairs.length === 0) {
      assert.equal(normalized.items, fixture.input);
    }
  });
}

test("fails closed on duplicate call IDs and bounded output overflow", () => {
  const call = {
    type: "tool_call" as const,
    kind: "function" as const,
    callId: "duplicate",
    name: "read_file",
    input: "{}",
  };
  assert.throws(
    () => normalizeContextHistory([call, call]),
    hasContextCode("context_tool_call_duplicate"),
  );
  assert.throws(
    () =>
      normalizeContextHistory([
        {
          type: "tool_result",
          kind: "function",
          callId: "too-large",
          output: "x".repeat(40_001),
        },
      ]),
    hasContextCode("context_tool_result_invalid"),
  );
});

test("bounds an oversized compaction request without leaving an orphan Tool result", () => {
  const bounded = boundedContextTail(
    [
      { type: "message", role: "user", content: "old" },
      {
        type: "tool_call",
        kind: "function",
        callId: "cut-call",
        name: "read_file",
        input: "{}",
      },
      {
        type: "tool_result",
        kind: "function",
        callId: "cut-call",
        output: "result",
      },
      { type: "message", role: "user", content: "new" },
    ],
    3,
  );

  assert.deepEqual(bounded.items, [
    { type: "message", role: "user", content: "new" },
  ]);
  assert.deepEqual(bounded.repairs, [
    {
      kind: "orphanToolResultDropped",
      toolKind: "function",
      callId: "cut-call",
    },
  ]);
  assert.equal(bounded.historyRewritten, true);
});

test("reserves byte budget for a repaired Tool result", () => {
  const bounded = boundedContextTail(
    [
      { type: "message", role: "user", content: "discard me" },
      {
        type: "tool_call",
        kind: "function",
        callId: "unfinished",
        name: "read_file",
        input: "{}",
      },
    ],
    3,
    9,
  );

  assert.deepEqual(bounded.items, [
    {
      type: "tool_call",
      kind: "function",
      callId: "unfinished",
      name: "read_file",
      input: "{}",
    },
    {
      type: "tool_result",
      kind: "function",
      callId: "unfinished",
      output: "aborted",
    },
  ]);
  assert.equal(bounded.byteLength, 9);
});

function hasContextCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ContextHistoryError && error.code === code;
}
