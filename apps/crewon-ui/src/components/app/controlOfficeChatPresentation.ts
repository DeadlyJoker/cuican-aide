import type { Thread } from "@crewon/app-server-protocol/v2/Thread";
import type { ThreadItem } from "@crewon/app-server-protocol/v2/ThreadItem";
import type { OfficeMemberContract } from "@crewon/contracts";

import {
  controlTeamDelegatedMemberId,
  visibleControlTeamAssistantContent,
} from "../../lib/control-runtime/controlTeamDelegation";
import type { Locale } from "../../lib/i18n";
import { controlOfficeMemberMentionsFromRenderedText } from "../../lib/office/controlOfficeMemberMentions";
import type { ControlOfficeDefinitionRecordReference } from "../../lib/office/officePanelFromRecord";
import { officeMemberDisplayName } from "../../lib/office/officePanelFromRecord";
import { upsertTurn } from "../../lib/thread/threadModel";

const OFFICE_THREAD_PREFIX = "CrewON Office Chat";

export type ControlOfficeChatMessage = Readonly<{
  author: string;
  glyph: string;
  id: string;
  messageId?: string;
  userMessageId?: string;
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

export function controlOfficeLiveThread(
  threads: readonly Thread[],
  threadId: string | null,
  title: string,
  legacyTitle: string,
): Thread | null {
  if (threadId !== null) {
    return threads.find((candidate) => candidate.id === threadId) ?? null;
  }
  return (
    threads.find((candidate) => candidate.name === title) ??
    threads.find((candidate) => candidate.name === legacyTitle) ??
    null
  );
}

export function controlOfficeVisibleThread(
  loadedThread: Thread | null,
  liveThread: Thread | null,
  options?: { removedTurnIds: ReadonlySet<string> },
): Thread | null {
  // A committed edit invalidates both the cached history and delayed live updates.
  const withoutRemovedTurns = (thread: Thread | null) =>
    thread && options?.removedTurnIds.size
      ? {
          ...thread,
          turns: thread.turns.filter(
            (turn) => !options.removedTurnIds.has(turn.id),
          ),
        }
      : thread;
  loadedThread = withoutRemovedTurns(loadedThread);
  liveThread = withoutRemovedTurns(liveThread);
  if (loadedThread === null) return liveThread;
  if (liveThread === null || liveThread.id !== loadedThread.id) {
    return loadedThread;
  }

  let merged: Thread = {
    ...loadedThread,
    ...liveThread,
    status:
      liveThread.status.type === "notLoaded"
        ? loadedThread.status
        : liveThread.status,
    turns: loadedThread.turns,
  };
  for (const turn of liveThread.turns) {
    merged = upsertTurn(merged, turn);
  }
  return merged;
}

export function controlOfficeChatMessages(
  thread: Thread | null,
  leaderName: string,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): ControlOfficeChatMessage[] {
  if (!thread) {
    return [];
  }
  const seenUserMessageIds = new Set<string>();
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
    const includeUser =
      user?.type === "userMessage" &&
      Boolean(userText) &&
      !seenUserMessageIds.has(user.id);
    if (includeUser) {
      seenUserMessageIds.add(user.id);
    }
    const assistants = turn.items.filter(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage" && Boolean(item.text.trim()),
    );
    const directMentions = controlOfficeMemberMentionsFromRenderedText(
      userText,
      members,
      locale,
    );
    const directMemberId =
      directMentions.length === 1 ? directMentions[0]!.memberId : null;
    const delegatedMemberId =
      directMemberId === null && assistants[0]?.type === "agentMessage"
        ? controlTeamDelegatedMemberId(assistants[0].text)
        : null;
    const memberName = (memberId: string | null) => {
      if (memberId === null) return null;
      const memberIndex = members.findIndex(
        (member) => member.memberId === memberId,
      );
      const member = members[memberIndex];
      return member === undefined
        ? null
        : officeMemberDisplayName(member.displayName, memberIndex, locale);
    };
    return [
      ...(includeUser
        ? [
            {
              author: locale === "zh" ? "你" : "You",
              glyph: "@",
              id: `${turn.id}:user`,
              userMessageId: user.id,
              self: true,
              text: userText,
              time,
            },
          ]
        : []),
      ...assistants.map((assistant, assistantIndex) => {
        const routedMemberName = memberName(
          directMemberId ?? (assistantIndex > 0 ? delegatedMemberId : null),
        );
        const author = routedMemberName ?? leaderName;
        return {
          author,
          glyph: Array.from(author.trim())[0] || "组",
          id: `${turn.id}:assistant:${assistant.id}`,
          messageId: assistant.id,
          userMessageId: user?.id,
          self: false,
          text: visibleControlTeamAssistantContent(assistant.text),
          time,
        };
      }),
    ];
  });
}

export function controlOfficeStreamingAuthor(
  thread: Thread | null,
  leaderName: string,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): string {
  const memberName = (memberId: string | null) => {
    if (memberId === null) return null;
    const memberIndex = members.findIndex(
      (member) => member.memberId === memberId,
    );
    const member = members[memberIndex];
    return member === undefined
      ? null
      : officeMemberDisplayName(member.displayName, memberIndex, locale);
  };
  if (members.length === 1) {
    return memberName(members[0]?.memberId ?? null) ?? leaderName;
  }

  const turn = thread?.turns.at(-1);
  if (!turn) return leaderName;
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
  const directMentions = controlOfficeMemberMentionsFromRenderedText(
    userText,
    members,
    locale,
  );
  if (directMentions.length === 1) {
    return memberName(directMentions[0]!.memberId) ?? leaderName;
  }

  const delegatedMemberId = turn.items
    .filter(
      (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
        item.type === "agentMessage",
    )
    .map((item) => controlTeamDelegatedMemberId(item.text))
    .find((memberId): memberId is string => memberId !== null);
  return memberName(delegatedMemberId ?? null) ?? leaderName;
}

export function controlOfficeChatErrorMessage(
  reason: unknown,
  locale: Locale,
): string {
  const code = reason instanceof Error ? reason.message : String(reason);
  switch (code) {
    case "control_execution_intent_capability_unavailable":
      return locale === "zh"
        ? "当前后端版本还不支持目标或计划模式。请完成服务升级后重试；消息和模式已保留。"
        : "The current backend does not support Goal or Plan mode yet. Finish the service upgrade and try again; the message and mode were preserved.";
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
    case "control_team_plan_unsupported":
      return locale === "zh"
        ? "多成员办公室暂不支持计划模式。请直接 @ 一名成员，或关闭计划模式后重试。"
        : "Plan mode is not yet supported for multi-member Offices. Mention one member directly or turn Plan off.";
    case "goal_usage_limited":
    case "goal_budget_limited":
      return locale === "zh"
        ? "当前目标已达到使用或预算限制，请先调整目标后再继续。"
        : "The current Goal reached its usage or budget limit. Adjust it before continuing.";
    default:
      return locale === "zh"
        ? "操作没有完成，请稍后再试。"
        : "That did not complete. Please try again shortly.";
  }
}
