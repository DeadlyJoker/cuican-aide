import assert from "node:assert/strict";
import test from "node:test";
import {
  assetPublicFixture,
  assetPublicDigest as digest,
  assetPublicAt as at,
} from "./project-assets.test-support.ts";
import { parsePublicProjectAssetReferenceRevision } from "./project-assets-contract.ts";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Request,
  parseProjectAssetV2Response,
  parsePublicProjectAssetReferenceRevisionV2,
  parsePublicProjectAssetViewV2,
} from "./project-assets-v2.ts";
function fixture() {
  const legacy = assetPublicFixture(),
    reference = {
      ...legacy.reference,
      referenceRevision: 2,
      source: {
        kind: "media-result" as const,
        candidateId: "result-" + "a".repeat(64),
        candidateDigest: digest,
        sourceRunId: "media-run",
        resultIndex: 0,
        mediaInputId: "input",
        inputRevision: 1,
        workflowId: "krea2-reference-four-view" as const,
        generatedFor: {
          assetId: "character",
          contentRevision: 1,
          contentDigest: digest,
          referenceRevision: 1,
          referenceDigest: digest,
        },
        observedAt: at,
      },
    },
    asset = {
      ...legacy.asset,
      revision: 5,
      selectedContentRevision: 1,
      latestReferenceRevision: 2,
      selectedReferenceRevision: 2,
    },
    command = {
      projectId: "project",
      assetId: "character",
      expectedAssetRevision: 4,
      assetContentRevision: 1,
      runId: "media-run",
      resultIndex: 0,
      candidateId: reference.source.candidateId,
      candidateDigest: digest,
      idempotencyKey: "adopt",
    },
    view = {
      asset,
      selectedContentRevision: legacy.content,
      selectedReferenceRevision: reference,
      dependencyState: "current",
      staleReasons: [],
      referenceState: "current",
    };
  return { legacy, reference, asset, command, view };
}
test("V2 reference protocol preserves a distinct media origin and rejects V1 relabeling or mixed proof fields", () => {
  const f = fixture();
  assert.deepEqual(
    parsePublicProjectAssetReferenceRevisionV2(f.reference),
    f.reference,
  );
  assert.throws(() => parsePublicProjectAssetReferenceRevision(f.reference));
  assert.deepEqual(
    parsePublicProjectAssetReferenceRevision(f.legacy.reference),
    f.legacy.reference,
  );
  const concept = {
    ...f.legacy.reference,
    source: { kind: "concept-selection", ...f.legacy.reference.source },
  };
  assert.deepEqual(
    parsePublicProjectAssetReferenceRevisionV2(concept),
    concept,
  );
  for (const extra of [
    { url: "https://caller.invalid" },
    { actorId: "caller" },
    { resultLinkDigest: digest },
    { sourceBindingDigest: digest },
  ])
    assert.throws(() =>
      parsePublicProjectAssetReferenceRevisionV2({
        ...f.reference,
        source: { ...f.reference.source, ...extra },
      }),
    );
  for (const changed of [
    { assetId: "other" },
    { contentRevision: 2 },
    { contentDigest: "sha256:" + "b".repeat(64) },
    { referenceRevision: 2 },
  ])
    assert.throws(() =>
      parsePublicProjectAssetReferenceRevisionV2({
        ...f.reference,
        source: {
          ...f.reference.source,
          generatedFor: { ...f.reference.source.generatedFor, ...changed },
        },
      }),
    );
});
test("V2 view checks current pointers, source content and character purpose", () => {
  const f = fixture();
  assert.deepEqual(parsePublicProjectAssetViewV2(f.view), f.view);
  assert.throws(() =>
    parsePublicProjectAssetViewV2({
      ...f.view,
      asset: { ...f.asset, selectedReferenceRevision: 1 },
    }),
  );
  assert.throws(() =>
    parsePublicProjectAssetViewV2({
      ...f.view,
      asset: { ...f.asset, kind: "scene" },
      selectedContentRevision: { ...f.legacy.content, kind: "scene" },
    }),
  );
  assert.throws(() =>
    parsePublicProjectAssetViewV2({ ...f.view, referenceState: "stale" }),
  );
});
test("V2 adoption accepts only bounded logical selectors and never evaluates accessor payloads", () => {
  const f = fixture(),
    request = { action: actions.adoptMediaReference, input: f.command };
  assert.deepEqual(parseProjectAssetV2Request(request), request);
  for (const extra of [
    { source: f.reference.source },
    { url: "https://caller.invalid" },
    { actor: { actorId: "caller" } },
    { authority: {} },
  ])
    assert.throws(() =>
      parseProjectAssetV2Request({
        ...request,
        input: { ...f.command, ...extra },
      }),
    );
  for (const changed of [
    { expectedAssetRevision: 0 },
    { resultIndex: 16 },
    { candidateId: "caller-choice" },
    { candidateDigest: "invalid" },
  ])
    assert.throws(() =>
      parseProjectAssetV2Request({
        ...request,
        input: { ...f.command, ...changed },
      }),
    );
  let calls = 0;
  const getter = Object.defineProperty({ ...f.command }, "runId", {
    enumerable: true,
    get() {
      calls++;
      return "media-run";
    },
  });
  assert.throws(() =>
    parseProjectAssetV2Request({ ...request, input: getter }),
  );
  assert.equal(calls, 0);
});
test("V2 response enforces adoption request identity, original receipt revision and metadata-only envelope", () => {
  const f = fixture(),
    request = { action: actions.adoptMediaReference, input: f.command },
    result = {
      disposition: "committed",
      asset: f.asset,
      referenceRevision: f.reference,
    };
  assert.deepEqual(parseProjectAssetV2Response(request, result), result);
  for (const changed of [
    { runId: "another" },
    { expectedAssetRevision: 5 },
    { resultIndex: 1 },
    { candidateDigest: "sha256:" + "b".repeat(64) },
  ])
    assert.throws(() =>
      parseProjectAssetV2Response(
        { ...request, input: { ...f.command, ...changed } },
        result,
      ),
    );
  assert.throws(() =>
    parseProjectAssetV2Response(request, { ...result, authority: {} }),
  );
});
test("V2 reference pagination rejects duplicate/out-of-order records and a cursor that skips returned history", () => {
  const f = fixture(),
    request = {
      action: actions.listReferences,
      input: {
        projectId: "project",
        assetId: "character",
        afterReferenceRevision: 0,
        limit: 2,
      },
    },
    concept = {
      ...f.legacy.reference,
      source: { kind: "concept-selection", ...f.legacy.reference.source },
    };
  const result = {
    references: [concept, f.reference],
    nextReferenceRevision: 2,
  };
  assert.deepEqual(parseProjectAssetV2Response(request, result), result);
  for (const references of [
    [f.reference, concept],
    [concept, concept],
  ])
    assert.throws(() =>
      parseProjectAssetV2Response(request, { ...result, references }),
    );
  assert.throws(() =>
    parseProjectAssetV2Response(request, {
      ...result,
      nextReferenceRevision: 3,
    }),
  );
  assert.throws(() =>
    parseProjectAssetV2Request({
      ...request,
      input: { ...request.input, limit: 17 },
    }),
  );
});

test("V2 keeps the original content request budget and all original asset action grammars", () => {
  const f = fixture(),
    scope = { projectId: "project", assetId: "character" };
  const cases = [
    [actions.getAsset, scope],
    [actions.getRevision, { ...scope, contentRevision: 1 }],
    [actions.getReferenceRevision, { ...scope, referenceRevision: 1 }],
    [
      actions.listAssets,
      { projectId: "project", afterAssetId: null, limit: 16 },
    ],
    [actions.listRevisions, { ...scope, afterContentRevision: 0, limit: 16 }],
    [
      actions.listReferences,
      { ...scope, afterReferenceRevision: 0, limit: 16 },
    ],
    [
      actions.saveCandidate,
      {
        ...f.legacy.request.input,
        request: {
          ...f.legacy.request.input.request,
          content: {
            ...f.legacy.content.content,
            setting: "设".repeat(2048),
            visualPrompt: "像".repeat(666),
          },
        },
      },
    ],
    [
      actions.selectRevision,
      {
        ...scope,
        request: { expectedAssetRevision: 1, contentRevision: 1 },
        idempotencyKey: "select",
      },
    ],
    [
      actions.setLocked,
      {
        ...scope,
        request: { expectedAssetRevision: 1, locked: true },
        idempotencyKey: "lock",
      },
    ],
    [
      actions.saveReferenceCandidate,
      {
        ...scope,
        request: {
          expectedAssetRevision: 2,
          assetContentRevision: 1,
          conceptAssetId: "concept",
          selectionRevision: 1,
        },
        idempotencyKey: "reference",
      },
    ],
    [
      actions.selectReference,
      {
        ...scope,
        request: { expectedAssetRevision: 4, referenceRevision: 2 },
        idempotencyKey: "select-reference",
      },
    ],
  ] as const;
  assert.ok(new TextEncoder().encode(JSON.stringify(cases[6])).length > 8192);
  for (const [action, input] of cases) {
    assert.deepEqual(parseProjectAssetV2Request({ action, input }), {
      action,
      input,
    });
    assert.throws(() =>
      parseProjectAssetV2Request({
        action,
        input: { ...input, actorId: "caller" },
      }),
    );
    assert.throws(() =>
      parseProjectAssetV2Request({
        action: action.replace(".v2.", ".v3."),
        input,
      }),
    );
  }
});

test("V2 selection returns the real origin and never accepts a generated image as a concept candidate response", () => {
  const f = fixture(),
    input = {
      projectId: "project",
      assetId: "character",
      request: { expectedAssetRevision: 4, referenceRevision: 2 },
      idempotencyKey: "select-media",
    };
  const output = {
    kind: "select-reference",
    disposition: "committed",
    asset: f.asset,
    contentRevision: null,
    referenceRevision: f.reference,
  };
  const request = { action: actions.selectReference, input };
  assert.deepEqual(parseProjectAssetV2Response(request, output), output);
  assert.throws(() =>
    parseProjectAssetV2Response(request, {
      ...output,
      asset: { ...f.asset, kind: "scene" },
    }),
  );
  assert.throws(() =>
    parseProjectAssetV2Response(request, {
      ...output,
      referenceRevision: f.legacy.reference,
    }),
  );
  assert.throws(() =>
    parseProjectAssetV2Response(request, {
      ...output,
      asset: { ...f.asset, revision: 6 },
    }),
  );
  assert.throws(() =>
    parseProjectAssetV2Response(
      {
        action: actions.saveReferenceCandidate,
        input: {
          ...input,
          request: {
            expectedAssetRevision: 4,
            assetContentRevision: 1,
            conceptAssetId: "concept",
            selectionRevision: 1,
          },
        },
      },
      { ...output, kind: "save-reference" },
    ),
  );
});
