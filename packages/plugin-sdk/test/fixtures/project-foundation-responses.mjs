// Public DTO fixtures only. These responses do not manufacture a Run or register a Host service.
export const projectId = "project/foundation%";
export const digest = `sha256:${"a".repeat(64)}`;
export const fileDigest = `sha256:${"b".repeat(64)}`;
export const proposalDigest = `sha256:${"c".repeat(64)}`;
const time = "2026-10-08T00:00:00.000Z";
export const parameters = {
  genre: null,
  episodeMode: "series",
  episodeCount: null,
  episodeDurationSeconds: null,
  aspectRatio: "16:9",
  visualStyle: null,
  needsCharacters: true,
  needsArt: true,
  adaptation: null,
};
export const novelParameters = {
  ...parameters,
  episodeCount: 120,
  episodeDurationSeconds: { minimum: 120, maximum: 300 },
  visualStyle: "semi-realistic",
  adaptation: {
    strategy: "core",
    retainedCharacters: ["林雨"],
    retainedScenes: ["重逢"],
  },
};
export const project = {
  projectId,
  kind: "short-drama",
  title: "雨夜",
  revision: 2,
  state: "active",
  latestBriefRevision: 1,
  createdAt: time,
  updatedAt: time,
};
export const brief = {
  projectId,
  briefRevision: 1,
  text: "两个人在雨夜重逢。",
  contentDigest: digest,
  createdAt: time,
};
export const foundation = {
  schemaVersion: "crewon.project-foundation.v1",
  projectId,
  origin: "creative",
  revision: 1,
  parametersRevision: 1,
  parameters,
  source: null,
  confirmedProposal: null,
  creativeStartMode: "confirm-plan",
  createdAt: time,
  updatedAt: time,
};
export const upload = { uploadId: "upload/book%", fileDigest };
export const source = {
  schemaVersion: "crewon.project-source.v1",
  projectId,
  revision: 1,
  digest,
  fileDigest,
  fileName: "故事.md",
  format: "md",
  byteLength: 36,
  characterLength: 12,
  createdAt: time,
};
export const proposal = {
  schemaVersion: "crewon.project-proposal.v1",
  projectId,
  revision: 1,
  kind: "creative-plan",
  foundationRevision: 1,
  parametersRevision: 1,
  source: null,
  text: "雨夜重逢后一起寻找失踪的人。",
  contentDigest: proposalDigest,
  createdAt: time,
};
export const confirmedFoundation = {
  ...foundation,
  revision: 2,
  confirmedProposal: { revision: 1, digest: proposalDigest },
};
export const createInput = {
  title: project.title,
  briefText: brief.text,
  origin: "creative",
  parameters,
  creativeStartMode: "confirm-plan",
  sourceUpload: null,
  idempotencyKey: "create-foundation-1",
};
const change = {
  projectId,
  expectedFoundationRevision: 1,
  idempotencyKey: "change-foundation-1",
};
export function mutation(kind, overrides = {}) {
  return {
    kind,
    disposition: "committed",
    project,
    foundation,
    brief: null,
    source: null,
    proposal: null,
    ...overrides,
  };
}
export const vectors = [
  ["createProject", createInput, mutation("create-project", { brief })],
  ["getFoundation", { projectId }, { foundation }],
  [
    "updateParameters",
    { ...change, parameters },
    mutation("update-parameters"),
  ],
  [
    "appendSource",
    { ...change, sourceUpload: upload },
    mutation("append-source", {
      source,
      foundation: {
        ...foundation,
        revision: 2,
        source: { revision: 1, digest },
      },
    }),
  ],
  ["getSource", { projectId, sourceRevision: 1 }, { source }],
  [
    "readSourcePage",
    {
      projectId,
      sourceRevision: 1,
      sourceDigest: digest,
      startOffset: 0,
      limit: 3,
    },
    {
      page: {
        sourceRevision: 1,
        startOffset: 0,
        endOffset: 3,
        content: "雨😀夜",
        nextOffset: 3,
      },
    },
  ],
  [
    "listSourceChapters",
    {
      projectId,
      sourceRevision: 1,
      sourceDigest: digest,
      afterStartOffset: null,
      limit: 2,
    },
    {
      chapters: [
        {
          projectId,
          sourceRevision: 1,
          chapterId: "chapter-1",
          title: "第一章 重逢",
          startOffset: 0,
          endOffset: 6,
        },
        {
          projectId,
          sourceRevision: 1,
          chapterId: "chapter-2",
          title: "第二章 寻人",
          startOffset: 6,
          endOffset: 12,
        },
      ],
      nextStartOffset: null,
    },
  ],
  [
    "saveProposal",
    {
      ...change,
      expectedProposalRevision: 0,
      kind: "creative-plan",
      text: proposal.text,
    },
    mutation("save-proposal", { proposal }),
  ],
  [
    "confirmProposal",
    { ...change, proposalRevision: 1, proposalDigest },
    mutation("confirm-proposal", { foundation: confirmedFoundation, proposal }),
  ],
  [
    "chooseCreativeStartMode",
    { ...change, creativeStartMode: "direct-script" },
    mutation("choose-direct-script", {
      foundation: {
        ...foundation,
        revision: 2,
        creativeStartMode: "direct-script",
      },
    }),
  ],
  ["getProposal", { projectId, proposalRevision: 1 }, { proposal }],
  [
    "listProposals",
    { projectId, afterProposalRevision: 0, limit: 2 },
    { proposals: [proposal], nextRevision: null },
  ],
];
