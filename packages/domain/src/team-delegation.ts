const CONTROL_TEAM_DELEGATION_PATTERN =
  /(?:\r?\n)?\[\[CrewON delegate:([^\]\r\n]{1,768})\]\]/gu;

export function controlTeamDelegationMarker(memberId: string): string {
  return `[[CrewON delegate:${encodeURIComponent(memberId.trim())}]]`;
}

export function controlTeamDelegatedMemberId(content: string): string | null {
  const memberIds = [...content.matchAll(CONTROL_TEAM_DELEGATION_PATTERN)]
    .flatMap((match) => {
      try {
        const memberId = decodeURIComponent(match[1] ?? "").trim();
        return memberId ? [memberId] : [];
      } catch {
        return [];
      }
    })
    .filter(
      (memberId, index, memberIds) => memberIds.indexOf(memberId) === index,
    );
  return memberIds.length === 1 ? memberIds[0]! : null;
}

export function visibleControlTeamAssistantContent(content: string): string {
  return content.replace(CONTROL_TEAM_DELEGATION_PATTERN, "").trim();
}
