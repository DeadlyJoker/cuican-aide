import {
  gateReport,
  validateOutline,
} from "./third-party/shuohao-outline/core.mjs";
import {
  parseProjectOutlineDocument,
  ProjectOutlineDocumentError,
} from "./project-outline-document.ts";
import type {
  ProjectOutlineDocument,
  ProjectOutlineQualityGateId,
  ProjectOutlineQualityReport,
  ProjectOutlineQualityStage,
} from "./project-outline-document-types.ts";

export const PROJECT_OUTLINE_SKILL_REVISION =
  "ef4ac0c313c7eeb1f918db5f0f0eb319745900bc";
export const PROJECT_OUTLINE_SKILL_SOURCE_DIGEST =
  "sha256:33f1469123333b98b5e56f4b81cd64df80b58e1878e0cf7212b585f6e8ac8597";
const skeleton = new Set<ProjectOutlineQualityGateId>([
  "lead-cap",
  "support-cap",
  "functional-cap",
  "scene-cap",
  "prop-cap",
]);
const beats = new Set<ProjectOutlineQualityGateId>([
  ...skeleton,
  "beat-gap",
  "major-early",
]);

/** A detached Skill view only. Persistent episode identities never change to ordinal numbers. */
export function projectOutlineSkillView(document: ProjectOutlineDocument) {
  const value = parseProjectOutlineDocument(document);
  const ordinals = new Map(
    value.episodes.map((episode) => [episode.episodeId, episode.ep]),
  );
  return {
    source: value.source,
    lang: value.lang,
    params: value.params,
    adaptation: value.adaptation,
    characters: value.characters,
    scenes: value.scenes,
    ...(value.props === undefined ? {} : { props: value.props }),
    beats: value.beats.map((beat) => ({
      id: beat.id,
      type: beat.type,
      weight: beat.weight,
      episode: ordinals.get(beat.episodeId) ?? 0,
      setup: beat.setup,
      payoff: beat.payoff,
    })),
    episodes: value.episodes.map((episode) => ({
      ep: episode.ep,
      synopsis: episode.summary,
      hook: episode.hook,
      suspense: episode.suspense,
      sceneIds: episode.sceneIds,
      characterIds: episode.characterIds,
      ...(episode.propIds === undefined ? {} : { propIds: episode.propIds }),
      ...(episode.crowdPlan === undefined
        ? {}
        : { crowdPlan: episode.crowdPlan }),
      ...(episode.warnings === undefined ? {} : { warnings: episode.warnings }),
    })),
  };
}

/** Executes the pinned Skill's actual deterministic gates; it cannot save, adopt, generate or read a book. */
export function evaluateProjectOutlineQuality(
  input: unknown,
  stage: ProjectOutlineQualityStage,
): ProjectOutlineQualityReport {
  if (stage !== "skeleton" && stage !== "beats" && stage !== "full")
    throw new ProjectOutlineDocumentError(
      "project_outline_quality_stage_invalid",
      "$.stage",
    );
  const document = parseProjectOutlineDocument(input);
  const view = projectOutlineSkillView(document);
  const episodeIds = new Set(
    document.episodes.map((episode) => episode.episodeId),
  );
  const missingBeatReferences =
    stage === "skeleton"
      ? []
      : document.beats.flatMap((beat, index) =>
          episodeIds.has(beat.episodeId)
            ? []
            : [
                `beats[${index}].episodeId：爽点 ${beat.id} 引用了不存在的分集 ${beat.episodeId}`,
              ],
        );
  const problems = Object.freeze([
    ...missingBeatReferences,
    ...validateOutline(view, stage),
  ]);
  const gates = Object.freeze(
    gateReport(view).map((gate) => {
      const id = gate.id as ProjectOutlineQualityGateId;
      const selected =
        stage === "full" || (stage === "skeleton" ? skeleton : beats).has(id);
      const optional = id === "prop-cap" && document.props === undefined;
      return Object.freeze({
        id,
        label: gate.label,
        status:
          !selected || optional
            ? ("skipped" as const)
            : gate.ok
              ? ("passed" as const)
              : ("failed" as const),
        detail: !selected
          ? "生成分集后在完整校验中检查。"
          : id === "refs"
            ? [
                document.props === undefined
                  ? "未提供道具表；仍检查角色、场景和爽点引用，道具引用未检查。"
                  : "",
                ...missingBeatReferences,
                gate.detail,
              ]
                .filter(Boolean)
                .join("；")
            : gate.detail,
      });
    }),
  );
  return Object.freeze({
    schemaVersion: "crewon.project-outline-quality.v1",
    stage,
    passed: problems.length === 0,
    skill: Object.freeze({
      name: "novel-outline",
      revision: PROJECT_OUTLINE_SKILL_REVISION,
      sourceDigest: PROJECT_OUTLINE_SKILL_SOURCE_DIGEST,
    }),
    gates,
    problems,
    sourceEvidenceVerification: "not-checked",
  });
}
