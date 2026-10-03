import type {
  PluginCreativeProjectClient,
  PluginProjectGenerationReadClient,
  PluginProjectGenerationClient,
  PluginProjectGenerationContextClient,
} from "@crewon/plugin-sdk/ui";
import type {
  CreativeProjectUiInputMap,
  PublicConceptAsset,
  PublicConceptRevision,
  PublicCreativeProject,
  PublicProjectBrief,
  ProjectGenerationUiInput,
} from "@crewon/plugin-sdk/contracts";
import type { ProjectDetails } from "./creative-project-controller";

export type ConceptDraft = Readonly<{
  name: string;
  prompt: string;
  source: PublicProjectBrief;
}>;
export type ConceptSelection = Readonly<{
  asset: PublicConceptAsset;
  revision: PublicConceptRevision;
  source: PublicProjectBrief;
}>;
export type ConceptSnapshot = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable";
  assets: readonly PublicConceptAsset[];
  nextAfterAssetId: string | null;
  selection: ConceptSelection | null;
  opening: boolean;
  editing: boolean;
  draft: ConceptDraft | null;
  confirmedOldBrief: boolean;
  saving: boolean;
  pendingKind: "create" | "append" | null;
  failure: "conflict" | "uncertain" | null;
  conflictRefreshed: boolean;
  error: string | null;
  notice: string | null;
  revisions: readonly PublicConceptRevision[];
  nextAfterAssetRevision: number | null;
  loadingHistory: boolean;
}>;
export type ConceptIntent =
  | Readonly<{
      kind: "create";
      input: CreativeProjectUiInputMap["crewon.creative-projects.v1.createConcept"];
    }>
  | Readonly<{
      kind: "append";
      input: CreativeProjectUiInputMap["crewon.creative-projects.v1.appendConceptRevision"];
    }>;
export type ConceptPorts = Readonly<{
  client: PluginCreativeProjectClient;
  generationClient: PluginProjectGenerationReadClient;
  submissionClient: PluginProjectGenerationClient;
  contextClient: PluginProjectGenerationContextClient;
  restoreGenerationSource(request: ProjectGenerationUiInput): Promise<boolean>;
  projectBlocked(): boolean;
  projectCommitted(project: PublicCreativeProject): void;
  lockChanged(locked: boolean): void;
  refreshProject(
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProjectDetails | null>;
}>;
