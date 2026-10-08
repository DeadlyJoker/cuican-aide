import {
  captureSourceUploadInitial,
  captureSourceUploadPart,
  captureSourceUploadState,
  sourceUploadFields,
  type PreparedProjectSource,
  type ProjectSourceUploadRead,
  type ProjectSourceUploadState,
} from "@crewon/application";
import { projectSourceScalarLength } from "@crewon/domain";
import { sourceUploadSame } from "./project-source-upload-store-support.ts";

export type UploadPostgresRow = Record<string, unknown>;

/** Head JSON is only a projection: its immutable relational records must agree. */
export function decodePostgresUploadState(
  input: Readonly<{
    scope: ProjectSourceUploadRead;
    storageRealmId: string;
    initial: UploadPostgresRow;
    head: UploadPostgresRow;
    parts: readonly UploadPostgresRow[];
    seal: UploadPostgresRow | undefined;
    prepared: UploadPostgresRow | undefined;
    event: UploadPostgresRow | undefined;
  }>,
): ProjectSourceUploadState {
  const initial = captureSourceUploadInitial(json(input.initial.record_json));
  const state = captureSourceUploadState(json(input.head.record_json));
  for (const row of [input.initial, input.head])
    assertPostgresUploadScope(row, input.scope);
  same(initial.storageRealmId, input.storageRealmId);
  same(initial.uploadId, input.scope.uploadId);
  equal(initial.owner, input.scope.owner);
  same(input.initial.request_digest, initial.requestDigest);
  same(input.initial.file_digest, initial.fileDigest);
  same(uploadPostgresNumber(input.initial.byte_length, 1), initial.byteLength);
  equal(state.initial, initial);
  same(uploadPostgresNumber(input.head.revision, 1), state.revision);
  same(input.head.phase, state.phase);
  equal(
    input.parts.map((row) => decodePostgresUploadPart(row, state)),
    state.parts,
  );
  if (state.sealed === null) {
    if (input.seal !== undefined) invalid();
  } else {
    if (input.seal === undefined) invalid();
    assertPostgresUploadScope(input.seal, input.scope);
    same(input.seal.upload_digest, state.sealed.uploadDigest);
    equal(json(input.seal.record_json), state.sealed);
  }
  if (state.prepared === null) {
    if (input.prepared !== undefined) invalid();
  } else {
    if (input.prepared === undefined) invalid();
    assertPostgresUploadScope(input.prepared, input.scope);
    same(input.prepared.prepared_digest, state.prepared.pointer.preparedDigest);
    same(input.prepared.content_digest, state.prepared.digest);
    same(
      input.prepared.parser_version,
      state.prepared.pointer.normalizationParserVersion,
    );
    equal(json(input.prepared.record_json), state.prepared);
  }
  if (input.event === undefined) invalid();
  assertPostgresUploadScope(input.event, input.scope);
  same(uploadPostgresNumber(input.event.head_revision, 1), state.revision);
  same(input.event.phase, state.phase);
  equal(json(input.event.record_json), state);
  return state;
}

export function decodePostgresUploadPart(
  row: UploadPostgresRow,
  state: ProjectSourceUploadState,
) {
  assertPostgresUploadScope(row, {
    owner: state.initial.owner,
    uploadId: state.initial.uploadId,
  });
  const part = captureSourceUploadPart(json(row.record_json), state.initial);
  same(uploadPostgresNumber(row.part_index), part.index);
  same(uploadPostgresNumber(row.byte_offset), part.byteOffset);
  same(uploadPostgresNumber(row.byte_length, 1), part.byteLength);
  same(row.raw_digest, part.rawDigest);
  return part;
}

export function decodePostgresUploadChunk(
  row: UploadPostgresRow,
  scope: ProjectSourceUploadRead,
): PreparedProjectSource["chunks"][number] {
  assertPostgresUploadScope(row, scope);
  if (typeof row.content !== "string" || typeof row.content_digest !== "string")
    invalid();
  same(
    uploadPostgresNumber(row.character_length, 1),
    projectSourceScalarLength(row.content),
  );
  return Object.freeze({
    index: uploadPostgresNumber(row.chunk_index),
    startOffset: uploadPostgresNumber(row.start_offset),
    content: row.content,
    digest: row.content_digest,
  });
}

export function decodePostgresUploadChapter(
  row: UploadPostgresRow,
  scope: ProjectSourceUploadRead,
): PreparedProjectSource["chapters"][number] {
  assertPostgresUploadScope(row, scope);
  const chapter = sourceUploadFields(json(row.record_json), [
    "chapterId",
    "title",
    "startOffset",
    "endOffset",
  ]);
  if (
    typeof chapter.chapterId !== "string" ||
    typeof chapter.title !== "string"
  )
    invalid();
  same(row.chapter_id, chapter.chapterId);
  same(uploadPostgresNumber(row.start_offset), chapter.startOffset);
  same(uploadPostgresNumber(row.end_offset, 1), chapter.endOffset);
  return Object.freeze({
    chapterId: chapter.chapterId,
    title: chapter.title,
    startOffset: chapter.startOffset as number,
    endOffset: chapter.endOffset as number,
  });
}

export function assertPostgresUploadScope(
  row: UploadPostgresRow,
  scope: ProjectSourceUploadRead,
) {
  same(row.tenant_id, scope.owner.tenantId);
  same(row.space_id, scope.owner.spaceId);
  same(row.owner_principal_id, scope.owner.principalId);
  same(row.upload_id, scope.uploadId);
}
export function uploadPostgresNumber(input: unknown, minimum = 0): number {
  const value =
    typeof input === "string" && /^(?:0|[1-9][0-9]*)$/u.test(input)
      ? Number(input)
      : input;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
  return value;
}
function json(input: unknown): unknown {
  return typeof input === "string" ? JSON.parse(input) : input;
}
function equal(actual: unknown, expected: unknown) {
  sourceUploadSame(actual, expected);
}
function same(actual: unknown, expected: unknown) {
  if (actual !== expected) invalid();
}
function invalid(): never {
  throw new Error("project_source_upload_store_index_invalid");
}
