import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectAssetUiActionRequest as request,
  parseProjectAssetUiActionResponse as response,
  parsePublicProjectAsset,
  parsePublicProjectAssetView,
  parsePublicProjectAssetContent,
} from "./project-assets-contract.ts";
import {
  PROJECT_ASSET_UI_METHOD_ACTIONS,
  MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
} from "./project-assets-service.ts";
import {
  assetPublicFixture as fixture,
  assetPublicDigest as digest,
} from "./project-assets.test-support.ts";

test("independent assets namespace parses all eleven typed actions without accepting owner or proof selectors", () => {
  const f = fixture();
  const inputs = [
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.getAsset,
      { projectId: "project", assetId: "character" },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.getRevision,
      { projectId: "project", assetId: "character", contentRevision: 1 },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.getReferenceRevision,
      { projectId: "project", assetId: "character", referenceRevision: 1 },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.listAssets,
      { projectId: "project", afterAssetId: null, limit: 16 },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.listRevisions,
      {
        projectId: "project",
        assetId: "character",
        afterContentRevision: 0,
        limit: 1,
      },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.listReferences,
      {
        projectId: "project",
        assetId: "character",
        afterReferenceRevision: 0,
        limit: 1,
      },
    ],
    [PROJECT_ASSET_UI_METHOD_ACTIONS.saveCandidate, f.request.input],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.selectRevision,
      {
        projectId: "project",
        assetId: "character",
        request: { expectedAssetRevision: 1, contentRevision: 1 },
        idempotencyKey: "select",
      },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.setLocked,
      {
        projectId: "project",
        assetId: "character",
        request: { expectedAssetRevision: 1, locked: true },
        idempotencyKey: "lock",
      },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
      {
        projectId: "project",
        assetId: "character",
        request: {
          expectedAssetRevision: 1,
          assetContentRevision: 1,
          conceptAssetId: "concept",
          selectionRevision: 1,
        },
        idempotencyKey: "reference",
      },
    ],
    [
      PROJECT_ASSET_UI_METHOD_ACTIONS.selectReference,
      {
        projectId: "project",
        assetId: "character",
        request: { expectedAssetRevision: 1, referenceRevision: 1 },
        idempotencyKey: "adopt-reference",
      },
    ],
  ] as const;
  for (const [action, input] of inputs) {
    assert.deepEqual(request({ action, input }), { action, input });
    assert.throws(() =>
      request({ action, input: { ...input, principalId: "foreign" } }),
    );
  }
  assert.throws(() =>
    request({
      action: "crewon.project-texts.v1.saveOutlineCandidate",
      input: f.request.input,
    }),
  );
});
test("save reference accepts only server-readable concept selection locators, never URLs or caller provenance", () => {
  const input = {
    projectId: "project",
    assetId: "character",
    request: {
      expectedAssetRevision: 1,
      assetContentRevision: 1,
      conceptAssetId: "concept",
      selectionRevision: 1,
    },
    idempotencyKey: "reference",
  };
  for (const [key, value] of [
    ["url", "https://image.example/"],
    ["sourceRunId", "run"],
    ["resultLinkDigest", digest],
    ["source", fixture().reference.source],
  ] as const)
    assert.throws(() =>
      request({
        action: PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
        input: { ...input, request: { ...input.request, [key]: value } },
      }),
    );
  assert.throws(() =>
    request({
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
      input: { ...input, request: { ...input.request, selectionRevision: 0 } },
    }),
  );
});
test("candidate create CAS, nullable real script source, strict bounds and dot locators match Domain", () => {
  const f = fixture();
  assert.throws(() =>
    request({
      ...f.request,
      input: { ...f.request.input, assetId: "character" },
    }),
  );
  assert.throws(() =>
    request({
      ...f.request,
      input: {
        ...f.request.input,
        request: { ...f.request.input.request, expectedAssetRevision: 1 },
      },
    }),
  );
  assert.throws(() =>
    request({ ...f.request, input: { ...f.request.input, projectId: ".." } }),
  );
  assert.throws(() =>
    request({
      ...f.request,
      input: {
        ...f.request.input,
        request: {
          ...f.request.input.request,
          script: { artifactId: ".", contentRevision: 1 },
        },
      },
    }),
  );
  const scripted = {
    ...f.request,
    input: {
      ...f.request.input,
      request: {
        ...f.request.input.request,
        script: { artifactId: "script", contentRevision: 1 },
      },
    },
  };
  assert.deepEqual(request(scripted), scripted);
  assert.throws(() =>
    parsePublicProjectAssetContent({
      ...f.content.content,
      visualPrompt: "界".repeat(667),
    }),
  );
  assert.throws(() =>
    parsePublicProjectAssetContent({
      ...f.content.content,
      setting: "a".repeat(6145),
    }),
  );
  assert.throws(() =>
    parsePublicProjectAssetContent({ ...f.content.content, name: "\ud800" }),
  );
  assert.equal(
    parsePublicProjectAssetContent(f.content.content).setting,
    f.content.content.setting,
  );
});
test("requests and responses reject accessors and exotic JSON without invoking them", () => {
  const f = fixture();
  let reads = 0;
  const input = Object.defineProperty({ ...f.request.input }, "projectId", {
    enumerable: true,
    get() {
      reads++;
      return "project";
    },
  });
  assert.throws(() => request({ ...f.request, input }));
  const asset = Object.defineProperty({ ...f.asset }, "kind", {
    enumerable: true,
    get() {
      reads++;
      return "character";
    },
  });
  assert.throws(() => response(f.request, { ...f.response, asset }));
  assert.throws(() =>
    response(
      Object.defineProperty({}, "action", {
        enumerable: true,
        get() {
          reads++;
          return f.request.action;
        },
      }) as never,
      f.response,
    ),
  );
  assert.throws(() =>
    parsePublicProjectAsset(Object.assign(Object.create({}), f.asset)),
  );
  const cycle: Record<string, unknown> = { ...f.request };
  cycle.input = cycle;
  assert.throws(() => request(cycle));
  assert.throws(() =>
    request({
      ...f.request,
      input: { ...f.request.input, [Symbol("hidden")]: true },
    }),
  );
  assert.equal(reads, 0);
});
test("committed and replayed mutation receipts bind exact CAS, identity, content and source request", () => {
  const f = fixture();
  assert.deepEqual(response(f.request, f.response), f.response);
  assert.deepEqual(
    response(f.request, { ...f.response, disposition: "replayed" }),
    { ...f.response, disposition: "replayed" },
  );
  for (const asset of [
    { ...f.asset, projectId: "foreign" },
    { ...f.asset, revision: 2 },
    { ...f.asset, selectedContentRevision: 1 },
    { ...f.asset, assetId: ".." },
  ])
    assert.throws(() => response(f.request, { ...f.response, asset }));
  assert.throws(() =>
    response(f.request, {
      ...f.response,
      contentRevision: {
        ...f.content,
        content: { ...f.content.content, name: "changed" },
      },
    }),
  );
  assert.throws(() =>
    response(f.request, { ...f.response, referenceRevision: f.reference }),
  );
  assert.throws(() =>
    response(f.request, { ...f.response, tenantId: "tenant" }),
  );
});
test("five mutation response variants require their actual selected pointers and result kind", () => {
  const f = fixture(),
    common = {
      projectId: "project",
      assetId: "character",
      idempotencyKey: "write",
    };
  const cases = [
    {
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.selectRevision,
      input: {
        ...common,
        request: { expectedAssetRevision: 1, contentRevision: 1 },
      },
      result: {
        kind: "select-content",
        disposition: "committed",
        asset: { ...f.asset, revision: 2, selectedContentRevision: 1 },
        contentRevision: f.content,
        referenceRevision: null,
      },
    },
    {
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.setLocked,
      input: { ...common, request: { expectedAssetRevision: 2, locked: true } },
      result: {
        kind: "set-lock",
        disposition: "committed",
        asset: {
          ...f.asset,
          revision: 3,
          selectedContentRevision: 1,
          locked: true,
        },
        contentRevision: null,
        referenceRevision: null,
      },
    },
    {
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.saveReferenceCandidate,
      input: {
        ...common,
        request: {
          expectedAssetRevision: 2,
          assetContentRevision: 1,
          conceptAssetId: "concept",
          selectionRevision: 1,
        },
      },
      result: {
        kind: "save-reference",
        disposition: "committed",
        asset: {
          ...f.asset,
          revision: 3,
          selectedContentRevision: 1,
          latestReferenceRevision: 1,
        },
        contentRevision: null,
        referenceRevision: f.reference,
      },
    },
    {
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.selectReference,
      input: {
        ...common,
        request: { expectedAssetRevision: 3, referenceRevision: 1 },
      },
      result: {
        kind: "select-reference",
        disposition: "committed",
        asset: {
          ...f.asset,
          revision: 4,
          selectedContentRevision: 1,
          latestReferenceRevision: 1,
          selectedReferenceRevision: 1,
        },
        contentRevision: null,
        referenceRevision: f.reference,
      },
    },
  ];
  for (const item of cases) {
    const parsed = request({ action: item.action, input: item.input });
    assert.deepEqual(response(parsed, item.result), item.result);
    assert.throws(() =>
      response(parsed, { ...item.result, kind: "save-content" }),
    );
  }
});
test("head and dependency projections retain stale references without silently retargeting", () => {
  const f = fixture(),
    asset = {
      ...f.asset,
      revision: 4,
      selectedContentRevision: 1,
      latestReferenceRevision: 1,
      selectedReferenceRevision: 1,
    };
  const view = {
    asset,
    selectedContentRevision: f.content,
    selectedReferenceRevision: f.reference,
    dependencyState: "current",
    staleReasons: [],
    referenceState: "current",
  };
  assert.deepEqual(parsePublicProjectAssetView(view), view);
  const stale = {
    ...view,
    selectedReferenceRevision: {
      ...f.reference,
      assetContentDigest: `sha256:${"b".repeat(64)}`,
    },
    referenceState: "stale",
  };
  assert.deepEqual(parsePublicProjectAssetView(stale), stale);
  assert.throws(() =>
    parsePublicProjectAssetView({ ...stale, referenceState: "current" }),
  );
  assert.throws(() =>
    parsePublicProjectAssetView({ ...view, dependencyState: "stale" }),
  );
  assert.throws(() =>
    parsePublicProjectAssetView({
      ...view,
      staleReasons: ["script-selection-changed"],
      dependencyState: "stale",
    }),
  );
  assert.throws(() =>
    parsePublicProjectAssetView({ ...view, selectedContentRevision: null }),
  );
  assert.throws(() =>
    parsePublicProjectAsset({
      ...asset,
      updatedAt: "2025-01-01T00:00:00.000Z",
    }),
  );
});
test("script source staleness remains distinct from a changed selected script", () => {
  const f = fixture();
  const view = {
    asset: { ...f.asset, selectedContentRevision: 1 },
    selectedContentRevision: {
      ...f.content,
      script: {
        artifactId: "script",
        episodeId: "episode-1",
        contentRevision: 1,
        contentDigest: digest,
      },
    },
    selectedReferenceRevision: null,
    dependencyState: "stale",
    staleReasons: ["script-source-stale"],
    referenceState: "unselected",
  };
  assert.deepEqual(parsePublicProjectAssetView(view), view);
  assert.deepEqual(
    parsePublicProjectAssetView({
      ...view,
      staleReasons: [
        "brief-changed",
        "script-selection-changed",
        "script-source-stale",
      ],
    }).staleReasons,
    ["brief-changed", "script-selection-changed", "script-source-stale"],
  );
  for (const invalid of [
    { ...view, selectedContentRevision: f.content },
    { ...view, dependencyState: "current" },
    { ...view, staleReasons: ["script-source-stale", "script-source-stale"] },
    { ...view, staleReasons: ["unknown-source-state"] },
  ]) {
    assert.throws(() => parsePublicProjectAssetView(invalid));
  }
});
test("paged heads use UTF8 keyset ordering and match returned cursor and requested project", () => {
  const f = fixture(),
    parsed = request({
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.listAssets,
      input: { projectId: "project", afterAssetId: null, limit: 2 },
    });
  const assets = [
    { ...f.asset, assetId: "\ue000" },
    { ...f.asset, assetId: "😀" },
  ];
  assert.deepEqual(response(parsed, { assets, nextAssetId: "😀" }), {
    assets,
    nextAssetId: "😀",
  });
  assert.throws(() =>
    response(parsed, { assets: [...assets].reverse(), nextAssetId: null }),
  );
  assert.throws(() => response(parsed, { assets, nextAssetId: "foreign" }));
  assert.throws(() =>
    response(parsed, {
      assets: [{ ...f.asset, projectId: "foreign" }],
      nextAssetId: null,
    }),
  );
  assert.throws(() =>
    response(parsed, { assets: [], nextAssetId: "character" }),
  );
  assert.throws(() =>
    request({ action: parsed.action, input: { ...parsed.input, limit: 17 } }),
  );
});
test("revision pages reject backwards, foreign and oversized records while allowing whole-record trimming", () => {
  const f = fixture(),
    parsed = request({
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.listRevisions,
      input: {
        projectId: "project",
        assetId: "character",
        afterContentRevision: 0,
        limit: 16,
      },
    });
  assert.deepEqual(
    response(parsed, { revisions: [f.content], nextContentRevision: 1 }),
    { revisions: [f.content], nextContentRevision: 1 },
  );
  assert.throws(() =>
    response(parsed, {
      revisions: [f.content, f.content],
      nextContentRevision: null,
    }),
  );
  assert.throws(() =>
    response(parsed, {
      revisions: [{ ...f.content, assetId: "foreign" }],
      nextContentRevision: null,
    }),
  );
  const maximal = {
    ...f.content,
    content: {
      name: "n",
      setting: "a".repeat(6000),
      visualPrompt: "a".repeat(1900),
    },
  };
  const revisions = Array.from({ length: 16 }, (_, index) => ({
    ...maximal,
    contentRevision: index + 1,
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify({ revisions, nextContentRevision: 16 })) >
      MAX_PROJECT_ASSET_UI_RESPONSE_BYTES,
  );
  assert.throws(() => response(parsed, { revisions, nextContentRevision: 16 }));
});
test("reference reads preserve old Run characters but reject untrusted provenance fields and malformed source bounds", () => {
  const f = fixture(),
    parsed = request({
      action: PROJECT_ASSET_UI_METHOD_ACTIONS.getReferenceRevision,
      input: {
        projectId: "project",
        assetId: "character",
        referenceRevision: 1,
      },
    });
  assert.deepEqual(response(parsed, { referenceRevision: f.reference }), {
    referenceRevision: f.reference,
  });
  for (const source of [
    { ...f.reference.source, url: "https://image.example" },
    { ...f.reference.source, resultIndex: 16 },
    { ...f.reference.source, operationId: "not-uuid" },
    { ...f.reference.source, packageDigest: "byte-hash" },
  ])
    assert.throws(() =>
      response(parsed, { referenceRevision: { ...f.reference, source } }),
    );
  assert.throws(() =>
    response(parsed, {
      referenceRevision: { ...f.reference, referenceRevision: 2 },
    }),
  );
});
