import {
  assertProjectSourceChunkIdentity,
  parseProjectSource,
  parseProjectSourceChunk,
  type ProjectSource,
  type ProjectSourceChunk,
} from "./project-source.ts";
import {
  PROJECT_SOURCE_MAX_PAGE_SCALARS,
  projectSourceEnvelope,
  projectSourceFailure,
  projectSourceInteger,
  projectSourceScalarLength,
  projectSourceWindowItems,
} from "./project-source-validation.ts";

export type ReadProjectSourcePageInput = Readonly<{
  source: ProjectSource;
  /** A bounded contiguous window supplied after store-side digest verification, never the entire novel. */
  chunks: readonly ProjectSourceChunk[];
  startOffset: number;
  limit: number;
}>;
export type ProjectSourcePage = Readonly<{
  sourceRevision: number;
  startOffset: number;
  endOffset: number;
  content: string;
  nextOffset: number | null;
}>;

/** Validates scope, revision and scalar coverage; actual text/file/chunk hashes remain the store's responsibility. */
export function readProjectSourcePage(
  input: ReadProjectSourcePageInput,
): ProjectSourcePage {
  const value = projectSourceEnvelope(input, [
    "source",
    "chunks",
    "startOffset",
    "limit",
  ]);
  const source = parseProjectSource(value.source);
  const startOffset = projectSourceInteger(
    value.startOffset,
    0,
    source.characterLength,
  );
  const limit = projectSourceInteger(
    value.limit,
    1,
    PROJECT_SOURCE_MAX_PAGE_SCALARS,
  );
  const chunks = projectSourceWindowItems(value.chunks).map(
    parseProjectSourceChunk,
  );
  const endOffset =
    startOffset + Math.min(limit, source.characterLength - startOffset);
  if (startOffset === source.characterLength) {
    if (chunks.length !== 0)
      projectSourceFailure("project_source_window_invalid");
    return Object.freeze({
      sourceRevision: source.revision,
      startOffset,
      endOffset,
      content: "",
      nextOffset: null,
    });
  }
  if (chunks.length === 0)
    projectSourceFailure("project_source_page_coverage_invalid");
  let previous: ProjectSourceChunk | undefined;
  for (const chunk of chunks) {
    assertProjectSourceChunkIdentity(source, chunk);
    if (
      previous &&
      (chunk.index !== previous.index + 1 ||
        chunk.startOffset !==
          previous.startOffset + projectSourceScalarLength(previous.content))
    )
      projectSourceFailure("project_source_window_continuity_invalid");
    previous = chunk;
  }
  const first = chunks[0]!;
  const last = chunks[chunks.length - 1]!;
  if (
    first.startOffset > startOffset ||
    first.startOffset + projectSourceScalarLength(first.content) <=
      startOffset ||
    last.startOffset + projectSourceScalarLength(last.content) < endOffset
  )
    projectSourceFailure("project_source_page_coverage_invalid");
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.startOffset >= endOffset) break;
    const points = [...chunk.content];
    const from = Math.max(0, startOffset - chunk.startOffset);
    const to = Math.min(points.length, endOffset - chunk.startOffset);
    parts.push(points.slice(from, to).join(""));
  }
  const content = parts.join("");
  if (projectSourceScalarLength(content) !== endOffset - startOffset)
    projectSourceFailure("project_source_page_coverage_invalid");
  return Object.freeze({
    sourceRevision: source.revision,
    startOffset,
    endOffset,
    content,
    nextOffset: endOffset < source.characterLength ? endOffset : null,
  });
}
