import type { CreativeProjectScope } from "./creative-project.ts";

export type ProjectOutlineContent = Readonly<{
  title: string;
  logline: string;
  synopsis: string;
  episodes: readonly Readonly<{
    episodeId: string;
    title: string;
    summary: string;
  }>[];
}>;
export type ProjectScriptContent = Readonly<{
  title: string;
  scenes: readonly Readonly<{
    sceneId: string;
    location: string;
    timeOfDay: string;
    action: string;
    dialogue: readonly Readonly<{ speaker: string; text: string }>[];
  }>[];
}>;
export type ProjectTextArtifactKind = "outline" | "script";
type ArtifactIdentity =
  | Readonly<{ kind: "outline"; episodeId: null }>
  | Readonly<{ kind: "script"; episodeId: string }>;
export type ProjectTextArtifact = CreativeProjectScope &
  ArtifactIdentity &
  Readonly<{
    schemaVersion: "crewon.project-text-artifact.v1";
    artifactId: string;
    ownerPrincipalId: string;
    revision: number;
    latestContentRevision: number;
    selectedContentRevision: number | null;
    locked: boolean;
    createdByActorId: string;
    createdAt: string;
    updatedByActorId: string;
    updatedAt: string;
  }>;
export type ProjectTextBriefReference = Readonly<{
  briefRevision: number;
  contentDigest: string;
}>;
export type ProjectTextOutlineReference = Readonly<{
  artifactId: string;
  contentRevision: number;
  contentDigest: string;
}>;
type RevisionCommon = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-text-revision.v1";
    artifactId: string;
    contentRevision: number;
    brief: ProjectTextBriefReference;
    createdByActorId: string;
    createdAt: string;
    contentDigest: string;
  }>;
export type ProjectOutlineRevision = RevisionCommon &
  Readonly<{
    kind: "outline";
    episodeId: null;
    outline: null;
    content: ProjectOutlineContent;
  }>;
export type ProjectScriptRevision = RevisionCommon &
  Readonly<{
    kind: "script";
    episodeId: string;
    outline: ProjectTextOutlineReference | null;
    content: ProjectScriptContent;
  }>;
export type ProjectTextArtifactRevision =
  | ProjectOutlineRevision
  | ProjectScriptRevision;
export interface ProjectTextDigester {
  sha256(input: string): string;
}
