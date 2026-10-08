import type { Pool, PoolClient } from "pg";
import type {
  ProjectSourceUploadCommitAuthority,
  ProjectSourceUploadRead,
  ProjectSourceUploadState,
} from "@crewon/application";
import { projectSourceScalarLength } from "@crewon/domain";
import { creativeProjectSchemaName } from "./creative-project-schema.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import {
  assertPostgresProjectSourceUploadSchema,
  migratePostgresProjectSourceUploads,
} from "./project-source-upload-schema.ts";
import {
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  sourceUploadBytes,
  sourceUploadFailure,
  sourceUploadJson,
  sourceUploadMutation,
  sourceUploadOwnerValues,
  sourceUploadPreparedManifest,
  sourceUploadSame,
  sourceUploadSealDigest,
  sourceUploadBeginIdentity,
  type SourceUploadPreparedBundle,
} from "./project-source-upload-store-support.ts";
import {
  assertPostgresUploadScope,
  decodePostgresUploadChapter,
  decodePostgresUploadChunk,
  decodePostgresUploadState,
  uploadPostgresNumber,
  type UploadPostgresRow,
} from "./project-source-upload-postgres-records.ts";

type Authority = ProjectSourceUploadCommitAuthority;
type Scope = ProjectSourceUploadRead;
type Mutation = ReturnType<typeof sourceUploadMutation>;
const ownerKey = "tenant_id,space_id,owner_principal_id,upload_id";
const whereOwner =
  "tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND upload_id=$4";

/** SQL and connection lifecycle only; the public Store prepares actual byte proofs outside this module. */
export class ProjectSourceUploadPostgresQueries {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #prefix: string;
  readonly #assertOpen: () => void;
  #realm: string | undefined;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#pool = input.pool;
    this.#schema = input.schema;
    this.#prefix = `${creativeProjectSchemaName(input.schema)}.`;
    this.#assertOpen = input.assertOpen;
  }
  get prefix(): string {
    return this.#prefix;
  }
  get storageRealmId(): string {
    this.#assertOpen();
    if (this.#realm === undefined)
      sourceUploadFailure(
        "project_source_upload_schema_unavailable",
        "internal",
      );
    return this.#realm;
  }
  async migrate(): Promise<void> {
    const realm = await this.transaction((client) =>
      migratePostgresProjectSourceUploads(client, this.#schema),
    );
    this.cacheRealm(realm);
  }
  async state(
    client: PoolClient,
    scope: Scope,
  ): Promise<ProjectSourceUploadState | null> {
    const initial = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_uploads WHERE ${whereOwner}`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows[0];
    if (initial === undefined) return null;
    const head = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_heads WHERE ${whereOwner}`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows[0];
    if (head === undefined)
      sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
    const parts = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_parts WHERE ${whereOwner} ORDER BY part_index LIMIT 307`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows;
    const seal = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_seals WHERE ${whereOwner}`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows[0];
    const prepared = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_prepared WHERE ${whereOwner}`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows[0];
    const event = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_events WHERE ${whereOwner} AND head_revision=$5`,
        [
          ...uploadPostgresOwnerValues(scope),
          uploadPostgresNumber(head.revision, 1),
        ],
      )
    ).rows[0];
    const state = decodePostgresUploadState({
      scope,
      storageRealmId: this.#realm!,
      initial,
      head,
      parts,
      seal,
      prepared,
      event,
    });
    if (
      state.sealed !== null &&
      sourceUploadSealDigest(state.initial, state.parts) !==
        state.sealed.uploadDigest
    )
      sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
    if (state.prepared !== null) {
      const { pointer: _pointer, preparedAt, ...metrics } = state.prepared;
      sourceUploadSame(
        sourceUploadPreparedManifest(state, metrics, preparedAt),
        state.prepared,
      );
    }
    return state;
  }
  async requireState(client: PoolClient, scope: Scope) {
    const state = await this.state(client, scope);
    if (state === null)
      sourceUploadFailure("project_source_upload_not_found", "notFound");
    return state;
  }
  async rawRows(client: PoolClient, state: ProjectSourceUploadState) {
    const scope = {
      owner: state.initial.owner,
      uploadId: state.initial.uploadId,
    };
    const rows = (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_upload_part_payloads WHERE ${whereOwner} ORDER BY part_index LIMIT 307`,
        uploadPostgresOwnerValues(scope),
      )
    ).rows;
    if (rows.length !== state.parts.length)
      sourceUploadFailure("project_source_upload_payload_unavailable");
    return rows.map((row, index) => {
      assertPostgresUploadScope(row, scope);
      const part = state.parts[index]!;
      if (uploadPostgresNumber(row.part_index) !== part.index)
        sourceUploadFailure(
          "project_source_upload_ledger_mismatch",
          "internal",
        );
      return {
        part,
        bytes: sourceUploadBytes(row.payload, 65_536, part.byteLength),
      };
    });
  }
  async prepared(
    client: PoolClient,
    scope: Scope,
    bundle: SourceUploadPreparedBundle,
  ) {
    const manifest = bundle.manifest;
    await this.query(
      client,
      `INSERT INTO ${this.#prefix}project_source_upload_prepared (${ownerKey},prepared_digest,content_digest,parser_version,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        ...uploadPostgresOwnerValues(scope),
        manifest.pointer.preparedDigest,
        manifest.digest,
        manifest.pointer.normalizationParserVersion,
        sourceUploadJson(manifest),
      ],
    );
    await this.insertRows(
      client,
      "project_source_upload_prepared_chunks",
      `${ownerKey},chunk_index,start_offset,character_length,content,content_digest`,
      bundle.source.chunks.map((chunk) => [
        ...uploadPostgresOwnerValues(scope),
        chunk.index,
        chunk.startOffset,
        projectSourceScalarLength(chunk.content),
        chunk.content,
        chunk.digest,
      ]),
    );
    await this.insertRows(
      client,
      "project_source_upload_prepared_chapters",
      `${ownerKey},chapter_id,start_offset,end_offset,record_json`,
      bundle.source.chapters.map((chapter) => [
        ...uploadPostgresOwnerValues(scope),
        chapter.chapterId,
        chapter.startOffset,
        chapter.endOffset,
        sourceUploadJson(chapter),
      ]),
    );
  }
  async insertRows(
    client: PoolClient,
    table: string,
    columns: string,
    rows: readonly (readonly unknown[])[],
  ) {
    const width = columns.split(",").length;
    for (let offset = 0; offset < rows.length; offset += 128) {
      const batch = rows.slice(offset, offset + 128);
      const tuples = batch
        .map(
          (_, i) =>
            `(${Array.from({ length: width }, (_, j) => `$${i * width + j + 1}`).join(",")})`,
        )
        .join(",");
      await this.query(
        client,
        `INSERT INTO ${this.#prefix}${table} (${columns}) VALUES ${tuples}`,
        batch.flat(),
      );
    }
  }
  async head(
    client: PoolClient,
    previous: ProjectSourceUploadState,
    next: ProjectSourceUploadState,
  ) {
    const scope = {
      owner: previous.initial.owner,
      uploadId: previous.initial.uploadId,
    };
    const updated = await this.query(
      client,
      `UPDATE ${this.#prefix}project_source_upload_heads SET revision=$5,phase=$6,record_json=$7 WHERE ${whereOwner} AND revision=$8`,
      [
        ...uploadPostgresOwnerValues(scope),
        next.revision,
        next.phase,
        sourceUploadJson(next),
        previous.revision,
      ],
    );
    if (updated.rowCount !== 1)
      sourceUploadFailure("project_source_upload_revision_conflict");
    await this.event(client, next);
  }
  async event(client: PoolClient, state: ProjectSourceUploadState) {
    await this.query(
      client,
      `INSERT INTO ${this.#prefix}project_source_upload_events (${ownerKey},head_revision,phase,record_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        ...uploadPostgresOwnerValues({
          owner: state.initial.owner,
          uploadId: state.initial.uploadId,
        }),
        state.revision,
        state.phase,
        sourceUploadJson(state),
      ],
    );
  }
  async beginReceipt(
    client: PoolClient,
    identity: ReturnType<typeof sourceUploadBeginIdentity>,
  ) {
    return (
      await this.query(
        client,
        `SELECT * FROM ${this.#prefix}project_source_uploads WHERE tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND idempotency_key=$4`,
        [
          ...sourceUploadOwnerValues(identity.owner),
          identity.receipt.idempotencyKey,
        ],
      )
    ).rows[0];
  }
  assertReceipt(
    row: UploadPostgresRow,
    identity: ReturnType<typeof sourceUploadBeginIdentity>,
  ) {
    if (row.request_digest !== identity.receipt.requestDigest)
      sourceUploadFailure("project_source_upload_idempotency_conflict");
    if (
      row.tenant_id !== identity.owner.tenantId ||
      row.space_id !== identity.owner.spaceId ||
      row.owner_principal_id !== identity.owner.principalId ||
      row.idempotency_key !== identity.receipt.idempotencyKey ||
      typeof row.upload_id !== "string"
    )
      sourceUploadFailure("project_source_upload_ledger_mismatch", "internal");
  }
  async change<T>(
    command: Mutation,
    authority: Authority,
    body: (client: PoolClient, state: ProjectSourceUploadState) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (client) => {
      await this.requireSchema(client);
      await this.uploadLock(client, command);
      return body(client, await this.requireState(client, command));
    }, authority);
  }
  async uploadLock(client: PoolClient, scope: Scope) {
    await this.lock(client, [
      "project-source-upload",
      this.#schema,
      ...uploadPostgresOwnerValues(scope),
    ]);
  }
  async lock(client: PoolClient, key: readonly unknown[]) {
    await this.query(
      client,
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify(key)],
    );
  }
  cacheRealm(realm: string) {
    if (this.#realm !== undefined && this.#realm !== realm)
      sourceUploadFailure("project_source_upload_realm_mismatch", "internal");
    this.#realm = realm;
  }
  async configured(client: PoolClient) {
    this.#assertOpen();
    const realm = await assertPostgresProjectSourceUploadSchema(
      client,
      this.#schema,
    );
    this.#assertOpen();
    if (realm === false) return false;
    this.cacheRealm(realm);
    return true;
  }
  async requireSchema(client: PoolClient) {
    if (!(await this.configured(client)))
      sourceUploadFailure(
        "project_source_upload_schema_unavailable",
        "internal",
      );
  }
  async query(
    client: PoolClient,
    sql: string,
    parameters: readonly unknown[] = [],
  ) {
    this.#assertOpen();
    const rows = await client.query<UploadPostgresRow>(sql, [...parameters]);
    this.#assertOpen();
    return rows;
  }
  async read<T>(
    body: (client: PoolClient) => Promise<T>,
    authority: Authority,
  ): Promise<T> {
    this.#assertOpen();
    await assertSourceUploadCurrent(authority);
    const client = await this.#pool.connect();
    try {
      await this.query(
        client,
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      await this.requireSchema(client);
      const value = await body(client);
      assertSourceUploadActive(authority);
      this.#assertOpen();
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
  async transaction<T>(
    body: (client: PoolClient) => Promise<T>,
    authority?: Authority,
  ): Promise<T> {
    this.#assertOpen();
    if (authority !== undefined) await assertSourceUploadCurrent(authority);
    const client = await this.#pool.connect();
    try {
      await this.query(client, "BEGIN");
      const result = await body(client);
      if (authority !== undefined) assertSourceUploadActive(authority);
      this.#assertOpen();
      // Only pre-COMMIT checks: a confirmed durable result remains a success after withdrawal.
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackPostgres(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
export function uploadPostgresOwnerValues(scope: Scope) {
  return [...sourceUploadOwnerValues(scope.owner), scope.uploadId];
}
