import { createHash } from "node:crypto";
import {
  PROJECT_SOURCE_MAX_CHUNK_BYTES,
  PROJECT_SOURCE_MAX_FILE_BYTES,
} from "@crewon/domain";
import type {
  ParsedProjectSourceFile,
  ParseProjectSourceFileInput,
  ProjectSourceHeading,
} from "./project-source-import-types.ts";
import {
  assertSourceImportPlainFormat,
  assertSourceImportBinaryMagic,
  assertSourceImportText,
  sourceImportBytes,
  sourceImportDecode,
  sourceImportFailure,
  sourceImportFields,
  sourceImportName,
} from "./project-source-import-validation.ts";
import { sourceHtmlStory } from "./project-source-html-parser.ts";
import { sourceTextHeadings } from "./project-source-text-chapters.ts";

export type {
  ParsedProjectSourceFile,
  ParseProjectSourceFileInput,
} from "./project-source-import-types.ts";
export { ProjectSourceImportError } from "./project-source-import-validation.ts";

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** All work is bounded byte parsing. This returns no model fragment, project, identity, or execution. */
export function parseProjectSourceFile(
  input: ParseProjectSourceFileInput,
): ParsedProjectSourceFile {
  const value = sourceImportFields(input);
  const name = sourceImportName(value.fileName, value.format);
  const bytes = sourceImportBytes(value.bytes);
  const decoded = sourceImportDecode(bytes);
  assertSourceImportBinaryMagic(decoded);
  let text: string;
  let headings: readonly ProjectSourceHeading[];
  if (name.format === "html") {
    const story = sourceHtmlStory(decoded);
    text = story.text;
    headings = story.headings;
  } else {
    assertSourceImportPlainFormat(decoded, name.format);
    text = decoded;
    headings = sourceTextHeadings(text, name.format);
  }
  if (!text.trim()) sourceImportFailure("project_source_import_empty_text");
  assertSourceImportText(text);
  if (Buffer.byteLength(text) > PROJECT_SOURCE_MAX_FILE_BYTES)
    sourceImportFailure("project_source_import_text_limit");
  const chunks: ParsedProjectSourceFile["chunks"][number][] = [];
  let pieces: string[] = [],
    chunkBytes = 0,
    startOffset = 0,
    characterLength = 0;
  function flush() {
    if (pieces.length === 0) return;
    const content = pieces.join("");
    chunks.push(
      Object.freeze({
        index: chunks.length,
        startOffset,
        content,
        digest: digest(content),
      }),
    );
    pieces = [];
    chunkBytes = 0;
    startOffset = characterLength;
  }
  for (const scalar of text) {
    const scalarBytes = Buffer.byteLength(scalar);
    if (chunkBytes + scalarBytes > PROJECT_SOURCE_MAX_CHUNK_BYTES) flush();
    pieces.push(scalar);
    chunkBytes += scalarBytes;
    characterLength++;
  }
  flush();
  const boundaries =
    headings.length === 0 || headings[0]!.startOffset > 0
      ? [Object.freeze({ title: "正文", startOffset: 0 }), ...headings]
      : headings;
  if (boundaries.length > 20_000)
    sourceImportFailure("project_source_import_chapter_limit");
  const chapters = boundaries.map((heading, index) => {
    const endOffset = boundaries[index + 1]?.startOffset ?? characterLength;
    if (heading.startOffset >= endOffset)
      sourceImportFailure("project_source_import_chapter_range_invalid");
    return Object.freeze({
      chapterId: `chapter-${String(index + 1).padStart(6, "0")}`,
      title: heading.title,
      startOffset: heading.startOffset,
      endOffset,
    });
  });
  return Object.freeze({
    ...name,
    byteLength: bytes.length,
    characterLength,
    digest: digest(text),
    fileDigest: digest(bytes),
    chunks: Object.freeze(chunks),
    chapters: Object.freeze(chapters),
  });
}
