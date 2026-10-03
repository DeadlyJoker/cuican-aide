import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectGenerationHostContext,
  PROJECT_GENERATION_HOST_CONTEXT_VERSION,
} from "./project-generation-host-context-contract.ts";

const request = {
  reference: {
    projectId: "project",
    assetId: "asset",
    assetRevision: 2,
    expectedProjectRevision: 7,
    expectedAssetMetadataRevision: 3,
  },
  threadId: "thread",
  expectedThreadRevision: 4,
  idempotencyKey: "original-key",
};
const receipt = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 5,
  runId: "original-run",
  messageId: "message",
  configurationRevision: 9,
};
const context = () => ({
  version: PROJECT_GENERATION_HOST_CONTEXT_VERSION,
  phase: "ready",
  thread: { threadId: "thread", revision: 4, provisional: false },
  threadReady: true,
  intent: null,
});

test("host context is a detached display hint with exact immutable original input and receipt", () => {
  const accepted = {
    ...context(),
    intent: {
      request: structuredClone(request),
      phase: "accepted",
      retryable: false,
      receipt: structuredClone(receipt),
    },
  };
  const captured = parseProjectGenerationHostContext(accepted);
  accepted.intent.request.idempotencyKey = "replacement";
  accepted.intent.receipt.runId = "replacement";
  assert.deepEqual(captured.intent?.request, request);
  assert.deepEqual(captured.intent?.receipt, receipt);
  for (const value of [
    captured,
    captured.thread,
    captured.intent,
    captured.intent?.request,
    captured.intent?.request.reference,
    captured.intent?.receipt,
  ])
    assert.ok(Object.isFrozen(value));
});

test("unknown/pending blocks new generation; only unknown can be retryable; accepted iff an exact receipt exists", () => {
  for (const phase of [
    "pending",
    "uncertain",
    "accepted",
    "refused",
  ] as const) {
    const value = {
      ...context(),
      threadReady: false,
      intent: {
        request,
        phase,
        retryable: phase === "uncertain",
        receipt: phase === "accepted" ? receipt : null,
      },
    };
    assert.equal(parseProjectGenerationHostContext(value).intent?.phase, phase);
    if (phase !== "uncertain")
      assert.throws(() =>
        parseProjectGenerationHostContext({
          ...value,
          intent: { ...value.intent, retryable: true },
        }),
      );
    if (phase === "pending" || phase === "uncertain")
      assert.throws(() =>
        parseProjectGenerationHostContext({ ...value, threadReady: true }),
      );
    assert.throws(() =>
      parseProjectGenerationHostContext({
        ...value,
        intent: {
          ...value.intent,
          receipt: phase === "accepted" ? null : receipt,
        },
      }),
    );
  }
  assert.throws(() =>
    parseProjectGenerationHostContext({
      ...context(),
      intent: {
        request,
        phase: "accepted",
        retryable: false,
        receipt: { ...receipt, threadId: "foreign" },
      },
    }),
  );
  assert.throws(() =>
    parseProjectGenerationHostContext({
      ...context(),
      intent: {
        request,
        phase: "accepted",
        retryable: false,
        receipt: { ...receipt, threadRevision: 6 },
      },
    }),
  );
});

test("threadReady requires an actually ready thread; revisions and display fields reject authority injection", () => {
  assert.deepEqual(parseProjectGenerationHostContext(context()), context());
  for (const phase of ["idle", "loading", "preparing", "uncertain", "error"])
    assert.throws(() =>
      parseProjectGenerationHostContext({ ...context(), phase }),
    );
  assert.throws(() =>
    parseProjectGenerationHostContext({ ...context(), thread: null }),
  );
  for (const revision of [0, 1.5, "4", Number.MAX_SAFE_INTEGER])
    assert.throws(() =>
      parseProjectGenerationHostContext({
        ...context(),
        thread: { ...context().thread, revision },
      }),
    );
  for (const field of [
    "actor",
    "payer",
    "walletId",
    "price",
    "authority",
    "target",
  ])
    assert.throws(() =>
      parseProjectGenerationHostContext({ ...context(), [field]: "injected" }),
    );
  let getters = 0;
  assert.throws(() =>
    parseProjectGenerationHostContext({
      ...context(),
      get intent() {
        getters++;
        return null;
      },
    }),
  );
  assert.equal(getters, 0);
  assert.throws(
    () =>
      parseProjectGenerationHostContext({
        ...context(),
        extra: "a".repeat(24 * 1024),
      }),
    /plugin_ui_json_bytes_exceeded/,
  );
});
