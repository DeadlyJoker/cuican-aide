import type { MarkdownMention } from "../TranscriptMarkdown";
import { renderMarkdown } from "../TranscriptMarkdown";

export function OfficeMessageMarkdown({
  mentions,
  text,
}: {
  mentions: readonly MarkdownMention[];
  text: string;
}) {
  return renderMarkdown(text, { mentions, softBreaks: true });
}
