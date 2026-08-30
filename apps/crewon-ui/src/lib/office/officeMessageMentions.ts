import type { OfficeMember } from "../domain/crewonDomain";
import type { OfficeMessageSubmitMention } from "../domain/officeMessageDelivery";

const MAX_OFFICE_MESSAGE_MENTIONS = 16;

export type OfficeMessageDraftMention = {
  agentId?: string;
  displayText: string;
  memberId: string;
};

type MentionCandidate = {
  memberId: string;
  name: string;
};

function isMentionBoundary(value: string): boolean {
  return value.length === 0 || !/[\p{L}\p{M}\p{N}_-]/u.test(value);
}

function isMentionStart(text: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9._%+-]/.test(text[index - 1]);
}

function mentionCandidates(members: OfficeMember[]): MentionCandidate[] {
  const memberIdsByName = new Map<string, Set<string>>();
  for (const member of members) {
    const memberId = member.memberId?.trim();
    const name = member.name.trim();
    if (!memberId || !name) {
      continue;
    }
    const ids = memberIdsByName.get(name) ?? new Set<string>();
    ids.add(memberId);
    memberIdsByName.set(name, ids);
  }

  return [...memberIdsByName.entries()]
    .filter(([, memberIds]) => memberIds.size === 1)
    .map(([name, memberIds]) => ({
      memberId: [...memberIds][0],
      name,
    }))
    .sort((left, right) => right.name.length - left.name.length);
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

function uniqueMentionDisplayText(
  member: OfficeMember,
  members: OfficeMember[],
): string {
  const name = member.name.trim();
  const sameName = members.filter((candidate) => candidate.name.trim() === name);
  if (sameName.length <= 1) {
    return `@${name}`;
  }

  const role = member.role.trim() || "成员";
  const sameRole = sameName.filter(
    (candidate) => (candidate.role.trim() || "成员") === role,
  );
  if (sameRole.length <= 1) {
    return `@${name}（${role}）`;
  }

  const ordinal = Math.max(0, sameRole.indexOf(member)) + 1;
  return `@${name}（${role} ${ordinal}）`;
}

export function officeMessageDraftMentionForMember(
  member: OfficeMember,
  members: OfficeMember[],
): OfficeMessageDraftMention | null {
  const memberId = member.memberId?.trim();
  const name = member.name.trim();
  if (!memberId || !name) {
    return null;
  }
  const agentId = member.agentId?.trim();
  return {
    ...(agentId ? { agentId } : {}),
    displayText: uniqueMentionDisplayText(member, members),
    memberId,
  };
}

/**
 * Builds the canonical mention payload for an Office message.
 *
 * Palette selections keep a stable memberId even when display names collide.
 * Manually typed mentions remain supported only when the display name resolves
 * to exactly one current Office member.
 */
export function officeMessageMentionsForSubmission(
  text: string,
  members: OfficeMember[],
  selectedMentions: OfficeMessageDraftMention[],
): OfficeMessageSubmitMention[] {
  const currentMemberIds = new Set(
    members.flatMap((member) => {
      const memberId = member.memberId?.trim();
      return memberId ? [memberId] : [];
    }),
  );
  const remainingDisplayTextCounts = new Map<string, number>();
  const mentions: OfficeMessageSubmitMention[] = [];
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
    mentions.push({ memberId: selected.memberId });
    if (mentions.length === MAX_OFFICE_MESSAGE_MENTIONS) {
      return mentions;
    }
  }

  for (const mention of officeMessageMentionsFromText(text, members)) {
    if (mentionedMemberIds.has(mention.memberId)) {
      continue;
    }
    mentionedMemberIds.add(mention.memberId);
    mentions.push(mention);
    if (mentions.length === MAX_OFFICE_MESSAGE_MENTIONS) {
      break;
    }
  }
  return mentions;
}

/**
 * Resolves textual Office mentions to canonical member IDs.
 *
 * Ambiguous display names are deliberately ignored so a UI label can never
 * silently route a message to the wrong Office member. An empty result leaves
 * routing with the Office manager, which is the server-owned default.
 */
export function officeMessageMentionsFromText(
  text: string,
  members: OfficeMember[],
): OfficeMessageSubmitMention[] {
  const candidates = mentionCandidates(members);
  if (candidates.length === 0 || !text.includes("@")) {
    return [];
  }

  const mentions: OfficeMessageSubmitMention[] = [];
  const mentionedMemberIds = new Set<string>();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || !isMentionStart(text, index)) {
      continue;
    }
    const candidate = candidates.find(({ name }) => {
      const token = `@${name}`;
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
    mentions.push({ memberId: candidate.memberId });
    if (mentions.length === MAX_OFFICE_MESSAGE_MENTIONS) {
      break;
    }
  }
  return mentions;
}
