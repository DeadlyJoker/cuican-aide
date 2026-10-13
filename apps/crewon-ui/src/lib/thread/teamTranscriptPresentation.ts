/** Presentation only: durable model messages retain their original routing markers. */
export function visibleTeamAssistantText(content: string): string {
  return content
    .replace(/(?:\r?\n)?\[\[CrewON delegate:[^\]\r\n]{1,768}\]\]/gu, "")
    .replace(/(?:\r?\n)?\[\[CrewON delegate:[^\]\r\n]{0,768}\]?$/u, "");
}
