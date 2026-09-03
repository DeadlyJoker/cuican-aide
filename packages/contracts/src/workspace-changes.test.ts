import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKSPACE_CHANGE_PATHS,
  parseThreadTaskChangeLedgerResponse,
  parseWorkspaceChangeSummary,
} from "./workspace-changes.ts";

test("parses a canonical bounded workspace change ledger", () => {
  const value = {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["README.md", "src/task.ts"],
    additions: 12,
    deletions: 3,
    statsComplete: true,
  };

  assert.deepEqual(parseWorkspaceChangeSummary(value), value);
  assert.deepEqual(
    parseWorkspaceChangeSummary({
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    }),
    {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
  );
});

test("parses only exact revision-bound Thread task change ledgers", () => {
  const valid = {
    schemaVersion: "crewon.thread-task-change-ledger.v0",
    threadId: "thread-1",
    threadRevision: 7,
    historySequence: 41,
    complete: true,
    summary: {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: ["src/task.ts"],
      additions: 4,
      deletions: 2,
      statsComplete: true,
    },
    eventCount: 2,
    includedRunIds: ["run-1"],
  };
  assert.deepEqual(parseThreadTaskChangeLedgerResponse(valid), valid);

  const incomplete = {
    ...valid,
    complete: false,
    summary: {
      schemaVersion: "crewon.workspace-change-summary.v0",
      paths: [],
      additions: 0,
      deletions: 0,
      statsComplete: false,
    },
    eventCount: 0,
    includedRunIds: [],
  };
  assert.deepEqual(parseThreadTaskChangeLedgerResponse(incomplete), incomplete);

  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, threadRevision: 0 },
    { ...valid, historySequence: -1 },
    { ...valid, complete: false },
    { ...valid, eventCount: 1 },
    { ...incomplete, eventCount: 2 },
    { ...incomplete, includedRunIds: ["run-1"] },
    { ...valid, includedRunIds: ["run-1", "run-1"] },
  ]) {
    assert.throws(
      () => parseThreadTaskChangeLedgerResponse(invalid),
      /thread_task_change_ledger_invalid/u,
    );
  }
});

test("rejects ambiguous, unsafe, or unbounded workspace change ledgers", () => {
  const valid = {
    schemaVersion: "crewon.workspace-change-summary.v0",
    paths: ["src/task.ts"],
    additions: 1,
    deletions: 0,
    statsComplete: true,
  };
  for (const invalid of [
    { ...valid, extra: true },
    { ...valid, paths: ["/etc/passwd"] },
    { ...valid, paths: ["src/../secret"] },
    { ...valid, paths: ["z.ts", "a.ts"] },
    { ...valid, paths: ["a.ts", "a.ts"] },
    { ...valid, additions: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, statsComplete: false },
    { ...valid, paths: [`src/${"\n".repeat(3_000)}.ts`] },
    {
      ...valid,
      paths: Array.from(
        { length: 4 },
        (_, index) => `${"a".repeat(4_080)}-${index}`,
      ),
    },
    {
      ...valid,
      paths: Array.from(
        { length: MAX_WORKSPACE_CHANGE_PATHS + 1 },
        (_, index) => `${String(index).padStart(3, "0")}.ts`,
      ),
    },
  ]) {
    assert.throws(
      () => parseWorkspaceChangeSummary(invalid),
      /workspace_change_summary_invalid/u,
    );
  }
});
