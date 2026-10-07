import type {
  ProjectAssetContent,
  ProjectAssetKind,
  ProjectAssetUiActionRequest,
  PublicProjectAsset,
  PublicProjectAssetRevision,
  PublicProjectAssetView,
  PublicProjectAssetReferenceRevision,
} from "../project-assets-v2-service";

export type AssetScriptSource = Readonly<{
  artifactId: string;
  episodeId: string;
  contentRevision: number;
  title: string;
}>;
export type AssetDraft = Readonly<{
  kind: ProjectAssetKind;
  content: ProjectAssetContent;
  briefRevision: number;
  script: AssetScriptSource | null;
}>;
export type AssetIntent = Extract<
  ProjectAssetUiActionRequest,
  {
    action:
      | "crewon.project-assets.v2.saveCandidate"
      | "crewon.project-assets.v2.selectRevision"
      | "crewon.project-assets.v2.setLocked"
      | "crewon.project-assets.v2.saveReferenceCandidate"
      | "crewon.project-assets.v2.selectReference"
      | "crewon.project-assets.v2.adoptMediaReference";
  }
>;
export type AssetSnapshot = Readonly<{
  projectId: string | null;
  phase: "waiting" | "loading" | "ready" | "unavailable";
  assets: readonly PublicProjectAsset[];
  nextAssetId: string | null;
  view: PublicProjectAssetView | null;
  content: PublicProjectAssetRevision | null;
  draft: AssetDraft | null;
  dirty: boolean;
  scripts: readonly AssetScriptSource[];
  nextScriptArtifactId: string | null;
  history: readonly PublicProjectAssetRevision[];
  nextContentRevision: number | null;
  references: readonly PublicProjectAssetReferenceRevision[];
  nextReferenceRevision: number | null;
  opening: boolean;
  saving: boolean;
  pending: AssetIntent | null;
  presentedRecovery: string | null;
  error: string | null;
  notice: string | null;
}>;
export function initialAssetSnapshot(): AssetSnapshot {
  return {
    projectId: null,
    phase: "waiting",
    assets: [],
    nextAssetId: null,
    view: null,
    content: null,
    draft: null,
    dirty: false,
    scripts: [],
    nextScriptArtifactId: null,
    history: [],
    nextContentRevision: null,
    references: [],
    nextReferenceRevision: null,
    opening: false,
    saving: false,
    pending: null,
    presentedRecovery: null,
    error: null,
    notice: null,
  };
}
