import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requiredCases = [
  "terminal",
  "assistant-tool-mixed",
  "one-tool-then-final",
  "two-tool-rounds",
  "completed-tool-receipt-replay",
  "possibly-sent-no-response",
  "provider-checkpoint-crash-retrieve",
  "cancel-terminal-race",
  "stream-retry",
  "max-tool-rounds-boundary",
] as const;

test("parity matrix names every required trace and all three runtimes", async () => {
  const matrix = JSON.parse(
    await readFile(
      new URL(
        "../../../packages/test-contracts/fixtures/agent-runtime-parity-matrix.reference.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(matrix.requiredCases, requiredCases);
  assert.deepEqual(Object.keys(matrix.evidence), [...requiredCases]);
  for (const caseId of requiredCases) {
    assert.ok(matrix.evidence[caseId].length >= 2, caseId);
  }
  assert.deepEqual(matrix.sharedTsReducer.consumers, [
    "ordinaryTs",
    "workflowTs",
  ]);
  for (const row of matrix.sequenceMatrix) {
    assert.ok(row.ordinaryTs.length > 0, row.caseId);
    assert.ok(row.workflowTs.length > 0, row.caseId);
    assert.ok(row.rust.length > 0, row.caseId);
  }
  for (const row of matrix.recoveryMatrix) {
    assert.equal(typeof row.ordinaryTs, "string", row.caseId);
    assert.equal(typeof row.workflowTs, "string", row.caseId);
    assert.equal(typeof row.rust, "string", row.caseId);
  }
  assert.deepEqual(matrix.identityAndBounds.hardCaps, [
    "maxOutputBytes",
    "maxToolRounds",
    "maxContextItems",
    "maxContextBytes",
  ]);
});
