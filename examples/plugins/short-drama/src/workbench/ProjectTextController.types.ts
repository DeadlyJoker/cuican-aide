import type {
  ProjectTextUiInputMap,
  PublicProjectTextArtifact,
  PublicProjectTextArtifactView,
  PublicProjectTextRevision,
} from "../project-texts-ui-service";
import type { TextDraft } from "./ProjectTextDraft";
import type { TextRecoverySnapshot } from "./ProjectTextRecoveryController";

export type TextTarget =
  | Readonly<{ kind: "outline" }>
  | Readonly<{ kind: "script"; episodeId: string; title: string }>;
export type TextSnapshot = Readonly<{
  phase: "idle" | "loading" | "ready" | "unavailable";
  target: TextTarget;
  outline: PublicProjectTextArtifactView | null;
  artifacts: readonly PublicProjectTextArtifact[];
  nextArtifactId: string | null;
  view: PublicProjectTextArtifactView | null;
  content: PublicProjectTextRevision | null;
  draft: TextDraft | null;
  sourceBriefRevision: number | null;
  sourceOutline: Readonly<{
    artifactId: string;
    contentRevision: number;
  }> | null;
  dirty: boolean;
  currentBriefRevision: number | null;
  archived: boolean;
  history: readonly PublicProjectTextRevision[];
  nextContentRevision: number | null;
  loadingHistory: boolean;
  opening: boolean;
  saving: boolean;
  pendingKind:
    | "save-outline"
    | "save-script"
    | "select-revision"
    | "set-lock"
    | null;
  failure: "conflict" | "uncertain" | null;
  conflictRefreshed: boolean;
  error: string | null;
  notice: string | null;
  recovery: TextRecoverySnapshot;
}>;
export type TextIntent =
  | Readonly<{
      kind: "save-outline";
      input: ProjectTextUiInputMap["crewon.project-texts.v1.saveOutlineCandidate"];
    }>
  | Readonly<{
      kind: "save-script";
      input: ProjectTextUiInputMap["crewon.project-texts.v1.saveScriptCandidate"];
    }>
  | Readonly<{
      kind: "select-revision";
      input: ProjectTextUiInputMap["crewon.project-texts.v1.selectRevision"];
    }>
  | Readonly<{
      kind: "set-lock";
      input: ProjectTextUiInputMap["crewon.project-texts.v1.setLocked"];
    }>;
export const initialTextSnapshot = (): TextSnapshot => ({
  phase: "idle",
  target: { kind: "outline" },
  outline: null,
  artifacts: [],
  nextArtifactId: null,
  view: null,
  content: null,
  draft: null,
  dirty: false,
  sourceBriefRevision: null,
  sourceOutline: null,
  currentBriefRevision: null,
  archived: false,
  history: [],
  nextContentRevision: null,
  loadingHistory: false,
  opening: false,
  saving: false,
  pendingKind: null,
  failure: null,
  conflictRefreshed: false,
  error: null,
  notice: null,
  recovery: {
    phase: "disabled",
    intent: null,
    acknowledging: false,
    error: null,
  },
});
