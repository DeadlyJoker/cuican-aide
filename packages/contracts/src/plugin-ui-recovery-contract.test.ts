import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_UI_RECOVERY_VERSION,
  parsePluginUiRecoveryRequest,
  parsePluginUiRecoveryHint,
  parsePluginUiRecoveryHintsResponse,
  parseStagePluginUiRecoveryResponse,
} from "./plugin-ui-recovery-contract.ts";

const sourcePin = {
  pluginId: "crewon.short-drama",
  publisherId: "example.publisher",
  version: "8.0.0",
  packageDigest: `sha256:${"a".repeat(64)}`,
  selectionRevision: 2,
  contributionId: "workbench",
};
const reference = { projectId: "project", assetId: "asset", assetRevision: 2 };
const operationId = "00000000-0000-4000-8000-000000000123";
const requests = [
  {
    action: "crewon.project-generations.v1.generateConcept",
    input: {
      reference: {
        ...reference,
        expectedProjectRevision: 4,
        expectedAssetMetadataRevision: 5,
      },
      threadId: "thread",
      expectedThreadRevision: 6,
      idempotencyKey: "original-generation",
    },
  },
  {
    action: "crewon.project-generation-queries.v1.queryConceptGeneration",
    input: {
      reference,
      operationId,
      threadId: "thread",
      expectedThreadRevision: 6,
      idempotencyKey: "original-query",
    },
  },
  {
    action: "crewon.project-generation-selections.v1.selectConceptImage",
    input: {
      reference: {
        ...reference,
        expectedProjectRevision: 4,
        expectedAssetMetadataRevision: 5,
      },
      operationId,
      expectedOperationRevision: 3,
      resultIndex: 1,
      expectedSelectionRevision: 0,
      idempotencyKey: "original-selection",
    },
  },
];
const taskReceipt = {
  disposition: "committed",
  threadId: "thread",
  threadRevision: 7,
  runId: "original-run",
  messageId: "message",
  configurationRevision: 2,
};
const selectionReceipt = {
  disposition: "committed",
  selectionRevision: 1,
  selection: {
    reference,
    operationId,
    operationRevision: 3,
    resultIndex: 1,
    filename: "second.png",
    url: "https://comfy.example/view?filename=second.png&type=output",
    selectedAt: "2026-10-04T00:00:00.000Z",
  },
};
const hint = (index = 0) => ({
  sourcePin: structuredClone(sourcePin),
  request: structuredClone(requests[index]),
  revision: 1,
  phase: "prepared",
  dispatchMayHaveOccurred: false,
  dispatchAttemptCount: 0,
  receipt: null,
  retryable: true,
  reasonCode: null,
});
const accepted = (index = 0) => ({
  ...hint(index),
  revision: 3,
  phase: "accepted",
  dispatchMayHaveOccurred: true,
  dispatchAttemptCount: 1,
  retryable: false,
  receipt: structuredClone(index === 2 ? selectionReceipt : taskReceipt),
});

test("preserves the three original immutable command schemas, without scope or URL selectors", () => {
  for (const original of requests) {
    const input = structuredClone(original);
    const parsed = parsePluginUiRecoveryRequest(input);
    input.input.idempotencyKey = "replacement";
    assert.equal(parsed.input.idempotencyKey, original.input.idempotencyKey);
    assert.ok("reference" in parsed.input);
    assert.ok(Object.isFrozen(parsed.input.reference));
    for (const key of ["actorId", "principalId", "payerId", "url", "sourcePin"])
      assert.throws(() =>
        parsePluginUiRecoveryRequest({
          ...original,
          input: { ...original.input, [key]: "injected" },
        }),
      );
  }
  for (const action of [
    "crewon.project-generation-selections.v1.getConceptSelection",
    "crewon.tasks.v1.createThread",
    "crewon.plugin-ui-recovery.v1.stage",
    "vendor.arbitrary",
  ])
    assert.throws(() => parsePluginUiRecoveryRequest({ action, input: {} }));
});

test("preserves the original generation UTF-8 and selection UTF-16 key rules", () => {
  const key = "😀".repeat(64);
  assert.throws(() =>
    parsePluginUiRecoveryRequest({
      ...requests[0],
      input: { ...requests[0]!.input, idempotencyKey: key },
    }),
  );
  assert.equal(
    parsePluginUiRecoveryRequest({
      ...requests[2],
      input: { ...requests[2]!.input, idempotencyKey: key },
    }).input.idempotencyKey,
    key,
  );
});

test("checks durable dispatch evidence and paired receipts, keeping phase separate from retry permission", () => {
  for (let i = 0; i < requests.length; i++) {
    for (const original of [
      hint(i),
      {
        ...hint(i),
        revision: 3,
        phase: "dispatched",
        dispatchMayHaveOccurred: true,
        dispatchAttemptCount: 2,
      },
      accepted(i),
      ...(i === 2
        ? [
            {
              ...hint(i),
              revision: 3,
              phase: "refused",
              retryable: false,
              reasonCode: "creative_project_revision_conflict",
              dispatchMayHaveOccurred: true,
              dispatchAttemptCount: 1,
            },
          ]
        : []),
    ]) {
      const parsed = parsePluginUiRecoveryHint(original);
      assert.ok(Object.isFrozen(parsed));
      assert.ok(Object.isFrozen(parsed.sourcePin));
      assert.ok(Object.isFrozen(parsed.request.input));
    }
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...accepted(i), retryable: true }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...accepted(i), receipt: null }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...hint(i), receipt: taskReceipt }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({
        ...accepted(i),
        dispatchMayHaveOccurred: false,
      }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...hint(i), dispatchAttemptCount: 1 }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...hint(i), phase: "pending" }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({
        ...hint(i),
        revision: 3,
        phase: "refused",
        retryable: false,
        reasonCode: "provider_unavailable",
        dispatchMayHaveOccurred: true,
        dispatchAttemptCount: 1,
      }),
    );
    if (i !== 2)
      assert.throws(() =>
        parsePluginUiRecoveryHint({
          ...hint(i),
          revision: 3,
          phase: "refused",
          retryable: false,
          reasonCode: "creative_project_revision_conflict",
          dispatchMayHaveOccurred: true,
          dispatchAttemptCount: 1,
        }),
      );
    assert.throws(() =>
      parsePluginUiRecoveryHint({
        ...hint(i),
        phase: "dispatched",
        dispatchMayHaveOccurred: true,
        dispatchAttemptCount: 2,
      }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({
        ...hint(i),
        phase: "refused",
        retryable: false,
        reasonCode: "conflict",
        dispatchMayHaveOccurred: true,
        dispatchAttemptCount: 2,
      }),
    );
    assert.throws(() =>
      parsePluginUiRecoveryHint({
        ...accepted(i),
        receipt:
          i === 2
            ? { ...selectionReceipt, selectionRevision: 2 }
            : { ...taskReceipt, threadRevision: 8 },
      }),
    );
  }
  assert.equal(
    parsePluginUiRecoveryHint({
      ...hint(),
      retryable: false,
      reasonCode: "plugin_ui_recovery_namespace_changed",
    }).retryable,
    false,
  );
});

test("registration ACK retains every original CAS, raw image index and key", () => {
  for (let i = 0; i < requests.length; i++) {
    const request = parsePluginUiRecoveryRequest(requests[i]);
    const output = {
      version: PLUGIN_UI_RECOVERY_VERSION,
      disposition: "created",
      intent: hint(i),
    };
    assert.deepEqual(
      parseStagePluginUiRecoveryResponse(output, request).intent.request,
      request,
    );
    const substituted = {
      ...output,
      intent: {
        ...hint(i),
        request: {
          ...requests[i],
          input: { ...requests[i]!.input, idempotencyKey: "new-key" },
        },
      },
    };
    assert.throws(() =>
      parseStagePluginUiRecoveryResponse(substituted, request),
    );
    assert.throws(() =>
      parseStagePluginUiRecoveryResponse(
        { ...output, disposition: "committed" },
        request,
      ),
    );
  }
  const output = {
    version: PLUGIN_UI_RECOVERY_VERSION,
    disposition: "replayed",
    intent: accepted(2),
  };
  for (const delta of [
    { expectedProjectRevision: 8 },
    { expectedAssetMetadataRevision: 8 },
    { expectedOperationRevision: 4 },
    { resultIndex: 0 },
    { expectedSelectionRevision: 1 },
  ])
    assert.throws(() =>
      parseStagePluginUiRecoveryResponse(
        output,
        parsePluginUiRecoveryRequest({
          ...requests[2],
          input: { ...requests[2]!.input, ...delta },
        }),
      ),
    );
});

test("cold read stays bounded to one hint per command kind and one actual mount family", () => {
  assert.deepEqual(
    parsePluginUiRecoveryHintsResponse({
      version: PLUGIN_UI_RECOVERY_VERSION,
      intents: [],
    }).intents,
    [],
  );
  const response = parsePluginUiRecoveryHintsResponse({
    version: PLUGIN_UI_RECOVERY_VERSION,
    intents: requests.map((_, index) => accepted(index)),
  });
  assert.equal(response.intents.length, 3);
  assert.ok(Object.isFrozen(response.intents));
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({
      version: PLUGIN_UI_RECOVERY_VERSION,
      intents: [hint(), hint()],
    }),
  );
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({
      version: PLUGIN_UI_RECOVERY_VERSION,
      intents: [
        hint(),
        { ...hint(1), sourcePin: { ...sourcePin, contributionId: "other" } },
      ],
    }),
  );
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({
      version: "crewon.plugin-ui-recovery.v2",
      intents: [],
    }),
  );
});

test("rejects credential or authority fields and accessors without invoking application code", () => {
  let invoked = 0;
  const getter = { ...hint() };
  Object.defineProperty(getter, "receipt", {
    enumerable: true,
    get() {
      invoked++;
      return taskReceipt;
    },
  });
  assert.throws(() => parsePluginUiRecoveryHint(getter));
  assert.equal(invoked, 0);
  for (const key of [
    "owner",
    "profileId",
    "token",
    "payer",
    "current",
    "grant",
  ])
    assert.throws(() =>
      parsePluginUiRecoveryHint({ ...hint(), [key]: "injected" }),
    );
  assert.throws(() =>
    parsePluginUiRecoveryHint({
      ...hint(),
      sourcePin: { ...sourcePin, actorId: "injected" },
    }),
  );
  assert.throws(() =>
    parsePluginUiRecoveryHintsResponse({
      version: PLUGIN_UI_RECOVERY_VERSION,
      intents: [],
      filler: "x".repeat(61 * 1024),
    }),
  );
});
