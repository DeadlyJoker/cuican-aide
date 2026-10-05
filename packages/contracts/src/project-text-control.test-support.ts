export const textProjectId = "project/中文 %2F";
export const textArtifactId = "outline";
export const textEpisodeId = "episode/中文";
export const textTime = "2026-10-05T00:00:00.000Z";
export const textDigest = `sha256:${"a".repeat(64)}`;
export const publicTextOutline = {
  title: "雨夜来信",
  logline: " 修复师遇见旧人\n",
  synopsis: " 失落的信带来重逢。 ",
  episodes: [
    { episodeId: textEpisodeId, title: "第一集", summary: " 雨夜来信。 " },
  ],
} as const;
export const publicTextScript = {
  title: "雨夜来信",
  scenes: [
    {
      sceneId: "scene-1",
      location: "修复室",
      timeOfDay: "夜晚",
      action: "\n 打开信封。 ",
      dialogue: [{ speaker: "林", text: " 你终于来了。\n" }],
    },
  ],
} as const;
export const publicTextArtifact = {
  projectId: textProjectId,
  artifactId: textArtifactId,
  kind: "outline",
  episodeId: null,
  revision: 1,
  latestContentRevision: 1,
  selectedContentRevision: null,
  locked: false,
  createdAt: textTime,
  updatedAt: textTime,
} as const;
export const publicTextRevision = {
  projectId: textProjectId,
  artifactId: textArtifactId,
  kind: "outline",
  episodeId: null,
  contentRevision: 1,
  brief: { briefRevision: 1, contentDigest: textDigest },
  outline: null,
  content: publicTextOutline,
  contentDigest: textDigest,
  createdAt: textTime,
} as const;
export const publicTextView = {
  artifact: { ...publicTextArtifact, revision: 2, selectedContentRevision: 1 },
  selectedRevision: publicTextRevision,
  dependencyState: "current",
  staleReasons: [],
} as const;
