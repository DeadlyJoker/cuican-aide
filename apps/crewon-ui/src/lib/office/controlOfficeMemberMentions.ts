import type { OfficeMemberContract } from "@crewon/contracts";

import type { Locale } from "../i18n";
import { officeMemberDisplayName } from "./officePanelFromRecord";

const MAX_CONTROL_OFFICE_MEMBER_MENTIONS = 16;

export type ControlOfficeMemberDraftMention = Readonly<{
  displayText: string;
  memberId: string;
}>;

type MentionCandidate = Readonly<{
  displayName: string;
  memberId: string;
}>;

function isMentionBoundary(value: string): boolean {
  return value.length === 0 || !/[\p{L}\p{M}\p{N}_-]/u.test(value);
}

function isMentionStart(text: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9._%+-]/.test(text[index - 1]);
}

function exactMentionCount(text: string, displayText: string): number {
  if (!displayText.startsWith("@") || displayText.length === 1) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(displayText);
  while (index >= 0) {
    const nextCodePoint = text.slice(index + displayText.length).codePointAt(0);
    const nextCharacter =
      nextCodePoint === undefined ? "" : String.fromCodePoint(nextCodePoint);
    if (isMentionStart(text, index) && isMentionBoundary(nextCharacter)) {
      count += 1;
    }
    index = text.indexOf(displayText, index + displayText.length);
  }
  return count;
}

function memberDisplayName(
  member: OfficeMemberContract,
  index: number,
  locale: Locale,
): string {
  return officeMemberDisplayName(member.displayName, index, locale);
}

function uniqueMentionDisplayText(
  member: OfficeMemberContract,
  index: number,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): string {
  const displayName = memberDisplayName(member, index, locale);
  const matchingIndexes = members.flatMap((candidate, candidateIndex) =>
    memberDisplayName(candidate, candidateIndex, locale) === displayName
      ? [candidateIndex]
      : [],
  );
  if (matchingIndexes.length <= 1) {
    return `@${displayName}`;
  }
  const ordinal = matchingIndexes.indexOf(index) + 1;
  const suffix = locale === "zh" ? `成员 ${ordinal}` : `Member ${ordinal}`;
  return `@${displayName}（${suffix}）`;
}

function mentionCandidates(
  members: readonly OfficeMemberContract[],
  locale: Locale,
): MentionCandidate[] {
  const memberIdsByDisplayName = new Map<string, Set<string>>();
  for (const [index, member] of members.entries()) {
    const memberId = member.memberId.trim();
    const displayName = memberDisplayName(member, index, locale).trim();
    if (!memberId || !displayName) {
      continue;
    }
    const memberIds =
      memberIdsByDisplayName.get(displayName) ?? new Set<string>();
    memberIds.add(memberId);
    memberIdsByDisplayName.set(displayName, memberIds);
  }
  return [...memberIdsByDisplayName.entries()]
    .filter(([, memberIds]) => memberIds.size === 1)
    .map(([displayName, memberIds]) => ({
      displayName,
      memberId: [...memberIds][0]!,
    }))
    .sort((left, right) => right.displayName.length - left.displayName.length);
}

export function controlOfficeMemberMentionForMember(
  member: OfficeMemberContract,
  index: number,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): ControlOfficeMemberDraftMention | null {
  const memberId = member.memberId.trim();
  if (!memberId) {
    return null;
  }
  return {
    displayText: uniqueMentionDisplayText(member, index, members, locale),
    memberId,
  };
}

/** Resolves the visible mention tokens emitted by the Office member picker. */
export function controlOfficeMemberMentionsFromRenderedText(
  text: string,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): ControlOfficeMemberDraftMention[] {
  const renderedMentions = members
    .flatMap((member, index) => {
      const mention = controlOfficeMemberMentionForMember(
        member,
        index,
        members,
        locale,
      );
      return mention ? [mention] : [];
    })
    .filter((mention) => exactMentionCount(text, mention.displayText) > 0);
  return controlOfficeMemberMentionsForSubmission(
    text,
    members,
    locale,
    renderedMentions,
  );
}

/**
 * Resolves manually typed member mentions only when a visible member name maps
 * to exactly one current Office member. This prevents ambiguous display names
 * from routing a message to the wrong agent.
 */
export function controlOfficeMemberMentionsFromText(
  text: string,
  members: readonly OfficeMemberContract[],
  locale: Locale,
): ControlOfficeMemberDraftMention[] {
  const candidates = mentionCandidates(members, locale);
  if (candidates.length === 0 || !text.includes("@")) {
    return [];
  }

  const mentions: ControlOfficeMemberDraftMention[] = [];
  const mentionedMemberIds = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || !isMentionStart(text, index)) {
      continue;
    }
    const candidate = candidates.find(({ displayName }) => {
      const token = `@${displayName}`;
      if (!text.startsWith(token, index)) {
        return false;
      }
      const remainder = text.slice(index + token.length);
      const nextCodePoint = remainder.codePointAt(0);
      const nextCharacter =
        nextCodePoint === undefined ? "" : String.fromCodePoint(nextCodePoint);
      return isMentionBoundary(nextCharacter);
    });
    if (!candidate || mentionedMemberIds.has(candidate.memberId)) {
      continue;
    }
    mentionedMemberIds.add(candidate.memberId);
    mentions.push({
      displayText: `@${candidate.displayName}`,
      memberId: candidate.memberId,
    });
    if (mentions.length === MAX_CONTROL_OFFICE_MEMBER_MENTIONS) {
      break;
    }
  }
  return mentions;
}

/**
 * Combines palette selections and unambiguous text mentions into canonical
 * Office member IDs. Palette selections preserve their identity when member
 * display names collide.
 */
export function controlOfficeMemberMentionsForSubmission(
  text: string,
  members: readonly OfficeMemberContract[],
  locale: Locale,
  selectedMentions: readonly ControlOfficeMemberDraftMention[],
): ControlOfficeMemberDraftMention[] {
  const currentMemberIds = new Set(
    members.map((member) => member.memberId.trim()).filter(Boolean),
  );
  const remainingDisplayTextCounts = new Map<string, number>();
  const mentions: ControlOfficeMemberDraftMention[] = [];
  const mentionedMemberIds = new Set<string>();

  for (const selected of selectedMentions) {
    if (
      !currentMemberIds.has(selected.memberId) ||
      mentionedMemberIds.has(selected.memberId)
    ) {
      continue;
    }
    const remaining =
      remainingDisplayTextCounts.get(selected.displayText) ??
      exactMentionCount(text, selected.displayText);
    if (remaining === 0) {
      continue;
    }
    remainingDisplayTextCounts.set(selected.displayText, remaining - 1);
    mentionedMemberIds.add(selected.memberId);
    mentions.push(selected);
    if (mentions.length === MAX_CONTROL_OFFICE_MEMBER_MENTIONS) {
      return mentions;
    }
  }

  for (const mention of controlOfficeMemberMentionsFromText(
    text,
    members,
    locale,
  )) {
    if (mentionedMemberIds.has(mention.memberId)) {
      continue;
    }
    mentionedMemberIds.add(mention.memberId);
    mentions.push(mention);
    if (mentions.length === MAX_CONTROL_OFFICE_MEMBER_MENTIONS) {
      break;
    }
  }
  return mentions;
}

/** A direct agent route is available only for exactly one Office member. */
export function controlOfficeDirectMemberId(
  mentions: readonly ControlOfficeMemberDraftMention[],
): string | null {
  return mentions.length === 1 ? mentions[0]!.memberId : null;
}
