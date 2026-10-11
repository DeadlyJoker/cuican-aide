import { assertSqliteCreativeProjectLegacyAccess } from "./creative-project-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import type { DatabaseSync } from "node:sqlite";
import { sourceUploadFields } from "@crewon/application";
import {
  assertFoundationSourceAdoptionState,
  assertFoundationSourceAdoptionChunks,
  assertFoundationSourceAdoptionChapters,
  type FoundationSourceAdoption,
} from "./project-foundation-source-adoption.ts";
import { foundationFailure } from "./project-foundation-store-support.ts";
import { assertSqliteProjectSourceUploadSchema } from "./project-source-upload-schema.ts";
import {
  assertSqliteUploadScope,
  sqliteUploadState,
  sourceUploadSqliteFilter,
  sourceUploadSqliteValues,
} from "./project-source-upload-sqlite-records.ts";
import {
  sourceUploadJson,
  sourceUploadSame,
} from "./project-source-upload-store-support.ts";

/** Borrowed BEGIN IMMEDIATE connection. No migration, parsing or whole-book hash here. */
export function admitSqliteFoundationSourceAdoption(
  database: DatabaseSync,
  proof: FoundationSourceAdoption,
): void {
  assertSqliteCreativeProjectLegacyAccess(
    database,
    foundationLegacyScope(proof.owner, proof.source.projectId),
  );
  const realm = assertSqliteProjectSourceUploadSchema(database);
  if (realm === false)
    foundationFailure("project_foundation_source_upload_schema_unavailable");
  sourceUploadSame(realm, proof.pointer.storageRealmId);
  const scope = { owner: proof.owner, uploadId: proof.pointer.uploadId };
  assertFoundationSourceAdoptionState(
    proof,
    sqliteUploadState(database, scope, realm),
  );
  const values = sourceUploadSqliteValues(scope);
  const chunks = database
    .prepare(
      `SELECT tenant_id,space_id,owner_principal_id,upload_id,chunk_index,start_offset,
     character_length,length(CAST(content AS BLOB)) AS byte_length,content_digest
     FROM project_source_upload_prepared_chunks WHERE ${sourceUploadSqliteFilter}
     ORDER BY chunk_index LIMIT 20001`,
    )
    .all(...values)
    .map((row) => {
      assertSqliteUploadScope(row, scope);
      return {
        index: row.chunk_index as number,
        startOffset: row.start_offset as number,
        characterLength: row.character_length as number,
        byteLength: row.byte_length as number,
        digest: row.content_digest as string,
      };
    });
  assertFoundationSourceAdoptionChunks(proof, chunks);
  const chapters = database
    .prepare(
      `SELECT * FROM project_source_upload_prepared_chapters WHERE ${sourceUploadSqliteFilter}
     ORDER BY start_offset LIMIT 20001`,
    )
    .all(...values)
    .map((row) => {
      assertSqliteUploadScope(row, scope);
      const chapter = sourceUploadFields(JSON.parse(String(row.record_json)), [
        "chapterId",
        "title",
        "startOffset",
        "endOffset",
      ]);
      sourceUploadSame(row.chapter_id, chapter.chapterId);
      sourceUploadSame(row.start_offset, chapter.startOffset);
      sourceUploadSame(row.end_offset, chapter.endOffset);
      return chapter as FoundationSourceAdoption["chapters"][number];
    });
  assertFoundationSourceAdoptionChapters(proof, chapters);
}

/** Insert after original project and source, before the original transaction's receipt/COMMIT. */
export function associateSqliteFoundationSource(
  database: DatabaseSync,
  proof: FoundationSourceAdoption,
): void {
  assertSqliteCreativeProjectLegacyAccess(
    database,
    foundationLegacyScope(proof.owner, proof.source.projectId),
  );
  database
    .prepare(
      `INSERT INTO project_source_upload_associations
     (tenant_id,space_id,owner_principal_id,upload_id,project_id,source_revision,source_digest,record_json)
     VALUES(?,?,?,?,?,?,?,?)`,
    )
    .run(
      ...sourceUploadSqliteValues({
        owner: proof.owner,
        uploadId: proof.pointer.uploadId,
      }),
      proof.source.projectId,
      proof.source.revision,
      proof.source.digest,
      sourceUploadJson(proof.association),
    );
}
