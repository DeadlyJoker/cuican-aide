import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectGenerationQueryHostContext,
  PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
} from "./project-generation-query-host-context-contract.ts";

const request = {
  reference: {
    projectId: "project",
    assetId: "asset",
    assetRevision: 2,
  },
  operationId: "00000000-0000-4000-8000-000000000123",
  threadId: "thread",
  expectedThreadRevision: 4,
  idempotencyKey: "original-key",
};
const receipt = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 5,
  runId: "query-run",
  messageId: "message",
  configurationRevision: 9,
};
const context = () => ({
  version: PROJECT_GENERATION_QUERY_HOST_CONTEXT_VERSION,
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
  const captured = parseProjectGenerationQueryHostContext(accepted);
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

test("unknown/pending blocks a new query; only unknown can be retryable; accepted iff an exact receipt exists", () => {
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
    assert.equal(
      parseProjectGenerationQueryHostContext(value).intent?.phase,
      phase,
    );
    if (phase !== "uncertain")
      assert.throws(() =>
        parseProjectGenerationQueryHostContext({
          ...value,
          intent: { ...value.intent, retryable: true },
        }),
      );
    if (phase === "pending" || phase === "uncertain")
      assert.throws(() =>
        parseProjectGenerationQueryHostContext({ ...value, threadReady: true }),
      );
    assert.throws(() =>
      parseProjectGenerationQueryHostContext({
        ...value,
        intent: {
          ...value.intent,
          receipt: phase === "accepted" ? null : receipt,
        },
      }),
    );
  }
  assert.throws(() =>
    parseProjectGenerationQueryHostContext({
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
    parseProjectGenerationQueryHostContext({
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
  assert.deepEqual(
    parseProjectGenerationQueryHostContext(context()),
    context(),
  );
  for (const phase of ["idle", "loading", "uncertain", "error"])
    assert.throws(() =>
      parseProjectGenerationQueryHostContext({ ...context(), phase }),
    );
  assert.throws(() =>
    parseProjectGenerationQueryHostContext({ ...context(), thread: null }),
  );
  for (const revision of [0, 1.5, "4", Number.MAX_SAFE_INTEGER])
    assert.throws(() =>
      parseProjectGenerationQueryHostContext({
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
      parseProjectGenerationQueryHostContext({
        ...context(),
        [field]: "injected",
      }),
    );
  let getters = 0;
  assert.throws(() =>
    parseProjectGenerationQueryHostContext({
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
      parseProjectGenerationQueryHostContext({
        ...context(),
        extra: "a".repeat(24 * 1024),
      }),
    /plugin_ui_json_bytes_exceeded/,
  );
});

test("query context cannot enable conversation preparation or replace a retained operation", () => {
  assert.throws(() =>
    parseProjectGenerationQueryHostContext({
      ...context(),
      phase: "preparing",
      threadReady: false,
    }),
  );
  assert.throws(() =>
    parseProjectGenerationQueryHostContext({
      ...context(),
      intent: {
        request: { ...request, sourceRunId: "injected-source" },
        phase: "uncertain",
        retryable: true,
        receipt: null,
      },
    }),
  );
  const uncertain = parseProjectGenerationQueryHostContext({
    ...context(),
    phase: "uncertain",
    threadReady: false,
    intent: {
      request,
      phase: "uncertain",
      retryable: true,
      receipt: null,
    },
  });
  assert.equal(uncertain.intent?.request.operationId, request.operationId);
});
