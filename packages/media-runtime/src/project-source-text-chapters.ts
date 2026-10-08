import type { ProjectSourceHeading } from "./project-source-import-types.ts";
import {
  sourceImportFailure,
  sourceScalarLength,
} from "./project-source-import-validation.ts";

/** Heading offsets always refer to preserved normalized source, never to an episode. */
export function sourceTextHeadings(
  text: string,
  format: "txt" | "md",
): readonly ProjectSourceHeading[] {
  const headings: ProjectSourceHeading[] = [];
  let position = 0,
    scalarOffset = 0;
  let previous: { text: string; startOffset: number } | null = null;
  let fence: { character: string; length: number } | null = null;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(position, end);
    if (format === "md") {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (fence !== null) {
        if (
          match &&
          match[1]![0] === fence.character &&
          match[1]!.length >= fence.length &&
          !match[2]!.trim()
        )
          fence = null;
        previous = null;
      } else if (match) {
        fence = { character: match[1]![0]!, length: match[1]!.length };
        previous = null;
      } else {
        const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*)|[ \t]*)$/u.exec(line);
        if (atx) {
          const title = (atx[1] ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
          addHeading(headings, title, scalarOffset);
          previous = null;
        } else if (previous !== null && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(line)) {
          addHeading(headings, previous.text.trim(), previous.startOffset);
          previous = null;
        } else
          previous =
            line.trim() && line.length <= 320 && !/^ {4}/u.test(line)
              ? { text: line, startOffset: scalarOffset }
              : null;
      }
    } else if (line.length <= 320) {
      const title = line.trim();
      if (
        /^(?:第[零〇一二三四五六七八九十百千万两0-9０-９]+[章回卷节部]|(?:序章|序言|楔子|引子|尾声|后记|终章)(?:\s|[：:、.．]|$)|chapter\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s|[.:：]|$))/iu.test(
          title,
        )
      )
        addHeading(headings, title, scalarOffset);
    }
    scalarOffset += sourceScalarLength(line) + (newline < 0 ? 0 : 1);
    position = end + 1;
  }
  return Object.freeze(headings);
}

export function addHeading(
  headings: ProjectSourceHeading[],
  title: string,
  startOffset: number,
): void {
  title = title.trim().replace(/[ \t\r\n]+/gu, " ");
  if (!title) return;
  if (title.length > 320)
    sourceImportFailure("project_source_import_chapter_title_limit");
  if (headings.length >= 20_000)
    sourceImportFailure("project_source_import_chapter_limit");
  if (headings.at(-1)?.startOffset === startOffset) return;
  headings.push(Object.freeze({ title, startOffset }));
}
