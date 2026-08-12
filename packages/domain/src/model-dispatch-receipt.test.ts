import assert from "node:assert/strict";
import test from "node:test";

import {
  markModelDispatchPossiblySent,
  observeModelDispatchResponse,
  prepareModelDispatchReceipt,
  terminateModelDispatchReceipt,
} from "./model-dispatch-receipt.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const CHECKPOINT_DIGEST = `sha256:${"b".repeat(64)}`;
const PREPARE = {
  tenantId: "tenant-1",
  runId: "run-1",
  stepId: "step-1",
  attemptId: "attempt-1",
  workItemId: "step-1",
  leaseEpoch: 4,
  requestDigest: DIGEST,
  provider: {
    agentVersionId: "agent-version-1",
    adapterName: "responses",
    adapterVersion: "1",
    modelId: "gpt-test",
  },
  preparedAt: "2026-08-12T00:00:00Z",
} as const;

test("model dispatch evidence advances monotonically and retains certainty at terminal", () => {
  const prepared = prepareModelDispatchReceipt(null, PREPARE);
  const sent = markModelDispatchPossiblySent(prepared, "2026-08-12T00:00:01Z");
  const observed = observeModelDispatchResponse(sent, {
    checkpointDigest: CHECKPOINT_DIGEST,
    observedAt: "2026-08-12T00:00:02Z",
  });
  const terminal = terminateModelDispatchReceipt(observed, {
    outcome: { kind: "failed", code: "worker_crashed" },
    terminalAt: "2026-08-12T00:00:03Z",
  });

  assert.deepEqual(terminal, {
    ...observed,
    status: "terminal",
    revision: 4,
    terminalAt: "2026-08-12T00:00:03Z",
    terminalOutcome: { kind: "failed", code: "worker_crashed" },
    updatedAt: "2026-08-12T00:00:03Z",
  });
  assert.equal(terminal.possiblySentAt, "2026-08-12T00:00:01Z");
  assert.equal(terminal.responseCheckpointDigest, CHECKPOINT_DIGEST);
});

test("model dispatch mutations replay exactly and reject immutable conflicts", () => {
  const prepared = prepareModelDispatchReceipt(null, PREPARE);
  assert.equal(prepareModelDispatchReceipt(prepared, PREPARE), prepared);
  assert.throws(
    () =>
      prepareModelDispatchReceipt(prepared, {
        ...PREPARE,
        requestDigest: `sha256:${"c".repeat(64)}`,
      }),
    { message: "model_dispatch_receipt_conflict" },
  );
  const sent = markModelDispatchPossiblySent(prepared, "2026-08-12T00:00:01Z");
  assert.equal(
    markModelDispatchPossiblySent(sent, "2026-08-12T00:09:00Z"),
    sent,
  );
  const observed = observeModelDispatchResponse(sent, {
    checkpointDigest: CHECKPOINT_DIGEST,
    observedAt: "2026-08-12T00:00:02Z",
  });
  assert.throws(
    () =>
      observeModelDispatchResponse(observed, {
        checkpointDigest: `sha256:${"d".repeat(64)}`,
        observedAt: "2026-08-12T00:00:02Z",
      }),
    { message: "model_dispatch_response_conflict" },
  );
});
