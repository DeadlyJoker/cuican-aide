import {
  SHUOHAO_SKILLS_REVISION,
  SHUOHAO_STAGE_DOCUMENTS,
  type ShortDramaStageSkill,
} from "./stage-skill-resources.js";

/** The package contains the complete documents; model context receives only
 * the reviewed excerpt for its actual stage. Upstream allowed-tools metadata
 * and CLI instructions never become CrewON capabilities or execution grants.
 */
export function stageSkillGuidance(skill: ShortDramaStageSkill) {
  const document = SHUOHAO_STAGE_DOCUMENTS[skill];
  return {
    revision: SHUOHAO_SKILLS_REVISION,
    source: `https://github.com/eternityspring/shuohao-skills/blob/${SHUOHAO_SKILLS_REVISION}/${document.path}`,
    resource: {
      path: `third-party/shuohao-skills/${document.path}`,
      sha256: document.sha256,
      lines: [...document.lines],
      mode: "reviewed-excerpt" as const,
      qualityChecks: "not-run" as const,
    },
    excerpt: document.excerpt,
  };
}
