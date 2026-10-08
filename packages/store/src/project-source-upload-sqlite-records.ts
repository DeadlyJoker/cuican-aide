import type { DatabaseSync } from "node:sqlite";
import {
  captureSourceUploadInitial,
  captureSourceUploadPart,
  captureSourceUploadState,
  sourceUploadFields,
  type ProjectSourceUploadRead,
  type ProjectSourceUploadState,
  type PreparedProjectSource,
} from "@crewon/application";
import { projectSourceScalarLength } from "@crewon/domain";
import {
  sourceUploadOwnerValues,
  sourceUploadSame,
  sourceUploadFailure,
  sourceUploadBytes,
} from "./project-source-upload-store-support.ts";

export const sourceUploadSqliteFilter =
  "tenant_id=? AND space_id=? AND owner_principal_id=? AND upload_id=?";
export function sourceUploadSqliteValues(q: ProjectSourceUploadRead) {
  return [...sourceUploadOwnerValues(q.owner), q.uploadId];
}
type Row = Record<string, unknown>;
function same(actual: unknown, expected: unknown): void {
  if (actual !== expected)
    sourceUploadFailure(
      "project_source_upload_store_index_invalid",
      "internal",
    );
}
export function assertSqliteUploadScope(
  row: Row,
  q: ProjectSourceUploadRead,
): void {
  for (const [column, expected] of Object.entries({
    tenant_id: q.owner.tenantId,
    space_id: q.owner.spaceId,
    owner_principal_id: q.owner.principalId,
    upload_id: q.uploadId,
  }))
    same(row[column], expected);
}
export function sqliteUploadState(
  database: DatabaseSync,
  q: ProjectSourceUploadRead,
  storageRealmId: string,
): ProjectSourceUploadState | null {
  const values = sourceUploadSqliteValues(q);
  const initialRow = database
    .prepare(
      `SELECT * FROM project_source_uploads WHERE ${sourceUploadSqliteFilter}`,
    )
    .get(...values);
  if (initialRow === undefined) return null;
  const head = database
    .prepare(
      `SELECT * FROM project_source_upload_heads WHERE ${sourceUploadSqliteFilter}`,
    )
    .get(...values);
  if (head === undefined)
    sourceUploadFailure(
      "project_source_upload_store_index_invalid",
      "internal",
    );
  assertSqliteUploadScope(initialRow, q);
  assertSqliteUploadScope(head, q);
  const initial = captureSourceUploadInitial(
      JSON.parse(String(initialRow.record_json)),
    ),
    state = captureSourceUploadState(JSON.parse(String(head.record_json)));
  same(initial.storageRealmId, storageRealmId);
  same(initial.uploadId, q.uploadId);
  sourceUploadSame(initial.owner, q.owner);
  same(initial.requestDigest, initialRow.request_digest);
  same(initial.fileDigest, initialRow.file_digest);
  same(initial.byteLength, initialRow.byte_length);
  sourceUploadSame(initial, state.initial);
  same(state.revision, head.revision);
  same(state.phase, head.phase);
  const parts = database
    .prepare(
      `SELECT * FROM project_source_upload_parts WHERE ${sourceUploadSqliteFilter} ORDER BY part_index LIMIT 307`,
    )
    .all(...values)
    .map((row) => sqliteUploadPart(row, state));
  sourceUploadSame(parts, state.parts);
  const seal = database
    .prepare(
      `SELECT * FROM project_source_upload_seals WHERE ${sourceUploadSqliteFilter}`,
    )
    .get(...values);
  if (state.sealed === null) {
    if (seal !== undefined)
      sourceUploadFailure(
        "project_source_upload_store_index_invalid",
        "internal",
      );
  } else {
    if (seal === undefined)
      sourceUploadFailure(
        "project_source_upload_store_index_invalid",
        "internal",
      );
    assertSqliteUploadScope(seal, q);
    same(seal.upload_digest, state.sealed.uploadDigest);
    sourceUploadSame(JSON.parse(String(seal.record_json)), state.sealed);
  }
  const prepared = database
    .prepare(
      `SELECT * FROM project_source_upload_prepared WHERE ${sourceUploadSqliteFilter}`,
    )
    .get(...values);
  if (state.prepared === null) {
    if (prepared !== undefined)
      sourceUploadFailure(
        "project_source_upload_store_index_invalid",
        "internal",
      );
  } else {
    if (prepared === undefined)
      sourceUploadFailure(
        "project_source_upload_store_index_invalid",
        "internal",
      );
    assertSqliteUploadScope(prepared, q);
    same(prepared.prepared_digest, state.prepared.pointer.preparedDigest);
    same(prepared.content_digest, state.prepared.digest);
    same(
      prepared.parser_version,
      state.prepared.pointer.normalizationParserVersion,
    );
    sourceUploadSame(JSON.parse(String(prepared.record_json)), state.prepared);
  }
  const event = database
    .prepare(
      `SELECT * FROM project_source_upload_events WHERE ${sourceUploadSqliteFilter} ORDER BY head_revision DESC LIMIT 1`,
    )
    .get(...values);
  if (event === undefined)
    sourceUploadFailure(
      "project_source_upload_store_index_invalid",
      "internal",
    );
  assertSqliteUploadScope(event, q);
  same(event.head_revision, state.revision);
  same(event.phase, state.phase);
  sourceUploadSame(JSON.parse(String(event.record_json)), state);
  return state;
}
export function sqliteUploadPart(row: Row, state: ProjectSourceUploadState) {
  assertSqliteUploadScope(row, {
    owner: state.initial.owner,
    uploadId: state.initial.uploadId,
  });
  const part = captureSourceUploadPart(
    JSON.parse(String(row.record_json)),
    state.initial,
  );
  same(part.index, row.part_index);
  same(part.byteOffset, row.byte_offset);
  same(part.byteLength, row.byte_length);
  same(part.rawDigest, row.raw_digest);
  return part;
}
export function sqliteUploadRaw(
  database: DatabaseSync,
  state: ProjectSourceUploadState,
) {
  const q = { owner: state.initial.owner, uploadId: state.initial.uploadId };
  return database
    .prepare(
      `SELECT * FROM project_source_upload_part_payloads WHERE ${sourceUploadSqliteFilter} ORDER BY part_index LIMIT 307`,
    )
    .all(...sourceUploadSqliteValues(q))
    .map((row) => {
      assertSqliteUploadScope(row, q);
      const part = state.parts.find((p) => p.index === row.part_index);
      if (!part)
        sourceUploadFailure(
          "project_source_upload_store_index_invalid",
          "internal",
        );
      return Object.freeze({
        part,
        bytes: sourceUploadBytes(row.payload, 65_536, part.byteLength),
      });
    });
}
export function sqliteUploadParsed(
  database: DatabaseSync,
  state: ProjectSourceUploadState,
) {
  const q = { owner: state.initial.owner, uploadId: state.initial.uploadId },
    values = sourceUploadSqliteValues(q);
  if (state.prepared === null)
    sourceUploadFailure("project_source_upload_state_conflict");
  const chunks = database
    .prepare(
      `SELECT * FROM project_source_upload_prepared_chunks WHERE ${sourceUploadSqliteFilter} ORDER BY chunk_index LIMIT 20001`,
    )
    .all(...values)
    .map((row) => {
      assertSqliteUploadScope(row, q);
      if (
        typeof row.content !== "string" ||
        typeof row.content_digest !== "string"
      )
        sourceUploadFailure(
          "project_source_upload_store_index_invalid",
          "internal",
        );
      same(row.character_length, projectSourceScalarLength(row.content));
      return Object.freeze({
        index: row.chunk_index as number,
        startOffset: row.start_offset as number,
        content: row.content,
        digest: row.content_digest,
      });
    });
  const chapters = database
    .prepare(
      `SELECT * FROM project_source_upload_prepared_chapters WHERE ${sourceUploadSqliteFilter} ORDER BY start_offset LIMIT 20001`,
    )
    .all(...values)
    .map((row) => {
      assertSqliteUploadScope(row, q);
      const chapter = sourceUploadFields(JSON.parse(String(row.record_json)), [
        "chapterId",
        "title",
        "startOffset",
        "endOffset",
      ]);
      same(row.chapter_id, chapter.chapterId);
      same(row.start_offset, chapter.startOffset);
      same(row.end_offset, chapter.endOffset);
      return Object.freeze(
        chapter,
      ) as PreparedProjectSource["chapters"][number];
    });
  return Object.freeze({
    fileName: state.initial.fileName,
    format: state.initial.format,
    byteLength: state.initial.byteLength,
    fileDigest: state.initial.fileDigest,
    characterLength: state.prepared.characterLength,
    digest: state.prepared.digest,
    chunks: Object.freeze(chunks),
    chapters: Object.freeze(chapters),
  });
}
