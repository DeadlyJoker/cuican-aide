import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadTranscriptSnapshotResponse } from "./thread-transcript-snapshot-contract.ts";
import { transcriptSnapshotFixture } from "./thread-transcript-snapshot.test-support.ts";
const query = { position: null, limit: 1 } as const;

test("snapshot parser isolates messages and Runs and includes an off-page active Run", () => {
  const input = transcriptSnapshotFixture();
  input.runs.push({ ...input.runs[0]!, runId: "run-active" });
  input.activeRunId = "run-active";
  const parsed = parseThreadTranscriptSnapshotResponse(
    input,
    "thread-1",
    query,
  );
  assert.deepEqual(parsed, input);
  input.runs[0]!.status = "failed";
  input.transcriptWindow.messageWindow.data[0]!.content = "changed";
  assert.equal(parsed.runs[0]?.status, "queued");
  assert.equal(
    parsed.transcriptWindow.messageWindow.data[0]?.content,
    "source",
  );
});
test("snapshot parser rejects missing, extra, duplicate, cross-thread and terminal-active Run data", () => {
  const base = transcriptSnapshotFixture(),
    run = base.runs[0]!;
  for (const value of [
    { ...base, runs: [] },
    { ...base, runs: [run, run] },
    { ...base, runs: [run, { ...run, runId: "unrelated" }] },
    { ...base, runs: [{ ...run, threadId: "other" }] },
    {
      ...base,
      runs: [
        {
          ...run,
          status: "canceled",
          cancelRequested: true,
          terminalAt: run.updatedAt,
        },
      ],
    },
    { ...base, activeRunId: "missing" },
    { ...base, extra: true },
    { ...base, schemaVersion: "future" },
    { ...base, runs: [run, run, run] },
  ])
    assert.throws(() =>
      parseThreadTranscriptSnapshotResponse(value, "thread-1", query),
    );
  const history = {
    ...base,
    activeRunId: null,
    runs: [
      {
        ...run,
        status: "canceled",
        cancelRequested: true,
        terminalAt: run.updatedAt,
      },
    ],
  };
  assert.equal(
    parseThreadTranscriptSnapshotResponse(history, "thread-1", query)
      .activeRunId,
    null,
  );
});
