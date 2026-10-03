export const at = "2026-10-03T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
export const projectId = "project/中文 %2F";
export const assetId = "asset\\中文%";
export const project = {
  projectId,
  kind: "short-drama",
  title: "窗边的信",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: at,
  updatedAt: at,
};
export const brief = {
  projectId,
  briefRevision: 1,
  text: " 原始需求\n下一行 ",
  contentDigest: digest,
  createdAt: at,
};
export const asset = {
  projectId,
  assetId,
  name: "概念画面",
  revision: 1,
  latestAssetRevision: 1,
  createdAt: at,
  updatedAt: at,
};
export const assetRevision = {
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
export const vectors = [
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
];
