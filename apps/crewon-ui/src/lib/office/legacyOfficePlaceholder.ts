import type { OfficeConfig } from "../domain/crewonDomain";

const LEGACY_ZH_TITLE = /^新办公室 \d{1,2}:\d{2}$/;
const LEGACY_EN_TITLE = /^New office \d{1,2}:\d{2}(?:\s?[AP]M)?$/i;

/**
 * Identifies records created by the removed Library quick-create flow.
 *
 * The old flow generated the title, subtitle, and goal as one fixed bundle
 * without asking the user for a real Office definition. Matching the complete
 * bundle avoids hiding user-created Offices that merely have a similar title.
 */
export function isLegacyGeneratedOfficePlaceholder(
  config: OfficeConfig,
): boolean {
  const title = config.title.trim();
  const subtitle = config.subtitle.trim();
  const goal = config.workspace.goal.trim();

  if (LEGACY_ZH_TITLE.test(title)) {
    return (
      subtitle === "新建办公室 · 配置阶段" &&
      goal === `围绕「${title}」进行多智能体协作，先配置成员，再启动群聊。`
    );
  }
  if (LEGACY_EN_TITLE.test(title)) {
    return (
      subtitle === "New office · configuration stage" &&
      goal ===
        `Coordinate multi-agent work for "${title}". Configure members first, then start the group chat.`
    );
  }
  return false;
}
