import type { CreativeProjectScope } from "./creative-project.ts";
import {
  assertCreativeProjectScope,
  creativeProjectDigest,
  creativeProjectOpaqueId,
  creativeProjectScopeFields,
  creativeProjectTimestamp,
} from "./creative-project-validation.ts";
import {
  PROJECT_SOURCE_MAX_FILE_BYTES,
  projectSourceChapterTitle,
  projectSourceChecked,
  projectSourceChunkText,
  projectSourceFailure,
  projectSourceFileName,
  projectSourceInteger,
  projectSourceRecord,
  projectSourceScalarLength,
} from "./project-source-validation.ts";

export type ProjectSourceFormat = "txt" | "md" | "html";

/** No book text belongs in this manifest. Digests are computed and verified by the byte/text store. */
export type ProjectSource = CreativeProjectScope &
  Readonly<{
    schemaVersion: "crewon.project-source.v1";
    revision: number;
    /** SHA256 of all normalized UTF8 source text, distinct from the uploaded file. */
    digest: string;
    /** SHA256 of the original uploaded bytes, including their original encoding/markup. */
    fileDigest: string;
    fileName: string;
    /** Input metadata only; this does not assert that HTML parsing or ingestion completed. */
    format: ProjectSourceFormat;
    byteLength: number;
    /** Count of Unicode scalar values in normalized source text. Offsets use this same unit. */
    characterLength: number;
    createdByActorId: string;
    createdAt: string;
  }>;

export type ProjectSourceChunk = CreativeProjectScope &
  Readonly<{
    sourceRevision: number;
    index: number;
    startOffset: number;
    content: string;
    /** SHA256 of this chunk's normalized UTF8 bytes; verified by the store before reading. */
    digest: string;
  }>;

/** A source chapter is not an episode. A chapter range is [startOffset, endOffset) in scalar values. */
export type ProjectSourceChapter = CreativeProjectScope &
  Readonly<{
    sourceRevision: number;
    chapterId: string;
    title: string;
    startOffset: number;
    endOffset: number;
  }>;

/** Structural validation only: no raw file or complete text is provided to prove either digest. */
export function parseProjectSource(input: unknown): ProjectSource {
  return projectSourceChecked(() => {
    const value = projectSourceRecord(input, [
      "schemaVersion",
      "tenantId",
      "spaceId",
      "projectId",
      "revision",
      "digest",
      "fileDigest",
      "fileName",
      "format",
      "byteLength",
      "characterLength",
      "createdByActorId",
      "createdAt",
    ]);
    if (value.schemaVersion !== "crewon.project-source.v1")
      projectSourceFailure("project_source_schema_unsupported");
    if (
      value.format !== "txt" &&
      value.format !== "md" &&
      value.format !== "html"
    )
      projectSourceFailure("project_source_format_invalid");
    return Object.freeze({
      schemaVersion: "crewon.project-source.v1",
      ...creativeProjectScopeFields(value),
      revision: projectSourceInteger(value.revision, 1),
      digest: creativeProjectDigest(value.digest),
      fileDigest: creativeProjectDigest(value.fileDigest),
      fileName: projectSourceFileName(value.fileName),
      format: value.format,
      byteLength: projectSourceInteger(
        value.byteLength,
        1,
        PROJECT_SOURCE_MAX_FILE_BYTES,
      ),
      characterLength: projectSourceInteger(value.characterLength, 1),
      createdByActorId: creativeProjectOpaqueId(value.createdByActorId),
      createdAt: creativeProjectTimestamp(value.createdAt),
    });
  });
}

export function parseProjectSourceChunk(input: unknown): ProjectSourceChunk {
  return projectSourceChecked(() => {
    const value = projectSourceRecord(input, [
      "tenantId",
      "spaceId",
      "projectId",
      "sourceRevision",
      "index",
      "startOffset",
      "content",
      "digest",
    ]);
    const content = projectSourceChunkText(value.content);
    const index = projectSourceInteger(value.index, 0);
    const startOffset = projectSourceInteger(value.startOffset, 0);
    if (
      index > startOffset ||
      Math.ceil(startOffset / 4_096) > index ||
      projectSourceScalarLength(content) > Number.MAX_SAFE_INTEGER - startOffset
    )
      projectSourceFailure("project_source_chunk_offset_invalid");
    return Object.freeze({
      ...creativeProjectScopeFields(value),
      sourceRevision: projectSourceInteger(value.sourceRevision, 1),
      index,
      startOffset,
      content,
      digest: creativeProjectDigest(value.digest),
    });
  });
}

export function parseProjectSourceChapter(
  input: unknown,
): ProjectSourceChapter {
  return projectSourceChecked(() => {
    const value = projectSourceRecord(input, [
      "tenantId",
      "spaceId",
      "projectId",
      "sourceRevision",
      "chapterId",
      "title",
      "startOffset",
      "endOffset",
    ]);
    const startOffset = projectSourceInteger(value.startOffset, 0);
    const endOffset = projectSourceInteger(value.endOffset, 1);
    if (endOffset <= startOffset)
      projectSourceFailure("project_source_chapter_range_invalid");
    return Object.freeze({
      ...creativeProjectScopeFields(value),
      sourceRevision: projectSourceInteger(value.sourceRevision, 1),
      chapterId: creativeProjectOpaqueId(value.chapterId),
      title: projectSourceChapterTitle(value.title),
      startOffset,
      endOffset,
    });
  });
}

/** Identity/range checks do not compute or certify content digests. */
export function assertProjectSourceChunkIdentity(
  source: ProjectSource,
  chunk: ProjectSourceChunk,
): void {
  projectSourceChecked(() => {
    const checkedSource = parseProjectSource(source);
    const checkedChunk = parseProjectSourceChunk(chunk);
    assertCreativeProjectScope(checkedSource, checkedChunk);
    if (checkedSource.revision !== checkedChunk.sourceRevision)
      projectSourceFailure("project_source_revision_mismatch");
    if (
      checkedChunk.startOffset >= checkedSource.characterLength ||
      projectSourceScalarLength(checkedChunk.content) >
        checkedSource.characterLength - checkedChunk.startOffset
    )
      projectSourceFailure("project_source_chunk_range_invalid");
  });
}

export function assertProjectSourceChapterIdentity(
  source: ProjectSource,
  chapter: ProjectSourceChapter,
): void {
  projectSourceChecked(() => {
    const checkedSource = parseProjectSource(source);
    const checkedChapter = parseProjectSourceChapter(chapter);
    assertCreativeProjectScope(checkedSource, checkedChapter);
    if (checkedSource.revision !== checkedChapter.sourceRevision)
      projectSourceFailure("project_source_revision_mismatch");
    if (checkedChapter.endOffset > checkedSource.characterLength)
      projectSourceFailure("project_source_chapter_range_invalid");
  });
}

export {
  PROJECT_SOURCE_MAX_FILE_BYTES,
  PROJECT_SOURCE_MAX_CHUNK_BYTES,
  PROJECT_SOURCE_MAX_PAGE_SCALARS,
  PROJECT_SOURCE_MAX_PAGE_CHUNKS,
  ProjectSourceError,
  projectSourceScalarLength,
} from "./project-source-validation.ts";
export {
  readProjectSourcePage,
  type ProjectSourcePage,
  type ReadProjectSourcePageInput,
} from "./project-source-page.ts";
