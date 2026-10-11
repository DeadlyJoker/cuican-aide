import type { DatabaseSync } from "node:sqlite";
import {
  projectSourceScalarLength,
  type ProjectSource,
  type ProjectSourceChunk,
  type ProjectSourceChapter,
} from "@crewon/domain";
import { foundationJson } from "./project-foundation-store-support.ts";
/** Inserts into the caller's original BEGIN IMMEDIATE transaction. */
export function insertSqliteFoundationSource(
  database: DatabaseSync,
  source: ProjectSource,
  chunks: readonly ProjectSourceChunk[],
  chapters: readonly ProjectSourceChapter[],
): void {
  database
    .prepare("INSERT INTO project_sources VALUES(?,?,?,?,?,?,?,?)")
    .run(
      source.tenantId,
      source.spaceId,
      source.projectId,
      source.revision,
      source.digest,
      source.fileDigest,
      source.characterLength,
      foundationJson(source, 8_192),
    );
  const insertChunk = database.prepare(
    "INSERT INTO project_source_chunks VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const chunk of chunks)
    insertChunk.run(
      chunk.tenantId,
      chunk.spaceId,
      chunk.projectId,
      chunk.sourceRevision,
      chunk.index,
      chunk.startOffset,
      projectSourceScalarLength(chunk.content),
      chunk.content,
      chunk.digest,
    );
  const insertChapter = database.prepare(
    "INSERT INTO project_source_chapters VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const chapter of chapters)
    insertChapter.run(
      chapter.tenantId,
      chapter.spaceId,
      chapter.projectId,
      chapter.sourceRevision,
      chapter.chapterId,
      chapter.startOffset,
      chapter.endOffset,
      foundationJson(chapter, 4_096),
    );
}
