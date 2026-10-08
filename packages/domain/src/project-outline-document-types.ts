export const PROJECT_OUTLINE_DOCUMENT_SCHEMA =
  "crewon.project-outline-document.v2";
export const MAX_PROJECT_OUTLINE_DOCUMENT_BYTES = 240 * 1024;
export const MAX_PROJECT_OUTLINE_DOCUMENT_EPISODES = 120;

export type ProjectOutlineCharacterTier = "lead" | "support" | "functional";
export type ProjectOutlineQualityStage = "skeleton" | "beats" | "full";
export type ProjectOutlineThresholds = Readonly<
  Partial<
    Record<
      | "maxLeads"
      | "maxSupport"
      | "maxFunctional"
      | "maxBeatGap"
      | "maxProps"
      | "maxPrimaryScenes",
      number
    >
  >
>;
export type ProjectOutlineDecision = Readonly<{
  what: string;
  why: string;
  evidence?: string;
}>;
export type ProjectOutlineCharacter = Readonly<{
  id: string;
  name: string;
  role: string;
  tier: ProjectOutlineCharacterTier;
  arc?: string;
  from: readonly string[];
}>;
export type ProjectOutlineScene = Readonly<{
  id: string;
  name: string;
  primary: boolean;
  reusePlan?: string;
}>;
export type ProjectOutlineProp = Readonly<{
  id: string;
  name: string;
  function: string;
  beatIds?: readonly string[];
}>;
export type ProjectOutlineBeat = Readonly<{
  id: string;
  type: string;
  weight: "major" | "minor";
  episodeId: string;
  setup: string;
  payoff: string;
}>;
export type ProjectOutlineEpisode = Readonly<{
  /** Persistent identity. ep is only the current display order. */
  episodeId: string;
  ep: number;
  title: string;
  summary: string;
  hook: string;
  suspense: string;
  sceneIds: readonly string[];
  characterIds: readonly string[];
  propIds?: readonly string[];
  crowdPlan?: string;
  warnings?: readonly string[];
}>;

/** Content only. Source labels and quoted evidence do not confer source or execution authority. */
export type ProjectOutlineDocument = Readonly<{
  schemaVersion: typeof PROJECT_OUTLINE_DOCUMENT_SCHEMA;
  title: string;
  logline: string;
  synopsis: string;
  source: string;
  lang: "zh" | "en";
  params: Readonly<{
    episodes: number;
    minutesPerEpisode: number;
    genre: string;
    adaptMode: "忠实" | "抽核" | "借壳";
    preferences?: readonly string[];
    thresholds?: ProjectOutlineThresholds;
  }>;
  adaptation: Readonly<{
    core: string;
    keep: readonly ProjectOutlineDecision[];
    cut: readonly ProjectOutlineDecision[];
    merge: readonly ProjectOutlineDecision[];
    risks: readonly Readonly<{ what: string; plan: string }>[];
    cutNote?: string;
    mergeNote?: string;
  }>;
  characters: readonly ProjectOutlineCharacter[];
  scenes: readonly ProjectOutlineScene[];
  props?: readonly ProjectOutlineProp[];
  beats: readonly ProjectOutlineBeat[];
  episodes: readonly ProjectOutlineEpisode[];
}>;

export type ProjectOutlineQualityGateId =
  | "lead-cap"
  | "support-cap"
  | "functional-cap"
  | "scene-cap"
  | "prop-cap"
  | "once-scene"
  | "beat-gap"
  | "ep1-hook"
  | "major-early"
  | "ep-fields"
  | "crowd-plan"
  | "risk-flag"
  | "refs"
  | "no-dialogue";
export type ProjectOutlineQualityGate = Readonly<{
  id: ProjectOutlineQualityGateId;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}>;
export type ProjectOutlineQualityReport = Readonly<{
  schemaVersion: "crewon.project-outline-quality.v1";
  stage: ProjectOutlineQualityStage;
  passed: boolean;
  skill: Readonly<{
    name: "novel-outline";
    revision: string;
    sourceDigest: string;
  }>;
  gates: readonly ProjectOutlineQualityGate[];
  problems: readonly string[];
  /** The pure quality evaluator has no original-book store or media access. */
  sourceEvidenceVerification: "not-checked";
}>;
