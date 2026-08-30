import type { Thread } from "@crewon/app-server-protocol/v2/Thread";

import type { Locale } from "../../lib/i18n";
import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";

const OFFICE_THREAD_PREFIX = "CrewON Office Chat";

export type ControlOfficeChatMessage = Readonly<{
  author: string;
  glyph: string;
  id: string;
  self: boolean;
  text: string;
  time: string;
}>;

export function controlOfficeThreadTitle(
  record: ControlOfficeDefinitionRecordReference,
): string {
  const title = Array.from(record.config.title.trim()).slice(0, 96).join("");
  return `💬 ${title}`;
}

export function legacyControlOfficeThreadTitle(
  record: ControlOfficeDefinitionRecordReference,
): string {
  const title = Array.from(record.config.title.trim()).slice(0, 96).join("");
  return `${OFFICE_THREAD_PREFIX} · ${record.definition.officeVersionId} · ${title}`;
}

export function controlOfficeChatMessages(
  thread: Thread | null,
  leaderName: string,
  locale: Locale,
): ControlOfficeChatMessage[] {
  if (!thread) {
    return [];
  }
  return thread.turns.flatMap((turn) => {
    const time = turn.startedAt
      ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(turn.startedAt * 1_000))
      : "";
    const user = turn.items.find((item) => item.type === "userMessage");
    const userText =
      user?.type === "userMessage"
        ? user.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n\n")
            .replace(/\n\n\[附件：[\s\S]*$/u, "")
            .trim()
        : "";
    const assistant = [...turn.items]
      .reverse()
      .find((item) => item.type === "agentMessage" && item.text.trim());
    return [
      ...(userText
        ? [
            {
              author: locale === "zh" ? "你" : "You",
              glyph: "@",
              id: `${turn.id}:user`,
              self: true,
              text: userText,
              time,
            },
          ]
        : []),
      ...(assistant?.type === "agentMessage"
        ? [
            {
              author: leaderName,
              glyph: Array.from(leaderName.trim())[0] || "组",
              id: `${turn.id}:assistant`,
              self: false,
              text: assistant.text,
              time,
            },
          ]
        : []),
    ];
  });
}

export function controlOfficeChatErrorMessage(
  reason: unknown,
  locale: Locale,
): string {
  const code = reason instanceof Error ? reason.message : String(reason);
  switch (code) {
    case "control_team_agent_version_unavailable":
    case "control_office_agent_version_not_active":
      return locale === "zh"
        ? "这个办公室里有成员暂时不可用，请在成员设置中更新后再试。"
        : "A member of this Office is unavailable. Update the member settings and try again.";
    case "control_team_member_count_unsupported":
    case "control_office_runtime_not_available":
      return locale === "zh"
        ? "这个办公室暂时无法开始协作，请检查成员设置后再试。"
        : "This Office cannot start collaborating yet. Check the member settings and try again.";
    default:
      return locale === "zh"
        ? "操作没有完成，请稍后再试。"
        : "That did not complete. Please try again shortly.";
  }
}
