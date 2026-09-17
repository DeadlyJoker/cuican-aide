import assert from "node:assert/strict";
import test from "node:test";
import type { ModelHistoryItem } from "@crewon/domain";
import { RunStoreError } from "@crewon/application";
import {
  historyToolCallKey,
  validateModelHistoryIncrementalAppend,
  type StoredHistoryToolCall,
} from "./model-history-append-validation.ts";
import { validateModelHistoryAppend } from "./store-invariants.ts";
import { toolHistory } from "./model-history-append.test-support.ts";

const locator = { tenantId: "tenant-1", threadId: "thread-1" };

test("incremental append decisions match full pairing validation across long history, open calls and invalid continuations", () => {
  const histories: ModelHistoryItem[][] = [
    [],
    [toolHistory(1, "pending", "tool_call")],
  ];
  const long = Array.from({ length: 20_000 }, (_, index) =>
    toolHistory(
      index + 1,
      `call-${Math.floor(index / 2)}`,
      index % 2 === 0 ? "tool_call" : "tool_result",
    ),
  );
  histories.push(long, [
    ...long,
    toolHistory(long.length + 1, "pending", "tool_call"),
  ]);
  for (const history of histories) {
    const next = history.length + 1;
    const message: ModelHistoryItem = {
      schemaVersion: "crewon.model-history-item.v0",
      ...locator,
      itemId: `history-${next}`,
      sequence: next,
      runId: null,
      segmentId: null,
      createdAt: "2026-08-08T00:00:00Z",
      type: "message",
      source: "thread_message",
      role: "user",
      content: "continue",
      contentDigest: `sha256:${"a".repeat(64)}`,
    };
    const cases: ModelHistoryItem[][] = [
      [],
      [message],
      [toolHistory(next, "pending", "tool_result")],
      [
        toolHistory(next, "new", "tool_call"),
        toolHistory(next + 1, "new", "tool_result"),
      ],
      [
        toolHistory(next, "new", "tool_call"),
        toolHistory(next + 1, "new", "tool_call"),
      ],
      [toolHistory(next, "missing", "tool_result")],
      [toolHistory(next, "call-0", "tool_call")],
      [
        toolHistory(next, "pending", "tool_result"),
        toolHistory(next + 1, "pending", "tool_result"),
      ],
      [{ ...toolHistory(next, "pending", "tool_result"), segmentId: "wrong" }],
      [
        {
          ...toolHistory(next, "pending", "tool_result"),
          kind: "custom",
        } as ModelHistoryItem,
      ],
      [toolHistory(next, "pending", "tool_result", "wrong-run")],
    ];
    const allCalls = new Map<string, StoredHistoryToolCall>();
    for (const item of history) {
      if (item.type === "tool_call")
        allCalls.set(historyToolCallKey(item.runId, item.callId), {
          runId: item.runId!,
          segmentId: item.segmentId!,
          callId: item.callId,
          kind: item.kind,
          completed: false,
        });
      else if (item.type === "tool_result") {
        const key = historyToolCallKey(item.runId, item.callId);
        allCalls.set(key, { ...allCalls.get(key)!, completed: true });
      }
    }
    for (const items of cases) {
      const append = { expectedLastSequence: history.length, items };
      const wanted = new Set(
        items.flatMap((item) =>
          item.type === "tool_call" || item.type === "tool_result"
            ? [historyToolCallKey(item.runId, item.callId)]
            : [],
        ),
      );
      const referencedToolCalls = new Map(
        [...allCalls].filter(([key]) => wanted.has(key)),
      );
      const old = outcome(() =>
        validateModelHistoryAppend(append, locator, history, () => false),
      );
      const incremental = outcome(() =>
        validateModelHistoryIncrementalAppend(
          append,
          locator,
          {
            lastSequence: history.length,
            pendingToolCallCount: [...allCalls.values()].filter(
              (call) => !call.completed,
            ).length,
            referencedToolCalls,
          },
          () => false,
        ),
      );
      assert.equal(
        incremental,
        old,
        `history=${history.length}; items=${JSON.stringify(items)}`,
      );
    }
  }
});

function outcome(operation: () => unknown): string {
  try {
    operation();
    return "valid";
  } catch (error) {
    if (error instanceof RunStoreError) return error.code;
    throw error;
  }
}
