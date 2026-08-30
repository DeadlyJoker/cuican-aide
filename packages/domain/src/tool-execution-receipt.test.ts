import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchToolExecutionReceipt,
  markToolExecutionUnknownOutcome,
  prepareToolExecutionReceipt,
  resolveToolExecutionReceipt,
  ToolExecutionReceiptError,
  type ToolActionIntentState,
} from "./tool-execution-receipt.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const PREPARED_AT = "2026-08-08T00:00:00Z";

test("moves a reconcilable mutation through unknown outcome to completion", () => {
  const prepared = receipt();
  const dispatched = dispatchToolExecutionReceipt(
    prepared,
    "2026-08-08T00:00:01Z",
  );
  const unknown = markToolExecutionUnknownOutcome(dispatched, {
    observedAt: "2026-08-08T00:00:02Z",
    providerReceiptId: null,
  });
  const completed = resolveToolExecutionReceipt(unknown, {
    status: "completed",
    resolvedAt: "2026-08-08T00:00:03Z",
    providerReceiptId: "provider-receipt-1",
    result: {
      output: "done",
      outputDigest: DIGEST_B,
      isError: false,
      artifactRef: null,
    },
  });

  assert.deepEqual(completed, {
    ...prepared,
    status: "completed",
    revision: 4,
    providerReceiptId: "provider-receipt-1",
    result: {
      output: "done",
      outputDigest: DIGEST_B,
      isError: false,
      artifactRef: null,
    },
    dispatchedAt: "2026-08-08T00:00:01Z",
    updatedAt: "2026-08-08T00:00:03Z",
    resolvedAt: "2026-08-08T00:00:03Z",
  });
});

test("fails closed when a mutation cannot be reconciled", () => {
  assert.throws(
    () => receipt({ recovery: "replaySafe" }),
    hasCode("tool_mutation_not_reconcilable"),
  );
});

test("does not complete an action that was never dispatched", () => {
  assert.throws(
    () =>
      resolveToolExecutionReceipt(receipt(), {
        status: "completed",
        resolvedAt: "2026-08-08T00:00:01Z",
        providerReceiptId: "provider-receipt-1",
        result: {
          output: "impossible",
          outputDigest: DIGEST_B,
          isError: false,
          artifactRef: null,
        },
      }),
    hasCode("tool_receipt_not_dispatched"),
  );
});

test("allows a prepared action to be canceled without dispatch", () => {
  const prepared = receipt({ effect: "readOnly", recovery: "replaySafe" });

  assert.deepEqual(
    resolveToolExecutionReceipt(prepared, {
      status: "canceled",
      resolvedAt: "2026-08-08T00:00:01Z",
      providerReceiptId: null,
    }),
    {
      ...prepared,
      status: "canceled",
      revision: 2,
      updatedAt: "2026-08-08T00:00:01Z",
      resolvedAt: "2026-08-08T00:00:01Z",
    },
  );
});

function receipt(
  override: Partial<
    Pick<
      Parameters<typeof prepareToolExecutionReceipt>[0],
      "effect" | "recovery"
    >
  > = {},
) {
  const effect = override.effect ?? "mutation";
  const recovery = override.recovery ?? "reconcilable";
  return prepareToolExecutionReceipt({
    receiptId: "receipt-1",
    tenantId: "tenant-1",
    runId: "run-1",
    stepId: "tool-step-1",
    attemptId: "tool-attempt-1",
    workItemId: "run-work-item-1",
    executionId: "execution-1",
    idempotencyKey: "run-1/tool/call-1",
    actionDigest: DIGEST_A,
    actionIntent: actionIntent(effect, recovery),
    call: {
      segmentId: "segment-1",
      callId: "call-1",
      kind: "function",
      name: "filesystem.write",
      inputDigest: DIGEST_A,
    },
    effect,
    recovery,
    preparedAt: PREPARED_AT,
  });
}

function actionIntent(
  effect: "readOnly" | "mutation",
  recovery: "replaySafe" | "reconcilable",
): ToolActionIntentState {
  return {
    schemaVersion: "crewon.action-intent.v0" as const,
    runId: "run-1",
    segmentId: "segment-1",
    callId: "call-1",
    tool: {
      kind: "function" as const,
      name: "filesystem.write",
      inputDigest: DIGEST_A,
    },
    effect,
    recovery,
    policySnapshotId: "policy-1",
    workspaceBindingId: "workspace-1",
    resourceBindingId: null,
    credentialBindingId: null,
    executionTarget: { kind: "device" as const, bindingId: "device-1" },
    capability: effect === "mutation" ? "workspace.write" : "workspace.read",
    approvalRequirement: effect === "mutation" ? "perAction" : "none",
    limits: {
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
      maxArtifactBytes: 1024 * 1024,
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof ToolExecutionReceiptError && error.code === code;
}
