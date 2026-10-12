import type {
  ProjectStructuredOutlineRevision,
  StoredProjectTextArtifactRevision,
} from "@crewon/domain";
import type { CreativeProjectCommitOptions } from "./creative-project-store-port.ts";
import type {
  ProjectTextStore,
  ProjectTextMutationResult,
} from "./project-text-store-port.ts";

export type StoredProjectTextMutationResult = Omit<
  ProjectTextMutationResult,
  "contentRevision"
> &
  Readonly<{ contentRevision: StoredProjectTextArtifactRevision | null }>;
type Candidate = Omit<
  Parameters<ProjectTextStore["commitCandidate"]>[0],
  "contentRevision" | "kind"
> &
  Readonly<{
    kind: "save-outline";
    contentRevision: ProjectStructuredOutlineRevision;
  }>;
type Selection = Omit<
  Parameters<ProjectTextStore["commitSelection"]>[0],
  "contentRevision"
> &
  Readonly<{ contentRevision: ProjectStructuredOutlineRevision }>;

/** Explicit v2 storage API, sharing the original artifact slot, append-only history, CAS and receipt tables. */
export interface ProjectStructuredOutlineStore extends ProjectTextStore {
  bindProjectReads?(
    scope: import("./plugin-project-read-scope.ts").PluginProjectReadScope,
  ): ProjectStructuredOutlineStore;
  loadStructuredRevision(
    input: Parameters<ProjectTextStore["loadRevision"]>[0],
  ): Promise<StoredProjectTextArtifactRevision | null>;
  listStructuredRevisions(
    input: Parameters<ProjectTextStore["listRevisions"]>[0],
  ): Promise<
    Readonly<{
      revisions: readonly StoredProjectTextArtifactRevision[];
      nextContentRevision: number | null;
    }>
  >;
  loadStructuredMutationReceipt(
    input: Parameters<ProjectTextStore["loadMutationReceipt"]>[0],
    options?: CreativeProjectCommitOptions,
  ): Promise<StoredProjectTextMutationResult | null>;
  commitStructuredOutlineCandidate(
    input: Candidate,
    options?: CreativeProjectCommitOptions,
  ): Promise<StoredProjectTextMutationResult>;
  commitStructuredOutlineSelection(
    input: Selection,
    options?: CreativeProjectCommitOptions,
  ): Promise<StoredProjectTextMutationResult>;
}
