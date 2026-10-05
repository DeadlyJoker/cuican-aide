import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAssetToolsCodec as codec,
  PROJECT_ASSET_RUNTIME_OPERATIONS,
  parseProjectAssetToolCommand,
} from "./project-asset-tools-contract.ts";
const digest = `sha256:${"a".repeat(64)}`,
  at = "2026-10-06T00:00:00.000Z";
const head = {
  projectId: "p",
  assetId: "a",
  kind: "character",
  revision: 1,
  latestContentRevision: 1,
  selectedContentRevision: null,
  latestReferenceRevision: 0,
  selectedReferenceRevision: null,
  locked: false,
  createdAt: at,
  updatedAt: at,
};
const revision = {
  projectId: "p",
  assetId: "a",
  kind: "character",
  contentRevision: 1,
  brief: { briefRevision: 1, contentDigest: digest },
  script: null,
  createdAt: at,
  contentDigest: digest,
};
const scope = {
  version: "crewon.project-asset-runtime-scope.v1",
  runId: "r",
  threadId: "t",
  projectId: "p",
  bindingId: "b",
  bindingRevision: 1,
  workspaceId: null,
  stage: {
    kind: "assets",
    assetKind: "character",
    briefRevision: 1,
    script: null,
  },
  sources: { brief: { briefRevision: 1, contentDigest: digest }, script: null },
  allowedOperations: PROJECT_ASSET_RUNTIME_OPERATIONS,
  admissionDigest: digest,
};
test("Node assets parses all five narrow methods and independent context without actor or key", () => {
  const requests = {
    listAssets: {
      projectId: "p",
      kind: "character",
      afterAssetId: null,
      limit: 4,
    },
    getAsset: { projectId: "p", assetId: "a" },
    listRevisions: {
      projectId: "p",
      assetId: "a",
      afterContentRevision: 0,
      limit: 4,
    },
    readContent: {
      projectId: "p",
      assetId: "a",
      contentRevision: 1,
      offset: 0,
    },
    saveCandidate: {
      projectId: "p",
      assetId: null,
      kind: "character",
      expectedAssetRevision: 0,
      briefRevision: 1,
      script: null,
      content: { name: "导演", setting: "夜航", visualPrompt: "portrait" },
    },
  } as const;
  for (const [method, request] of Object.entries(requests)) {
    assert.deepEqual(
      codec.parseRequest(method as keyof typeof requests, request),
      request,
    );
    assert.throws(() =>
      codec.parseRequest(method as keyof typeof requests, {
        ...request,
        actor: { actorId: "caller" },
      }),
    );
  }
  assert.deepEqual(codec.parseContextResponse({ scope }), { scope });
  assert.deepEqual(codec.parseContextResponse({ scope: null }), {
    scope: null,
  });
  assert.throws(() =>
    codec.parseContextResponse({
      scope: {
        ...scope,
        allowedOperations: [
          ...PROJECT_ASSET_RUNTIME_OPERATIONS,
          "image_submit",
        ],
      },
    }),
  );
  assert.throws(() =>
    codec.parseContextResponse({
      scope: {
        ...scope,
        sources: {
          ...scope.sources,
          brief: { ...scope.sources.brief, briefRevision: 2 },
        },
      },
    }),
  );
});
test("response exact project/kind/asset and immutable metadata binding", () => {
  const request = { projectId: "p", assetId: "a" };
  assert.deepEqual(
    codec.parseResponse("getAsset", request, {
      view: {
        asset: head,
        selectedRevision: null,
        dependencyState: "unselected",
        staleReasons: [],
        referenceState: "unselected",
      },
    }).view?.asset,
    head,
  );
  assert.throws(() =>
    codec.parseResponse("getAsset", request, {
      view: {
        asset: { ...head, projectId: "foreign" },
        selectedRevision: null,
        dependencyState: "unselected",
        staleReasons: [],
        referenceState: "unselected",
      },
    }),
  );
  const save = {
    projectId: "p",
    assetId: null,
    kind: "character",
    expectedAssetRevision: 0,
    briefRevision: 1,
    script: null,
    content: { name: "n", setting: "s", visualPrompt: "v" },
  } as const;
  assert.equal(
    codec.parseResponse("saveCandidate", save, {
      kind: "save-content",
      disposition: "committed",
      asset: head,
      contentRevision: revision,
    }).asset.assetId,
    "a",
  );
  assert.throws(() =>
    codec.parseResponse("saveCandidate", save, {
      kind: "save-content",
      disposition: "committed",
      asset: head,
      contentRevision: {
        ...revision,
        brief: { briefRevision: 2, contentDigest: digest },
      },
    }),
  );
});
test("whole metadata pages use last returned cursor and at most four items", () => {
  const request = {
    projectId: "p",
    kind: "character",
    afterAssetId: null,
    limit: 4,
  } as const;
  assert.equal(
    codec.parseResponse("listAssets", request, {
      assets: [head],
      nextAssetId: "a",
    }).nextAssetId,
    "a",
  );
  assert.throws(() =>
    codec.parseResponse("listAssets", request, {
      assets: [head],
      nextAssetId: "missing",
    }),
  );
  assert.throws(() =>
    codec.parseResponse("listAssets", request, {
      assets: [head, head],
      nextAssetId: null,
    }),
  );
  assert.throws(() =>
    codec.parseRequest("listAssets", { ...request, limit: 5 }),
  );
});
test("Unicode content paging preserves code point boundaries and exact cursor", () => {
  const request = {
      projectId: "p",
      assetId: "a",
      contentRevision: 1,
      offset: 0,
    },
    text = "😀".repeat(1024);
  assert.equal(
    codec.parseResponse("readContent", request, {
      contentDigest: digest,
      format: "canonical-json",
      offset: 0,
      nextOffset: 1024,
      totalCodePoints: 1025,
      text,
    }).text,
    text,
  );
  assert.throws(() =>
    codec.parseResponse("readContent", request, {
      contentDigest: digest,
      format: "canonical-json",
      offset: 0,
      nextOffset: 1023,
      totalCodePoints: 1025,
      text,
    }),
  );
  assert.throws(() =>
    codec.parseResponse("readContent", request, {
      contentDigest: digest,
      format: "canonical-json",
      offset: 0,
      nextOffset: null,
      totalCodePoints: 1,
      text: "\ud800",
    }),
  );
});
test("unpaired surrogate, duplicate/accessor fields and sparse arrays fail without invoking getters", () => {
  let read = 0;
  const input = Object.defineProperty({ assetId: "a" }, "projectId", {
    enumerable: true,
    get() {
      read++;
      return "p";
    },
  });
  assert.throws(() => codec.parseRequest("getAsset", input));
  assert.equal(read, 0);
  const assets = [head];
  Object.defineProperty(assets, "0", {
    enumerable: true,
    get() {
      read++;
      return head;
    },
  });
  assert.throws(() =>
    codec.parseResponse(
      "listAssets",
      { projectId: "p", kind: "character", afterAssetId: null, limit: 4 },
      { assets, nextAssetId: null },
    ),
  );
  assert.equal(read, 0);
  assert.throws(() =>
    codec.parseRequest("getAsset", { projectId: "p", assetId: "\udc00" }),
  );
  assert.throws(() =>
    codec.parseContextResponse({
      scope: { ...scope, allowedOperations: new Array(11) },
    }),
  );
});
test("public opaque ids preserve historical characters while locators reject dot segments", () => {
  assert.equal(
    codec.parseRequest("getAsset", { projectId: "中文 p", assetId: "_old" })
      .assetId,
    "_old",
  );
  for (const assetId of [".", "..", "a\n", " a"])
    assert.throws(() =>
      codec.parseRequest("getAsset", { projectId: "p", assetId }),
    );
});
test("encoded model wrapper bound includes JSON escaping", () => {
  const request = {
    projectId: "p",
    assetId: "a",
    contentRevision: 1,
    offset: 0,
  };
  assert.throws(() =>
    codec.parseResponse("readContent", request, {
      contentDigest: digest,
      format: "canonical-json",
      offset: 0,
      nextOffset: null,
      totalCodePoints: 1024,
      text: "\u0000".repeat(1024),
    }),
  );
  assert.throws(() =>
    codec.parseResponse("readContent", request, {
      contentDigest: digest,
      format: "canonical-json",
      offset: 0,
      nextOffset: null,
      totalCodePoints: 1025,
      text: "a".repeat(1025),
    }),
  );
});
test("model omission normalizes only the three deliberate nullable fields without replacing raw command identity", () => {
  assert.deepEqual(
    parseProjectAssetToolCommand("listAssets", {
      projectId: "p",
      kind: "character",
      limit: 4,
    }),
    { projectId: "p", kind: "character", afterAssetId: null, limit: 4 },
  );
  const request = {
    projectId: "p",
    kind: "character",
    expectedAssetRevision: 0,
    briefRevision: 1,
    content: { name: "n", setting: "s", visualPrompt: "v" },
  };
  assert.deepEqual(parseProjectAssetToolCommand("saveCandidate", request), {
    ...request,
    assetId: null,
    script: null,
  });
  assert.throws(() =>
    parseProjectAssetToolCommand("saveCandidate", {
      ...request,
      idempotencyKey: "caller",
    }),
  );
  assert.throws(() =>
    parseProjectAssetToolCommand("getAsset", { projectId: "p" }),
  );
});
test("same selected script with changed outline source reports the distinct bounded stale reason", () => {
  const value = {
    view: {
      asset: { ...head, selectedContentRevision: 1 },
      selectedRevision: {
        ...revision,
        script: {
          artifactId: "script",
          episodeId: "episode",
          contentRevision: 1,
          contentDigest: digest,
        },
      },
      dependencyState: "stale",
      staleReasons: ["script-source-stale"],
      referenceState: "unselected",
    },
  };
  assert.deepEqual(
    codec.parseResponse("getAsset", { projectId: "p", assetId: "a" }, value)
      .view?.staleReasons,
    ["script-source-stale"],
  );
  assert.throws(() =>
    codec.parseResponse(
      "getAsset",
      { projectId: "p", assetId: "a" },
      { view: { ...value.view, staleReasons: ["unapproved"] } },
    ),
  );
});
