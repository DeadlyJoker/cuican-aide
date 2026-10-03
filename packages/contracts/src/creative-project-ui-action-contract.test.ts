import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATIVE_PROJECT_UI_ACTIONS,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  CREWON_CREATIVE_PROJECTS_SERVICE,
  parseCreativeProjectUiActionRequest,
  parseCreativeProjectUiActionResponse,
} from "./creative-project-ui-action-contract.ts";
import { formatCreativeProjectCursor } from "./creative-project-control-contract.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

const at = "2026-10-03T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const projectId = "project/中文 %2F";
const assetId = "asset\\中文%";
const project = {
  projectId,
  kind: "short-drama",
  title: "窗边的信",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: at,
  updatedAt: at,
};
const brief = {
  projectId,
  briefRevision: 1,
  text: " 原始需求\n下一行 ",
  contentDigest: digest,
  createdAt: at,
};
const asset = {
  projectId,
  assetId,
  name: "概念画面",
  revision: 1,
  latestAssetRevision: 1,
  createdAt: at,
  updatedAt: at,
};
const assetRevision = {
  projectId,
  assetId,
  assetRevision: 1,
  briefRevision: 1,
  briefContentDigest: digest,
  prompt: " 光线\n陶壶 ",
  contentDigest: digest,
  createdAt: at,
};
const idempotencyKey = "once-key";
const vectors = [
  ["listProjects", { query: {} }, { projects: [project], nextCursor: null }],
  ["getProject", { projectId }, { project }],
  [
    "createProject",
    {
      request: { title: project.title, briefText: brief.text },
      idempotencyKey,
    },
    { disposition: "committed", project, brief },
  ],
  [
    "renameProject",
    {
      projectId,
      request: { title: "新名称", expectedProjectRevision: 2 },
      idempotencyKey,
    },
    {
      disposition: "committed",
      project: { ...project, revision: 3, title: "新名称" },
    },
  ],
  [
    "setProjectState",
    {
      projectId,
      request: { state: "archived", expectedProjectRevision: 2 },
      idempotencyKey,
    },
    {
      disposition: "replayed",
      project: { ...project, revision: 3, state: "archived" },
    },
  ],
  [
    "appendBrief",
    {
      projectId,
      request: { text: brief.text, expectedProjectRevision: 2 },
      idempotencyKey,
    },
    {
      disposition: "committed",
      project: { ...project, revision: 3, latestBriefRevision: 2 },
      brief: { ...brief, briefRevision: 2 },
    },
  ],
  ["getBrief", { projectId, briefRevision: 1 }, { brief }],
  [
    "listBriefs",
    { projectId, query: {} },
    { briefs: [brief], nextAfterBriefRevision: 1 },
  ],
  [
    "createConcept",
    {
      projectId,
      request: {
        name: asset.name,
        briefRevision: 1,
        prompt: assetRevision.prompt,
        expectedProjectRevision: 2,
      },
      idempotencyKey,
    },
    {
      disposition: "committed",
      project: { ...project, revision: 3 },
      asset,
      assetRevision,
    },
  ],
  ["getConceptAsset", { projectId, assetId }, { asset }],
  [
    "listConceptAssets",
    { projectId, query: {} },
    { assets: [asset], nextAfterAssetId: assetId },
  ],
  [
    "appendConceptRevision",
    {
      projectId,
      assetId,
      request: {
        briefRevision: 1,
        prompt: assetRevision.prompt,
        expectedProjectRevision: 2,
        expectedAssetMetadataRevision: 1,
      },
      idempotencyKey,
    },
    {
      disposition: "replayed",
      project: { ...project, revision: 3 },
      asset: { ...asset, revision: 2, latestAssetRevision: 2 },
      assetRevision: { ...assetRevision, assetRevision: 2 },
    },
  ],
  [
    "getConceptRevision",
    { projectId, assetId, assetRevision: 1 },
    { assetRevision },
  ],
  [
    "listConceptRevisions",
    { projectId, assetId, query: {} },
    { revisions: [assetRevision], nextAfterAssetRevision: 1 },
  ],
] as const;
function request(method: string, input: unknown) {
  return parseCreativeProjectUiActionRequest({
    action: `crewon.creative-projects.v1.${method}`,
    input,
  });
}
function rejects(work: () => unknown) {
  assert.throws(work, ContractValidationError);
}

test("fourteen exact metadata actions share an explicit requirement and validate public responses", () => {
  assert.equal(CREWON_CREATIVE_PROJECTS_SERVICE, "crewon.creative-projects");
  assert.equal(CREWON_CREATIVE_PROJECTS_API_VERSION, "1");
  assert.equal(CREATIVE_PROJECT_UI_ACTIONS.length, 14);
  assert.ok(Object.isFrozen(CREATIVE_PROJECT_UI_ACTIONS));
  assert.deepEqual(
    vectors.map(([method]) => `crewon.creative-projects.v1.${method}`),
    CREATIVE_PROJECT_UI_ACTIONS,
  );
  for (const [method, input, response] of vectors) {
    const checked = request(method, input);
    assert.ok(Object.isFrozen(checked));
    assert.ok(Object.isFrozen(checked.input));
    const parsed = parseCreativeProjectUiActionResponse(checked, response);
    assert.deepEqual(parsed, response);
    assert.ok(Object.isFrozen(parsed));
  }
});

test("all actions reject missing, extra and injected authority fields", () => {
  for (const [method, input] of vectors) {
    for (const key of [
      "actor",
      "actorId",
      "ownerPrincipalId",
      "tenantId",
      "spaceId",
      "payer",
      "profile",
      "profileId",
    ])
      rejects(() => request(method, { ...input, [key]: "injected" }));
    const missing = { ...input } as Record<string, unknown>;
    delete missing[Object.keys(missing)[0]!];
    rejects(() => request(method, missing));
    if ("request" in input)
      rejects(() =>
        request(method, {
          ...input,
          request: { ...input.request, actorId: "injected" },
        }),
      );
    if ("query" in input)
      rejects(() =>
        request(method, {
          ...input,
          query: { ...input.query, tenantId: "injected" },
        }),
      );
  }
  for (const action of [
    "crewon.creative-projects.v2.getProject",
    "crewon.creative-projects.v1.generate",
    "example.creative-projects.v1.getProject",
    "getProject",
    null,
  ])
    rejects(() =>
      parseCreativeProjectUiActionRequest({ action, input: { projectId } }),
    );
  rejects(() =>
    parseCreativeProjectUiActionRequest({
      action: CREATIVE_PROJECT_UI_ACTIONS[1],
      input: { projectId },
      actorId: "injected",
    }),
  );
});

test("request copying never invokes accessors or serialization hooks", () => {
  let calls = 0;
  const hook = () => {
    calls++;
    return { projectId };
  };
  const envelope = { action: CREATIVE_PROJECT_UI_ACTIONS[1] };
  Object.defineProperty(envelope, "input", { enumerable: true, get: hook });
  rejects(() => parseCreativeProjectUiActionRequest(envelope));
  rejects(() =>
    request("getProject", {
      get projectId() {
        calls++;
        return projectId;
      },
    }),
  );
  rejects(() => request("getProject", { projectId, toJSON: hook }));
  rejects(() =>
    request(
      "getProject",
      Object.assign(Object.create({ inherited: true }), { projectId }),
    ),
  );
  rejects(() => request("getProject", { projectId, [Symbol("hidden")]: true }));
  const hidden = { projectId };
  Object.defineProperty(hidden, "hidden", { value: "injected" });
  rejects(() => request("getProject", hidden));
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects(() => request("listProjects", { query: sparse }));
  assert.equal(calls, 0);
});

test("JSON list queries preserve defaults and require numeric noncoerced cursors", () => {
  assert.deepEqual(request("listProjects", { query: {} }).input, {
    query: { state: "active", cursor: null, limit: 20 },
  });
  assert.deepEqual(request("listBriefs", { projectId, query: {} }).input, {
    projectId,
    query: { afterBriefRevision: 0, limit: 20 },
  });
  assert.deepEqual(
    request("listConceptAssets", { projectId, query: {} }).input,
    { projectId, query: { afterAssetId: null, limit: 20 } },
  );
  assert.deepEqual(
    request("listConceptRevisions", { projectId, assetId, query: {} }).input,
    { projectId, assetId, query: { afterAssetRevision: 0, limit: 20 } },
  );
  for (const limit of ["20", null, 0, -1, 1.5, 51, Number.MAX_SAFE_INTEGER + 1])
    rejects(() => request("listProjects", { query: { limit } }));
  for (const value of ["1", null, -1, 0.5]) {
    rejects(() =>
      request("listBriefs", {
        projectId,
        query: { afterBriefRevision: value },
      }),
    );
    rejects(() =>
      request("listConceptRevisions", {
        projectId,
        assetId,
        query: { afterAssetRevision: value },
      }),
    );
  }
  rejects(() => request("getBrief", { projectId, briefRevision: "1" }));
  rejects(() =>
    request("getConceptRevision", { projectId, assetId, assetRevision: 0 }),
  );
});

test("state-bound root cursor is reused without decoding or accepting a different state", () => {
  const cursor = formatCreativeProjectCursor({
    state: "archived",
    projectId,
    updatedAt: at,
  });
  assert.deepEqual(
    request("listProjects", { query: { state: "archived", cursor, limit: 50 } })
      .input,
    { query: { state: "archived", cursor, limit: 50 } },
  );
  rejects(() =>
    request("listProjects", { query: { state: "active", cursor } }),
  );
  rejects(() =>
    request("listProjects", {
      query: { cursor: encodeURIComponent(cursor) + "%3D" },
    }),
  );
  rejects(() => request("listProjects", { query: { cursor: "" } }));
});

test("opaque IDs and original text stay detached and are not transport-encoded", () => {
  const input = { projectId, assetId };
  const checked = request("getConceptAsset", input);
  input.projectId = "mutated";
  assert.deepEqual(checked.input, { projectId, assetId });
  for (const bad of [".", "..", " leading", "a\nb", "\ud800"])
    rejects(() => request("getProject", { projectId: bad }));
  const valid = request("createProject", {
    request: { title: project.title, briefText: brief.text },
    idempotencyKey,
  });
  assert.equal(
    "request" in valid.input &&
      "briefText" in valid.input.request &&
      valid.input.request.briefText,
    brief.text,
  );
  for (const key of ["same,same", "first, second", " key", "a".repeat(129)])
    rejects(() =>
      request("createProject", {
        request: { title: project.title, briefText: brief.text },
        idempotencyKey: key,
      }),
    );
});

test("the UI input budget and authoritative brief/prompt limits reject oversized requests", () => {
  assert.equal(
    "request" in
      request("createProject", {
        request: { title: project.title, briefText: "a".repeat(8192) },
        idempotencyKey,
      }).input,
    true,
  );
  rejects(() =>
    request("createProject", {
      request: { title: project.title, briefText: "a".repeat(8193) },
      idempotencyKey,
    }),
  );
  rejects(() =>
    request("createProject", {
      request: { title: project.title, briefText: "a".repeat(24 * 1024) },
      idempotencyKey,
    }),
  );
  rejects(() =>
    request("createConcept", {
      projectId,
      request: {
        name: asset.name,
        briefRevision: 1,
        prompt: "😀".repeat(1001),
        expectedProjectRevision: 2,
      },
      idempotencyKey,
    }),
  );
});

test("GET response identity and revision must match the checked request", () => {
  rejects(() =>
    parseCreativeProjectUiActionResponse(request("getProject", { projectId }), {
      project: { ...project, projectId: "other" },
    }),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("getBrief", { projectId, briefRevision: 1 }),
      { brief: { ...brief, briefRevision: 2 } },
    ),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("getConceptAsset", { projectId, assetId }),
      { asset: { ...asset, assetId: "other" } },
    ),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("getConceptRevision", { projectId, assetId, assetRevision: 1 }),
      { assetRevision: { ...assetRevision, projectId: "other" } },
    ),
  );
  for (const [method, input, output] of vectors)
    rejects(() =>
      parseCreativeProjectUiActionResponse(request(method, input), {
        ...output,
        actorId: "injected",
      }),
    );
});

test("write results are bound to the original request text and expected revision", () => {
  const create = vectors[2]!;
  rejects(() =>
    parseCreativeProjectUiActionResponse(request(create[0], create[1]), {
      ...create[2],
      brief: { ...brief, text: "different" },
    }),
  );
  const rename = vectors[3]!;
  rejects(() =>
    parseCreativeProjectUiActionResponse(request(rename[0], rename[1]), {
      disposition: "committed",
      project,
    }),
  );
  const concept = vectors[8]!;
  rejects(() =>
    parseCreativeProjectUiActionResponse(request(concept[0], concept[1]), {
      ...concept[2],
      assetRevision: { ...assetRevision, prompt: "different" },
    }),
  );
  const append = vectors[11]!;
  rejects(() =>
    parseCreativeProjectUiActionResponse(request(append[0], append[1]), {
      ...append[2],
      asset: {
        ...asset,
        assetId: "other",
        revision: 2,
        latestAssetRevision: 2,
      },
    }),
  );
});

test("list result order, state and actual continuation remain enforced", () => {
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("listProjects", { query: {} }),
      { projects: [{ ...project, state: "archived" }], nextCursor: null },
    ),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("listBriefs", { projectId, query: { afterBriefRevision: 1 } }),
      { briefs: [brief], nextAfterBriefRevision: 1 },
    ),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("listConceptAssets", { projectId, query: {} }),
      { assets: [asset], nextAfterAssetId: "other" },
    ),
  );
  rejects(() =>
    parseCreativeProjectUiActionResponse(
      request("listConceptRevisions", { projectId, assetId, query: {} }),
      {
        revisions: [{ ...assetRevision, assetId: "other" }],
        nextAfterAssetRevision: 1,
      },
    ),
  );
});

test("responses retain the 60 KiB budget, no hooks and bounded dense arrays", () => {
  const checked = request("listBriefs", { projectId, query: { limit: 50 } });
  const briefs = Array.from({ length: 8 }, (_, index) => ({
    ...brief,
    briefRevision: index + 1,
    text: "a".repeat(8192),
  }));
  rejects(() =>
    parseCreativeProjectUiActionResponse(checked, {
      briefs,
      nextAfterBriefRevision: 8,
    }),
  );
  let calls = 0;
  const output = { nextAfterBriefRevision: null };
  Object.defineProperty(output, "briefs", {
    enumerable: true,
    get() {
      calls++;
      return [];
    },
  });
  rejects(() => parseCreativeProjectUiActionResponse(checked, output));
  assert.equal(calls, 0);
});
