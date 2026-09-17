/** A deterministic label, not an LLM summary. Never include appended tool context. */
export function deriveThreadTitle(content: string): string | null {
  const visible = content
    .slice(0, 8192)
    .split(/\n\n<crewon_(?:selected|office_member)_context\b/u)[0]!
    .trim();
  if (!visible) return null;
  const automationTitle = /^<automation_run\b/u.test(visible)
    ? /<title>([^<]{1,256})<\/title>/u.exec(visible)?.[1]
    : undefined;
  let firstLine = (
    automationTitle ??
    visible.split(/\r?\n/u).find((line) => line.trim()) ??
    ""
  )
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, "")
    .replace(
      /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim();
  // Task-pack framing is transport metadata, not part of the user's task name.
  if (/\s+—\s+crewon\.[\w.-]+@[\w.-]+$/u.test(firstLine)) {
    firstLine = firstLine
      .replace(/\s+—\s+crewon\.[\w.-]+@[\w.-]+$/u, "")
      .split(" / ")[0]!
      .trim();
  }
  if (!firstLine || firstLine.startsWith("<crewon_")) return null;
  const points = Array.from(firstLine);
  if (points.length <= 48) return firstLine;
  return `${points.slice(0, 47).join("").trimEnd()}…`;
}

/** Only initialize a brand-new unnamed conversation; never replace a user title. */
export function initialThreadTitleData(
  thread: { title: string | null; lastMessageSequence: number },
  message: { role: string; content: string },
): { initialTitle?: string } {
  if (
    thread.title !== null ||
    thread.lastMessageSequence !== 0 ||
    message.role !== "user"
  )
    return {};
  const title = deriveThreadTitle(message.content);
  return title === null ? {} : { initialTitle: title };
}
