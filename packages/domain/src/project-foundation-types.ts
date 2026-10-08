import type {
  CreativeProject,
  CreativeProjectActor,
  CreativeProjectScope,
} from "./creative-project.ts";
import type { ProjectProposal } from "./project-proposal.ts";

export type ProjectOrigin = "creative" | "novel";

/** Digests are supplied by the persistence authority, never inferred from text. */
export type ProjectRevisionDigestPointer = Readonly<{
  revision: number;
  digest: string;
}>;

export type ProjectCreationParameters = Readonly<{
  genre: string | null;
  episodeMode: "single" | "series";
  episodeCount: number | null;
  episodeDurationSeconds: Readonly<{
    minimum: number;
    maximum: number;
  }> | null;
  aspectRatio: "16:9" | "9:16";
  visualStyle: "semi-realistic" | "hand-drawn" | null;
  needsCharacters: boolean;
  needsArt: boolean;
  adaptation: Readonly<{
    strategy: "faithful" | "core" | "reimagined";
    retainedCharacters: readonly string[];
    retainedScenes: readonly string[];
  }> | null;
}>;

/** Independent metadata; the legacy CreativeProject v0 remains unchanged. */
export type ProjectFoundation = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-foundation.v1";
    ownerPrincipalId: string;
    origin: ProjectOrigin;
    revision: number;
    parametersRevision: number;
    parameters: ProjectCreationParameters;
    source: ProjectRevisionDigestPointer | null;
    confirmedProposal: ProjectRevisionDigestPointer | null;
    creativeStartMode: "confirm-plan" | "direct-script" | null;
    createdByActorId: string;
    createdAt: string;
    updatedByActorId: string;
    updatedAt: string;
  }>;

export type CreateProjectFoundationInput = Readonly<{
  project: CreativeProject;
  actor: CreativeProjectActor;
  expectedProjectRevision: number;
  origin: ProjectOrigin;
  parameters: ProjectCreationParameters;
  source: ProjectRevisionDigestPointer | null;
  creativeStartMode: ProjectFoundation["creativeStartMode"];
  at: string;
}>;

export type ProjectFoundationMutationInput = Readonly<{
  project: CreativeProject;
  foundation: ProjectFoundation;
  actor: CreativeProjectActor;
  expectedFoundationRevision: number;
  at: string;
}>;

export type UpdateProjectFoundationParametersInput =
  ProjectFoundationMutationInput &
    Readonly<{ parameters: ProjectCreationParameters }>;

export type SetProjectFoundationSourceInput = ProjectFoundationMutationInput &
  Readonly<{ source: ProjectRevisionDigestPointer | null }>;

export type SetProjectFoundationCreativeStartModeInput =
  ProjectFoundationMutationInput &
    Readonly<{ creativeStartMode: "confirm-plan" | "direct-script" }>;

export type ConfirmProjectProposalInput = ProjectFoundationMutationInput &
  Readonly<{ proposal: ProjectProposal }>;

export type AssertProjectFoundationDownstreamAllowedInput = Readonly<{
  project: CreativeProject;
  foundation: ProjectFoundation;
  actor: CreativeProjectActor;
  proposal: ProjectProposal | null;
}>;
