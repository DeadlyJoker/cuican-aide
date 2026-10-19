export const textAdoptionRequest = {
  action: "crewon.project-texts.v1.selectRevision",
  input: {
    projectId: "project",
    artifactId: "outline",
    request: { expectedArtifactRevision: 1, contentRevision: 1 },
    idempotencyKey: "adopt-outline-once",
  },
} as const;

export const textAdoptionResponse = {
  kind: "select-revision",
  disposition: "committed",
  artifact: {
    projectId: "project",
    artifactId: "outline",
    revision: 2,
    latestContentRevision: 1,
    selectedContentRevision: 1,
    locked: false,
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:01:00.000Z",
    kind: "outline",
    episodeId: null,
  },
  contentRevision: {
    projectId: "project",
    artifactId: "outline",
    kind: "outline",
    episodeId: null,
    contentRevision: 1,
    brief: { briefRevision: 1, contentDigest: `sha256:${"a".repeat(64)}` },
    outline: null,
    content: {
      title: "原项目",
      logline: "人物必须作出有代价的选择。",
      synopsis: "人物为达成目标尝试妥协，最终承担代价。",
      episodes: [{ episodeId: "episode/中文", title: "第一集", summary: "人物作出选择。" }],
    },
    contentDigest: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-10-16T00:00:00.000Z",
  },
} as const;
