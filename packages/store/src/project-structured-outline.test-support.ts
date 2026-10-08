import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import {
  createProjectFoundation,
  parseProjectOutlineDocument,
  projectOutlineInputBinding,
  saveProjectStructuredOutlineCandidate,
  selectProjectStructuredOutlineRevision,
  type ProjectOutlineDocument,
  type ProjectOutlineBeat,
  type ProjectOutlineEpisode,
  type ProjectTextArtifact,
  type ProjectStructuredOutlineRevision,
} from "@crewon/domain";
import { projectTextFixture } from "./project-text-store.test-support.ts";
import {
  actor,
  owner,
  digester,
  receipt,
  time,
  sourceBundle,
  foundationCreationRecipe,
  proposalRecipe,
  confirmationRecipe,
} from "./project-foundation-store.test-support.ts";

export {
  actor,
  owner,
  digester,
  receipt,
  time,
  proposalRecipe,
  confirmationRecipe,
};
type SkillFixture = Omit<
  ProjectOutlineDocument,
  "schemaVersion" | "title" | "logline" | "synopsis" | "beats" | "episodes"
> & {
  beats: readonly (Omit<ProjectOutlineBeat, "episodeId"> & {
    episode: number;
  })[];
  episodes: readonly (Omit<
    ProjectOutlineEpisode,
    "episodeId" | "title" | "summary"
  > & { synopsis: string })[];
};
const sourceBytes = await readFile(
  new URL(
    "../../domain/src/third-party/shuohao-outline/ferry-outline.fixture.json",
    import.meta.url,
  ),
);
assert.equal(
  digester.sha256(sourceBytes.toString("utf8")),
  "sha256:cd257e64909c7ceaef7701b826c3801870abd3c0ded37591ef5825e71627e5c0",
);
const fixture: SkillFixture = JSON.parse(sourceBytes.toString("utf8"));
export function outlineDocument(): ProjectOutlineDocument {
  return parseProjectOutlineDocument({
    ...fixture,
    schemaVersion: "crewon.project-outline-document.v2",
    title: "渡口",
    logline: "一船陌生人的秘密。",
    synopsis: "浓雾散去前，每个人都要亮一次底。",
    beats: fixture.beats.map(({ episode, ...beat }) => ({
      ...beat,
      episodeId: "episode-" + episode,
    })),
    episodes: fixture.episodes.map(({ synopsis, ...episode }) => ({
      ...episode,
      episodeId: "episode-" + episode.ep,
      title: "第" + episode.ep + "集",
      summary: synopsis,
    })),
  });
}
export function longOutlineDocument() {
  const original = outlineDocument();
  const episodes = Array.from({ length: 120 }, (_, index) => ({
    ...original.episodes[index % original.episodes.length]!,
    ep: index + 1,
    episodeId: "long-episode-" + (index + 1),
    summary:
      original.episodes[index % original.episodes.length]!.summary +
      "追查线索，逐步揭开秘密。".repeat(32),
  }));
  return parseProjectOutlineDocument({
    ...original,
    params: { ...original.params, episodes: 120 },
    episodes,
    beats: Array.from({ length: 40 }, (_, index) => ({
      id: "B" + String(index + 1).padStart(2, "0"),
      type: "揭破",
      weight: index === 0 ? "major" : "minor",
      episodeId: episodes[index * 3]!.episodeId,
      setup: "追查线索",
      payoff: "秘密推进",
    })),
  });
}
export async function structuredOutlineFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  document = outlineDocument(),
) {
  const f = await projectTextFixture(t, backend);
  const foundations = f.first.parent.projectFoundationStore({
    sourceAdmission: "trusted-internal-recipe",
  });
  await foundations.migrate();
  const creation = foundationCreationRecipe(
    "structured-novel",
    "structured-creation",
    "novel",
  );
  const quote = document.adaptation.keep[0]!.evidence!;
  const split = Math.floor(quote.length / 2);
  const rest = [
    ...document.adaptation.keep.slice(1),
    ...document.adaptation.cut,
    ...document.adaptation.merge,
  ].flatMap((item) => (item.evidence === undefined ? [] : [item.evidence]));
  const book = sourceBundle(creation.project, 1, time(), [
    "原文😀\n" + quote.slice(0, split),
    quote.slice(split) + "\n" + rest.join("\n") + "\n结尾 café。",
  ]);
  const foundation = createProjectFoundation({
    project: creation.project,
    actor,
    expectedProjectRevision: creation.project.revision,
    origin: "novel",
    parameters: {
      ...creation.foundation.parameters,
      genre: document.params.genre,
      episodeCount: document.params.episodes,
      episodeDurationSeconds: {
        minimum: Math.round(document.params.minutesPerEpisode * 60),
        maximum: Math.round(document.params.minutesPerEpisode * 60),
      },
      adaptation: {
        strategy:
          document.params.adaptMode === "忠实"
            ? "faithful"
            : document.params.adaptMode === "抽核"
              ? "core"
              : "reimagined",
        retainedCharacters: [],
        retainedScenes: [],
      },
    },
    source: { revision: book.source.revision, digest: book.source.digest },
    creativeStartMode: null,
    at: time(),
  });
  const created = await foundations.commitCreation({
    ...creation,
    foundation,
    source: book.source,
    chunks: book.chunks,
    chapters: book.chapters,
  });
  const proposal = await foundations.commitProposal(
    proposalRecipe(created.project, created.foundation, "structured-proposal"),
  );
  const confirmed = await foundations.commitFoundationChange(
    confirmationRecipe(
      created.project,
      created.foundation,
      proposal.proposal!,
      "structured-confirmation",
    ),
  );
  const scope = { owner: owner(), projectId: created.project.projectId };
  return {
    ...f,
    foundations,
    created,
    confirmed,
    proposal: proposal.proposal!,
    document,
    scope,
    book,
  };
}
export type StructuredOutlineFixture = Awaited<
  ReturnType<typeof structuredOutlineFixture>
>;
export function candidate(
  f: StructuredOutlineFixture,
  key: string,
  artifact: ProjectTextArtifact | null = null,
  content = f.document,
  inputs = projectOutlineInputBinding(f.confirmed.foundation, digester),
) {
  const next = saveProjectStructuredOutlineCandidate(
    {
      project: f.created.project,
      actor,
      artifact,
      artifactId: artifact?.artifactId ?? "outline-1",
      expectedArtifactRevision: artifact?.revision ?? 0,
      brief: f.created.brief!,
      inputs,
      content,
      at: time(3),
    },
    digester,
  );
  return {
    ...next,
    kind: "save-outline" as const,
    actor,
    receipt: receipt(key),
    project: f.created.project,
    expectedArtifactRevision: artifact?.revision ?? 0,
  };
}
export function selection(
  f: StructuredOutlineFixture,
  key: string,
  artifact: ProjectTextArtifact,
  revision: ProjectStructuredOutlineRevision,
) {
  const next = selectProjectStructuredOutlineRevision(
    {
      project: f.created.project,
      actor,
      artifact,
      expectedArtifactRevision: artifact.revision,
      contentRevision: revision,
      latestBrief: f.created.brief!,
      at: time(4),
    },
    digester,
  );
  return {
    ...next,
    actor,
    receipt: receipt(key),
    project: f.created.project,
    expectedArtifactRevision: artifact.revision,
  };
}
export const code = (expected: string) => (error: unknown) =>
  error instanceof Error &&
  ((error as Error & { code?: string }).code === expected ||
    error.message === expected);
