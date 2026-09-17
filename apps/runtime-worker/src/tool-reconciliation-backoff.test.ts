import assert from "node:assert/strict";
import test from "node:test";
import { toolReconciliationDelay } from "./tool-reconciliation-backoff.ts";

test("unknown tool attempts back off to a bounded delay without overflow", () => {
  assert.deepEqual(
    Array.from({ length: 11 }, (_, index) =>
      toolReconciliationDelay(1000, index + 1),
    ),
    [
      1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000,
      300000,
    ],
  );
  assert.equal(toolReconciliationDelay(1000, Number.MAX_SAFE_INTEGER), 300000);
  assert.equal(toolReconciliationDelay(0, 1000), 0);
  assert.equal(toolReconciliationDelay(600000, 1000), 600000);
  assert.equal(toolReconciliationDelay(1, 1), 1);
});
