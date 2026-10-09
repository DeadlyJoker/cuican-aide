export const PROJECT_SCRIPT_DOCUMENT_SCHEMA =
  "crewon.project-script-document.v2";
export const MAX_PROJECT_SCRIPT_DOCUMENT_BYTES = 240 * 1024;
export const MAX_PROJECT_SCRIPT_DOCUMENT_EPISODES = 120;
export const DEFAULT_PROJECT_SCRIPT_BATCH_SIZE = 3;

export type ProjectScriptParams = Readonly<{
  charsPerSecond: number;
  actionSeconds: number;
  tolerance: number;
  maxLineChars: number;
  hookWindow: number;
}>;
export type ProjectScriptBeat = Readonly<
  { beatId: string } & (
    | { kind: "action"; action: string }
    | { kind: "dialogue"; speaker: string; line: string; delivery?: string }
  )
>;
export type ProjectScriptScene = Readonly<{
  /** Scene occurrence identity; sceneId references the reusable art entity. */
  sceneKey: string;
  sceneId: string;
  lighting?: string;
  characters: readonly string[];
  props?: readonly string[];
  flow: readonly ProjectScriptBeat[];
}>;
export type ProjectScriptEpisode = Readonly<{
  episodeId: string;
  /** Display order only; never used as persistent identity. */
  ep: number;
  targetSeconds: number;
  hook: string;
  cliff: string;
  /** Original outline beat IDs, not editable type labels. */
  beatsClaimed: readonly string[];
  /** Stable flow beat ID. Null is permitted in unfinished seed documents. */
  hookBeat: string | null;
  scenes: readonly ProjectScriptScene[];
}>;
/** Content only. This shape grants no save, selection, source or execution authority. */
export type ProjectScriptDocument = Readonly<{
  schemaVersion: typeof PROJECT_SCRIPT_DOCUMENT_SCHEMA;
  source: string;
  params: ProjectScriptParams;
  episodes: readonly ProjectScriptEpisode[];
}>;
/** Exact reference projection supplied by the caller; not a persisted art schema. */
export type ProjectScriptArtReferences = Readonly<{
  scenes: readonly Readonly<{
    id: string;
    lighting: readonly Readonly<{ state: string }>[];
  }>[];
  props: readonly Readonly<{ id: string }>[];
}>;
export type ProjectScriptQualityGateId =
  | "duration"
  | "line-length"
  | "speaker"
  | "hook-cliff"
  | "hook-open"
  | "has-action"
  | "action-prose"
  | "beats-claimed"
  | "refs-characters"
  | "refs-scenes";
export type ProjectScriptQualityGate = Readonly<{
  id: ProjectScriptQualityGateId;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}>;
