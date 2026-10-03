import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
  parseProjectGenerationSelectionHostContext,
} from "./project-generation-selection-host-context-contract.ts";

const request = {
  reference: {
    projectId: "project",
    assetId: "asset",
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
  operationId: "00000000-0000-4000-8000-000000000123",
  expectedOperationRevision: 4,
  resultIndex: 1,
  expectedSelectionRevision: 3,
  idempotencyKey: "original-selection-key",
};
const receipt = {
  disposition: "replayed",
  selectionRevision: 4,
  selection: {
    reference: { projectId: "project", assetId: "asset", assetRevision: 2 },
    operationId: request.operationId,
    operationRevision: 4,
    resultIndex: 1,
    filename: "second.png",
    url: "https://provider.test/view?filename=second.png",
    selectedAt: "2026-10-04T00:00:00.000Z",
  },
};
const context = () => ({
  version: PROJECT_GENERATION_SELECTION_HOST_CONTEXT_VERSION,
  intent: null,
});

test("selection recovery preserves exact original source, CAS, index and key without a Thread", () => {
  const raw = {
    ...context(),
    intent: {
      request: structuredClone(request),
      phase: "uncertain",
      retryable: true,
      receipt: null,
    },
  };
  const captured = parseProjectGenerationSelectionHostContext(raw);
  raw.intent.request.reference.expectedProjectRevision = 99;
  raw.intent.request.resultIndex = 0;
  raw.intent.request.idempotencyKey = "replacement";
  assert.deepEqual(captured.intent?.request, request);
  assert.ok(Object.isFrozen(captured.intent?.request.reference));
  assert.ok(Object.isFrozen(captured.intent));
  assert.ok(Object.isFrozen(captured));
  assert.deepEqual(
    parseProjectGenerationSelectionHostContext(context()),
    context(),
  );
});

test("only uncertain recovery may retry, and only accepted recovery carries its matching immutable receipt", () => {
  for (const phase of [
    "pending",
    "uncertain",
    "accepted",
    "refused",
  ] as const) {
    const intent = {
      request,
      phase,
      retryable: phase === "uncertain",
      receipt: phase === "accepted" ? receipt : null,
    };
    assert.equal(
      parseProjectGenerationSelectionHostContext({ ...context(), intent })
        .intent?.phase,
      phase,
    );
    if (phase !== "uncertain")
      assert.throws(() =>
        parseProjectGenerationSelectionHostContext({
          ...context(),
          intent: { ...intent, retryable: true },
        }),
      );
    assert.throws(() =>
      parseProjectGenerationSelectionHostContext({
        ...context(),
        intent: { ...intent, receipt: phase === "accepted" ? null : receipt },
      }),
    );
  }
});

test("a replay remains the original command receipt, never a newer current pointer", () => {
  const accepted = {
    ...context(),
    intent: { request, phase: "accepted", retryable: false, receipt },
  };
  assert.deepEqual(
    parseProjectGenerationSelectionHostContext(accepted).intent?.receipt,
    receipt,
  );
  for (const patch of [
    { selectionRevision: 5 },
    { selection: { ...receipt.selection, resultIndex: 0 } },
    { selection: { ...receipt.selection, operationRevision: 5 } },
    { selection: { ...receipt.selection, requiresConfirmation: false } },
  ])
    assert.throws(() =>
      parseProjectGenerationSelectionHostContext({
        ...accepted,
        intent: { ...accepted.intent, receipt: { ...receipt, ...patch } },
      }),
    );
});

test("recovery data cannot inject current state, identity, runtime or authority", () => {
  for (const field of [
    "current",
    "thread",
    "threadReady",
    "payer",
    "owner",
    "sourcePin",
  ])
    assert.throws(() =>
      parseProjectGenerationSelectionHostContext({ ...context(), [field]: {} }),
    );
  assert.throws(() =>
    parseProjectGenerationSelectionHostContext({
      ...context(),
      intent: {
        request: { ...request, url: "https://forged.test/" },
        phase: "uncertain",
        retryable: true,
        receipt: null,
      },
    }),
  );
});

test("recovery rejects excess data and getters without evaluating them", () => {
  let read = false;
  const accessor = Object.defineProperty(context(), "intent", {
    enumerable: true,
    get() {
      read = true;
      return null;
    },
  });
  assert.throws(() => parseProjectGenerationSelectionHostContext(accessor));
  assert.equal(read, false);
  assert.throws(() =>
    parseProjectGenerationSelectionHostContext({
      ...context(),
      intent: {
        request: { ...request, idempotencyKey: "中".repeat(9000) },
        phase: "uncertain",
        retryable: false,
        receipt: null,
      },
    }),
  );
});
