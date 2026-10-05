import type {
  CreativeProject,
  ProjectTextArtifact,
  ProjectTextArtifactRevision,
  ProjectTextDependencyStatus,
} from "@crewon/domain";
import type { ActorContext } from "./authorization-port.ts";
import type {
  CreativeProjectCommitOptions,
  CreativeProjectMutationReceipt,
  CreativeProjectOwnerScope,
} from "./creative-project-store-port.ts";

export type ProjectTextMutationKind =
  | "save-outline"
  | "save-script"
  | "select-revision"
  | "set-lock";
export type ProjectTextArtifactView = ProjectTextDependencyStatus &
  Readonly<{
    artifact: ProjectTextArtifact;
    selectedRevision: ProjectTextArtifactRevision | null;
  }>;
export type ProjectTextMutationResult = Readonly<{
  kind: ProjectTextMutationKind;
  disposition: "committed" | "replayed";
  artifact: ProjectTextArtifact;
  contentRevision: ProjectTextArtifactRevision | null;
}>;
export type ProjectTextMutationIdentity = Readonly<{
  actor: ActorContext;
  kind: ProjectTextMutationKind;
  receipt: CreativeProjectMutationReceipt;
}>;
export type ProjectTextReadScope = Readonly<{
  owner: CreativeProjectOwnerScope;
  projectId: string;
}>;
type PreparedMutation = Readonly<{
  actor: ActorContext;
  receipt: CreativeProjectMutationReceipt;
  project: CreativeProject;
  expectedArtifactRevision: number;
  artifact: ProjectTextArtifact;
}>;

/** Independent append-only text storage. No implicit migration, model, Run or supplier access. */
export interface ProjectTextStore {
  loadOutline(input: ProjectTextReadScope): Promise<ProjectTextArtifact | null>;
  loadScript(
    input: ProjectTextReadScope & Readonly<{ episodeId: string }>,
  ): Promise<ProjectTextArtifact | null>;
  loadArtifact(
    input: ProjectTextReadScope & Readonly<{ artifactId: string }>,
  ): Promise<ProjectTextArtifact | null>;
  loadRevision(
    input: ProjectTextReadScope &
      Readonly<{ artifactId: string; contentRevision: number }>,
  ): Promise<ProjectTextArtifactRevision | null>;
  listArtifacts(
    input: ProjectTextReadScope &
      Readonly<{ afterArtifactId: string | null; limit: number }>,
  ): Promise<
    Readonly<{
      artifacts: readonly ProjectTextArtifact[];
      nextArtifactId: string | null;
    }>
  >;
  listRevisions(
    input: ProjectTextReadScope &
      Readonly<{
        artifactId: string;
        afterContentRevision: number;
        limit: number;
      }>,
  ): Promise<
    Readonly<{
      revisions: readonly ProjectTextArtifactRevision[];
      nextContentRevision: number | null;
    }>
  >;
  loadMutationReceipt(
    input: ProjectTextMutationIdentity,
  ): Promise<ProjectTextMutationResult | null>;
  /** Re-read actual project/owner/active, logical head, brief and outline in the same transaction. */
  commitCandidate(
    input: PreparedMutation &
      Readonly<{
        kind: "save-outline" | "save-script";
        contentRevision: ProjectTextArtifactRevision;
      }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult>;
  /** Re-read the actual head and selected immutable revision; do not alter old project revision. */
  commitSelection(
    input: PreparedMutation &
      Readonly<{ contentRevision: ProjectTextArtifactRevision }>,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult>;
  commitLock(
    input: PreparedMutation,
    options?: CreativeProjectCommitOptions,
  ): Promise<ProjectTextMutationResult>;
}
