import {
  assertPostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import { foundationLegacyScope } from "./project-foundation-legacy-scope.ts";
import type { PoolClient } from "pg";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { foundationFailure } from "./project-foundation-store-support.ts";
import {
  assertFoundationSourceAdoptionState,
  assertFoundationSourceAdoptionChunks,
  assertFoundationSourceAdoptionChapters,
  type FoundationSourceAdoption,
} from "./project-foundation-source-adoption.ts";
import { assertPostgresProjectSourceUploadSchema } from "./project-source-upload-schema.ts";
import {
  assertPostgresUploadScope,
  decodePostgresUploadChapter,
  decodePostgresUploadState,
  uploadPostgresNumber,
  type UploadPostgresRow,
} from "./project-source-upload-postgres-records.ts";
import {
  sourceUploadJson,
  sourceUploadOwnerValues,
} from "./project-source-upload-store-support.ts";

const ownerColumns = "tenant_id,space_id,owner_principal_id,upload_id";
const whereOwner =
  "tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND upload_id=$4";
type Transaction = Readonly<{
  client: PoolClient;
  schema: string;
  assertOpen(): void;
}>;

/** Borrow the already-open original project transaction. No pool, parser, raw payload or full-book hash. */
export async function assertPostgresFoundationSourceAdoption(
  transaction: Transaction,
  proof: FoundationSourceAdoption,
): Promise<void> {
  await lockPostgresCreativeProjectLegacySchema(
    transaction.client,
    transaction.schema,
  );
  await assertPostgresCreativeProjectLegacyAccess(
    transaction.client,
    transaction.schema,
    foundationLegacyScope(proof.owner, proof.source.projectId),
  );
  const prefix = `${creativeProjectSchemaName(transaction.schema)}.`;
  const scope = { owner: proof.owner, uploadId: proof.pointer.uploadId };
  const values = [...sourceUploadOwnerValues(scope.owner), scope.uploadId];
  // Exact namespace and tuple used by UploadQueries.change, including the raw schema name.
  await query(
    transaction,
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [JSON.stringify(["project-source-upload", transaction.schema, ...values])],
  );
  transaction.assertOpen();
  const realm = await assertPostgresProjectSourceUploadSchema(
    transaction.client,
    transaction.schema,
  );
  transaction.assertOpen();
  if (realm === false)
    foundationFailure("project_foundation_source_upload_schema_unavailable");
  const rows = (table: string, suffix = "", extras: readonly unknown[] = []) =>
    query(
      transaction,
      `SELECT * FROM ${prefix}${table} WHERE ${whereOwner}${suffix}`,
      [...values, ...extras],
    );
  const initial = (await rows("project_source_uploads")).rows[0];
  if (initial === undefined) {
    assertFoundationSourceAdoptionState(proof, null);
    return;
  }
  const head = (await rows("project_source_upload_heads")).rows[0];
  if (head === undefined)
    foundationFailure("project_foundation_source_upload_ledger_mismatch");
  const parts = (
    await rows("project_source_upload_parts", " ORDER BY part_index LIMIT 307")
  ).rows;
  const seal = (await rows("project_source_upload_seals")).rows[0];
  const prepared = (await rows("project_source_upload_prepared")).rows[0];
  const event = (
    await rows(
      "project_source_upload_events",
      " ORDER BY head_revision DESC LIMIT 1",
    )
  ).rows[0];
  const state = decodePostgresUploadState({
    scope,
    storageRealmId: realm,
    initial,
    head,
    parts,
    seal,
    prepared,
    event,
  });
  assertFoundationSourceAdoptionState(proof, state);
  const chunks = (
    await query(
      transaction,
      `SELECT ${ownerColumns},chunk_index,start_offset,character_length,octet_length(content) AS byte_length,content_digest
       FROM ${prefix}project_source_upload_prepared_chunks WHERE ${whereOwner}
       ORDER BY chunk_index LIMIT $5`,
      [...values, proof.chunks.length + 1],
    )
  ).rows.map((row) => {
    assertPostgresUploadScope(row, scope);
    return Object.freeze({
      index: uploadPostgresNumber(row.chunk_index),
      startOffset: uploadPostgresNumber(row.start_offset),
      characterLength: uploadPostgresNumber(row.character_length, 1),
      byteLength: uploadPostgresNumber(row.byte_length, 1),
      digest: row.content_digest as string,
    });
  });
  assertFoundationSourceAdoptionChunks(proof, chunks);
  const chapters = (
    await rows(
      "project_source_upload_prepared_chapters",
      " ORDER BY start_offset LIMIT $5",
      [proof.chapters.length + 1],
    )
  ).rows.map((row) => decodePostgresUploadChapter(row, scope));
  assertFoundationSourceAdoptionChapters(proof, chapters);
}

/** Called only after the matching original project/source was inserted, in this same transaction. */
export async function insertPostgresFoundationSourceAssociation(
  transaction: Transaction,
  proof: FoundationSourceAdoption,
): Promise<void> {
  await lockPostgresCreativeProjectLegacySchema(
    transaction.client,
    transaction.schema,
  );
  await assertPostgresCreativeProjectLegacyAccess(
    transaction.client,
    transaction.schema,
    foundationLegacyScope(proof.owner, proof.source.projectId),
  );
  const prefix = `${creativeProjectSchemaName(transaction.schema)}.`;
  await query(
    transaction,
    `INSERT INTO ${prefix}project_source_upload_associations
     (${ownerColumns},project_id,source_revision,source_digest,record_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ...sourceUploadOwnerValues(proof.owner),
      proof.pointer.uploadId,
      proof.source.projectId,
      proof.source.revision,
      proof.source.digest,
      sourceUploadJson(proof.association),
    ],
  );
}

async function query(
  transaction: Transaction,
  sql: string,
  values: readonly unknown[] = [],
) {
  transaction.assertOpen();
  const result = await transaction.client.query<UploadPostgresRow>(sql, [
    ...values,
  ]);
  transaction.assertOpen();
  return result;
}
