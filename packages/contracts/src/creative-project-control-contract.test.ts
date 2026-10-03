import assert from "node:assert/strict";
import test from "node:test";
import * as api from "./creative-project-control-contract.ts";
import { ContractValidationError } from "./contract-validation-error.ts";

const at = "2026-10-03T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const project = {
  projectId: "project/中文 %",
  kind: "short-drama",
  title: "窗边的信",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: at,
  updatedAt: at,
} as const;
const brief = {
  projectId: project.projectId,
  briefRevision: 1,
  text: " 原始需求\n下一行 ",
  contentDigest: digest,
  createdAt: at,
};
const asset = {
  projectId: project.projectId,
  assetId: "asset\\中文%",
  name: "概念画面",
  revision: 1,
  latestAssetRevision: 1,
  createdAt: at,
  updatedAt: at,
};
const assetRevision = {
  projectId: project.projectId,
  assetId: asset.assetId,
  assetRevision: 1,
  briefRevision: 1,
  briefContentDigest: digest,
  prompt: " 窗边的一只陶壶\n柔和日光 ",
  contentDigest: digest,
  createdAt: at,
};
const rejects = (work: () => unknown) =>
  assert.throws(
    work,
    (error) =>
      error instanceof ContractValidationError &&
      error.code === "creative_project_control_contract_invalid",
  );
const requests = [
  {
    parse: api.parseCreateCreativeProjectRequest,
    value: { title: project.title, briefText: brief.text },
  },
  {
    parse: api.parseRenameCreativeProjectRequest,
    value: { title: "新名称", expectedProjectRevision: 2 },
  },
  {
    parse: api.parseSetCreativeProjectStateRequest,
    value: { state: "archived", expectedProjectRevision: 2 },
  },
  {
    parse: api.parseAppendProjectBriefRequest,
    value: { text: brief.text, expectedProjectRevision: 2 },
  },
  {
    parse: api.parseCreateConceptAssetRequest,
    value: {
      name: asset.name,
      briefRevision: 1,
      prompt: assetRevision.prompt,
      expectedProjectRevision: 2,
    },
  },
  {
    parse: api.parseAppendConceptAssetRevisionRequest,
    value: {
      briefRevision: 1,
      prompt: assetRevision.prompt,
      expectedProjectRevision: 2,
      expectedAssetMetadataRevision: 1,
    },
  },
];

test("all six mutation requests detach exact business fields and reject identity injection", () => {
  for (const { parse, value } of requests) {
    assert.deepEqual(parse(value), value);
    assert.ok(Object.isFrozen(parse(value)));
    for (const key of [
      "projectId",
      "assetId",
      "idempotencyKey",
      "ownerPrincipalId",
      "tenantId",
      "spaceId",
      "actorId",
      "principalId",
    ])
      rejects(() => parse({ ...value, [key]: "injected" }));
    const missing = { ...value } as Record<string, unknown>;
    delete missing[Object.keys(missing)[0]!];
    rejects(() => parse(missing));
  }
});
test("requests never run caller accessors, toJSON or custom iterator hooks", () => {
  let calls = 0;
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      get title() {
        calls++;
        return "title";
      },
      briefText: "brief",
    }),
  );
  rejects(() =>
    api.parseCreateCreativeProjectRequest(
      Object.assign(Object.create({ title: "title" }), { briefText: "brief" }),
    ),
  );
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      title: "title",
      briefText: "brief",
      toJSON() {
        calls++;
        return {};
      },
    }),
  );
  const value = { title: "title", briefText: "brief" };
  Object.defineProperty(value, "hidden", { value: "injected" });
  rejects(() => api.parseCreateCreativeProjectRequest(value));
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      title: "title",
      briefText: "brief",
      [Symbol("hidden")]: "injected",
    }),
  );
  assert.equal(calls, 0);
});
test("title scalar, brief UTF-8 and confirmed prompt UTF-16 limits preserve original text", () => {
  assert.equal(
    api.parseCreateCreativeProjectRequest({
      title: "😀".repeat(160),
      briefText: "汉".repeat(2730) + "aa",
    }).title.length,
    320,
  );
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      title: "😀".repeat(161),
      briefText: "brief",
    }),
  );
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      title: "title ",
      briefText: "brief",
    }),
  );
  rejects(() =>
    api.parseCreateCreativeProjectRequest({
      title: "title",
      briefText: "汉".repeat(2731),
    }),
  );
  assert.equal(
    api.parseCreateCreativeProjectRequest({
      title: "title",
      briefText: "\n" + "a".repeat(8190) + "\n",
    }).briefText.length,
    8192,
  );
  assert.equal(
    api.parseCreateConceptAssetRequest({
      name: "concept",
      briefRevision: 1,
      expectedProjectRevision: 2,
      prompt: "😀".repeat(1000),
    }).prompt.length,
    2000,
  );
  rejects(() =>
    api.parseCreateConceptAssetRequest({
      name: "concept",
      briefRevision: 1,
      expectedProjectRevision: 2,
      prompt: "😀".repeat(1001),
    }),
  );
  for (const text of ["\ud800", "\udfff", "\0", "\u000b", "\u007f", " \n\t "])
    rejects(() =>
      api.parseCreateCreativeProjectRequest({
        title: "title",
        briefText: text,
      }),
    );
  assert.equal(
    api.parseCreateCreativeProjectRequest({
      title: project.title,
      briefText: brief.text,
    }).briefText,
    brief.text,
  );
});
test("opaque IDs preserve routable Unicode and revisions reject coercion/unsafe integers", () => {
  for (const id of [project.projectId, asset.assetId, "%2F", "😀".repeat(64)])
    assert.equal(api.parseCreativeProjectId(id), id);
  for (const id of [
    "",
    ".",
    "..",
    " leading",
    "trailing ",
    "a\nb",
    "\ud800",
    "😀".repeat(65),
  ])
    rejects(() => api.parseCreativeProjectId(id));
  assert.equal(
    api.parseCreativeProjectRevision(Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(
    api.parseCreativeProjectRevision(String(Number.MAX_SAFE_INTEGER)),
    Number.MAX_SAFE_INTEGER,
  );
  for (const revision of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "01",
    "+1",
    "1.0",
    "1e2",
    true,
    null,
  ])
    rejects(() => api.parseCreativeProjectRevision(revision));
  assert.equal(api.parseCreativeProjectIdempotencyKey("once-key"), "once-key");
  for (const key of [
    "",
    " ",
    " key",
    "key\n",
    "a".repeat(129),
    "one,two",
    "one, two",
    "same,same",
  ])
    rejects(() => api.parseCreativeProjectIdempotencyKey(key));
});
test("list queries have bounded defaults and never permit unknown, duplicate or inherited data", () => {
  assert.deepEqual(api.parseCreativeProjectListQuery({}), {
    state: "active",
    after: null,
    limit: 20,
  });
  assert.deepEqual(api.parseProjectBriefListQuery({}), {
    afterBriefRevision: 0,
    limit: 20,
  });
  assert.deepEqual(api.parseConceptAssetListQuery({}), {
    afterAssetId: null,
    limit: 20,
  });
  assert.deepEqual(api.parseConceptRevisionListQuery({}), {
    afterAssetRevision: 0,
    limit: 20,
  });
  assert.deepEqual(
    api.parseConceptAssetListQuery(
      Object.assign(Object.create({ ignored: "inherited" }), {
        afterAssetId: asset.assetId,
        limit: "50",
      }),
    ),
    { afterAssetId: asset.assetId, limit: 50 },
  );
  for (const parse of [
    api.parseCreativeProjectListQuery,
    api.parseProjectBriefListQuery,
    api.parseConceptAssetListQuery,
    api.parseConceptRevisionListQuery,
  ]) {
    for (const query of [
      { limit: "0" },
      { limit: "51" },
      { limit: "01" },
      { limit: 1 },
      { limit: ["1", "2"] },
      { tenantId: "injected" },
    ])
      rejects(() => parse(query));
    rejects(() =>
      parse({
        get limit() {
          throw new Error("must not evaluate");
        },
      }),
    );
  }
  api.parseCreativeProjectEmptyQuery(Object.create(null));
  rejects(() => api.parseCreativeProjectEmptyQuery({ state: "active" }));
  rejects(() => api.parseCreativeProjectListQuery({ state: "deleted" }));
});
test("canonical cursor binds the list state and exact Unicode anchor", () => {
  const after = { updatedAt: at, projectId: project.projectId };
  const cursor = api.formatCreativeProjectCursor("archived", after);
  assert.equal(
    api.formatCreativeProjectCursor({ ...after, state: "archived" }),
    cursor,
  );
  assert.deepEqual(
    api.parseCreativeProjectListQuery({
      state: "archived",
      cursor,
      limit: "3",
    }),
    { state: "archived", after, limit: 3 },
  );
  rejects(() => api.parseCreativeProjectListQuery({ state: "active", cursor }));
  rejects(() =>
    api.parseCreativeProjectListQuery({
      state: "archived",
      cursor: cursor + "=",
    }),
  );
  rejects(() =>
    api.parseCreativeProjectListQuery({ cursor: "a".repeat(1025) }),
  );
  const version = btoa(
    JSON.stringify(["unknown", "active", at, "project"]),
  ).replace(/=+$/u, "");
  rejects(() => api.parseCreativeProjectListQuery({ cursor: version }));
});
test("public DTOs omit private fields, reject malformed digests/dates and keep versions independent of clocks", () => {
  const samples = [
    { parse: api.parsePublicCreativeProject, value: project },
    { parse: api.parsePublicProjectBrief, value: brief },
    { parse: api.parsePublicConceptAsset, value: asset },
    { parse: api.parsePublicConceptRevision, value: assetRevision },
  ];
  for (const { parse, value } of samples) {
    assert.deepEqual(parse(value), value);
    for (const key of [
      "ownerPrincipalId",
      "tenantId",
      "spaceId",
      "createdByActorId",
      "updatedByActorId",
      "schemaVersion",
    ])
      rejects(() => parse({ ...value, [key]: "private" }));
  }
  assert.equal(
    api.parsePublicCreativeProject({
      ...project,
      updatedAt: "2025-01-01T00:00:00.000Z",
    }).updatedAt,
    "2025-01-01T00:00:00.000Z",
  );
  rejects(() =>
    api.parsePublicCreativeProject({ ...project, latestBriefRevision: 2 }),
  );
  rejects(() =>
    api.parsePublicConceptAsset({ ...asset, latestAssetRevision: 2 }),
  );
  rejects(() =>
    api.parsePublicProjectBrief({ ...brief, contentDigest: "a".repeat(64) }),
  );
  rejects(() =>
    api.parsePublicConceptRevision({
      ...assetRevision,
      briefContentDigest: `sha256:${"A".repeat(64)}`,
    }),
  );
  rejects(() =>
    api.parsePublicProjectBrief({
      ...brief,
      createdAt: "2026-02-30T00:00:00.000Z",
    }),
  );
});
test("exact read envelopes bind each route identity and immutable revision", () => {
  assert.deepEqual(
    api.parseGetCreativeProjectResponse(
      { project },
      { projectId: project.projectId },
    ),
    { project },
  );
  assert.deepEqual(
    api.parseGetProjectBriefResponse(
      { brief },
      { projectId: project.projectId, briefRevision: 1 },
    ),
    { brief },
  );
  assert.deepEqual(
    api.parseGetConceptAssetResponse(
      { asset },
      { projectId: project.projectId, assetId: asset.assetId },
    ),
    { asset },
  );
  assert.deepEqual(
    api.parseGetConceptRevisionResponse(
      { assetRevision },
      {
        projectId: project.projectId,
        assetId: asset.assetId,
        assetRevision: 1,
      },
    ),
    { assetRevision },
  );
  rejects(() =>
    api.parseGetCreativeProjectResponse({ project }, { projectId: "other" }),
  );
  rejects(() =>
    api.parseGetProjectBriefResponse(
      { brief },
      { projectId: project.projectId, briefRevision: 2 },
    ),
  );
  rejects(() =>
    api.parseGetConceptAssetResponse(
      { asset },
      { projectId: project.projectId, assetId: "other" },
    ),
  );
  rejects(() =>
    api.parseGetConceptRevisionResponse(
      { assetRevision },
      { projectId: "other", assetId: asset.assetId, assetRevision: 1 },
    ),
  );
});
test("root pages enforce state, scalar descending order, uniqueness and actual returned cursor", () => {
  const first = { ...project, projectId: "𐀀" },
    last = { ...project, projectId: "\ue000" };
  const query = api.parseCreativeProjectListQuery({ state: "all", limit: "2" });
  const nextCursor = api.formatCreativeProjectCursor("all", {
    updatedAt: at,
    projectId: last.projectId,
  });
  assert.deepEqual(
    api.parseCreativeProjectListResponse(
      { projects: [first, last], nextCursor },
      query,
    ),
    { projects: [first, last], nextCursor },
  );
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: [last, first], nextCursor },
      query,
    ),
  );
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: [first, first], nextCursor: null },
      query,
    ),
  );
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: [{ ...first, state: "archived" }], nextCursor: null },
      api.parseCreativeProjectListQuery({}),
    ),
  );
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: [first], nextCursor },
      query,
    ),
  );
  rejects(() =>
    api.parseCreativeProjectListResponse({ projects: [], nextCursor }, query),
  );
  const anchor = api.parseCreativeProjectListQuery({
    state: "all",
    cursor: nextCursor,
  });
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: [last], nextCursor: null },
      anchor,
    ),
  );
});
test("child pages bind exact project/asset and allow bounded short-page continuation", () => {
  const briefQuery = {
    projectId: project.projectId,
    afterBriefRevision: 0,
    limit: 20,
  };
  assert.deepEqual(
    api.parseProjectBriefListResponse(
      { briefs: [brief], nextAfterBriefRevision: 1 },
      briefQuery,
    ),
    { briefs: [brief], nextAfterBriefRevision: 1 },
  );
  rejects(() =>
    api.parseProjectBriefListResponse(
      { briefs: [brief], nextAfterBriefRevision: 2 },
      briefQuery,
    ),
  );
  rejects(() =>
    api.parseProjectBriefListResponse(
      { briefs: [brief, brief], nextAfterBriefRevision: null },
      briefQuery,
    ),
  );
  rejects(() =>
    api.parseProjectBriefListResponse(
      { briefs: [brief], nextAfterBriefRevision: null },
      { ...briefQuery, projectId: "other" },
    ),
  );
  const assetQuery = {
    projectId: project.projectId,
    afterAssetId: null,
    limit: 20,
  };
  assert.deepEqual(
    api.parseConceptAssetListResponse(
      { assets: [asset], nextAfterAssetId: asset.assetId },
      assetQuery,
    ),
    { assets: [asset], nextAfterAssetId: asset.assetId },
  );
  rejects(() =>
    api.parseConceptAssetListResponse(
      { assets: [asset], nextAfterAssetId: null },
      { ...assetQuery, afterAssetId: asset.assetId },
    ),
  );
  rejects(() =>
    api.parseConceptAssetListResponse(
      { assets: [], nextAfterAssetId: asset.assetId },
      assetQuery,
    ),
  );
  const revisionQuery = {
    projectId: project.projectId,
    assetId: asset.assetId,
    afterAssetRevision: 0,
    limit: 20,
  };
  assert.deepEqual(
    api.parseConceptRevisionListResponse(
      { revisions: [assetRevision], nextAfterAssetRevision: 1 },
      revisionQuery,
    ),
    { revisions: [assetRevision], nextAfterAssetRevision: 1 },
  );
  rejects(() =>
    api.parseConceptRevisionListResponse(
      { revisions: [assetRevision], nextAfterAssetRevision: null },
      { ...revisionQuery, assetId: "other" },
    ),
  );
  rejects(() =>
    api.parseConceptRevisionListResponse(
      { revisions: [assetRevision], nextAfterAssetRevision: null },
      { ...revisionQuery, afterAssetRevision: 1 },
    ),
  );
});
test("mutation replies bind original requests and permit metadata no-op replay", () => {
  const create = { disposition: "committed", project, brief };
  const createExpected = {
    kind: "create-project",
    request: { title: project.title, briefText: brief.text },
  } as const;
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(create, createExpected),
    create,
  );
  assert.equal(
    api.parseCreativeProjectMutationResponse(
      { ...create, disposition: "replayed" },
      createExpected,
    ).disposition,
    "replayed",
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse(
      { ...create, brief: { ...brief, text: "different" } },
      createExpected,
    ),
  );
  const renamed = { disposition: "replayed", project };
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(renamed, {
      kind: "rename-project",
      projectId: project.projectId,
      request: { title: project.title, expectedProjectRevision: 2 },
    }),
    renamed,
  );
  const archived = {
    disposition: "committed",
    project: { ...project, state: "archived", revision: 3 },
  };
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(archived, {
      kind: "set-project-state",
      projectId: project.projectId,
      request: { state: "archived", expectedProjectRevision: 2 },
    }),
    archived,
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse(archived, {
      kind: "set-project-state",
      projectId: "other",
      request: { state: "archived", expectedProjectRevision: 2 },
    }),
  );
  const appended = {
    disposition: "committed",
    project: { ...project, revision: 3, latestBriefRevision: 2 },
    brief: { ...brief, briefRevision: 2 },
  };
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(appended, {
      kind: "append-brief",
      projectId: project.projectId,
      request: { text: brief.text, expectedProjectRevision: 2 },
    }),
    appended,
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse({
      ...appended,
      brief: { ...brief, projectId: "other" },
    }),
  );
});
test("concept mutations bind original asset, immutable prompt and source brief", () => {
  const response = {
    disposition: "committed",
    project: { ...project, revision: 3 },
    asset,
    assetRevision,
  };
  const expected = {
    kind: "create-concept",
    projectId: project.projectId,
    request: {
      name: asset.name,
      prompt: assetRevision.prompt,
      briefRevision: 1,
      expectedProjectRevision: 2,
    },
  } as const;
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(response, expected),
    response,
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse(
      { ...response, assetRevision: { ...assetRevision, prompt: "different" } },
      expected,
    ),
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse(
      { ...response, assetRevision: { ...assetRevision, assetId: "other" } },
      expected,
    ),
  );
  const appended = {
    ...response,
    project: { ...project, revision: 4 },
    asset: { ...asset, revision: 2, latestAssetRevision: 2 },
    assetRevision: { ...assetRevision, assetRevision: 2 },
  };
  assert.deepEqual(
    api.parseCreativeProjectMutationResponse(appended, {
      kind: "append-concept",
      projectId: project.projectId,
      assetId: asset.assetId,
      request: {
        prompt: assetRevision.prompt,
        briefRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
    }),
    appended,
  );
  rejects(() =>
    api.parseCreativeProjectMutationResponse(appended, {
      kind: "append-concept",
      projectId: project.projectId,
      assetId: "other",
      request: {
        prompt: assetRevision.prompt,
        briefRevision: 1,
        expectedProjectRevision: 3,
        expectedAssetMetadataRevision: 1,
      },
    }),
  );
});
test("response byte budget counts escaped content and rejects sparse/accessor arrays", () => {
  const briefs = Array.from({ length: 8 }, (_, index) => ({
    ...brief,
    briefRevision: index + 1,
    text: "\n" + "a".repeat(8190) + "\n",
  }));
  rejects(() =>
    api.parseProjectBriefListResponse(
      { briefs, nextAfterBriefRevision: 8 },
      { projectId: project.projectId, afterBriefRevision: 0, limit: 50 },
    ),
  );
  const sparse: unknown[] = [];
  sparse.length = 1;
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: sparse, nextCursor: null },
      api.parseCreativeProjectListQuery({}),
    ),
  );
  let calls = 0;
  const values = [project];
  Object.defineProperty(values, "0", {
    enumerable: true,
    get() {
      calls++;
      return project;
    },
  });
  rejects(() =>
    api.parseCreativeProjectListResponse(
      { projects: values, nextCursor: null },
      api.parseCreativeProjectListQuery({}),
    ),
  );
  assert.equal(calls, 0);
  assert.equal(api.MAX_CREATIVE_PROJECT_RESPONSE_BYTES, 60 * 1024);
});
