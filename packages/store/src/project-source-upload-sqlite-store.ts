import {
  captureSqliteSourceUploadLegacyAccess,
  type SqliteSourceUploadLegacyAccess,
} from "./project-source-upload-legacy-access.ts";
import type { DatabaseSync } from "node:sqlite";
import {
  sourceUploadFields,
  captureSourceUploadClaim,
  assertProjectSourceUploadTransactionCurrent,
  type ProjectSourceUploadStore,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadState,
  type ProjectSourceUploadRead,
} from "@crewon/application";
import {
  creativeProjectDigest,
  creativeProjectOpaqueId,
  projectSourceScalarLength,
} from "@crewon/domain";
import {
  assertSqliteProjectSourceUploadSchema,
  migrateSqliteProjectSourceUploads,
} from "./project-source-upload-schema.ts";
import {
  assertSourceUploadActive,
  assertSourceUploadCurrent,
  sourceUploadAdvance,
  sourceUploadAssertClaim,
  sourceUploadAssertPhase,
  sourceUploadAssertRevision,
  sourceUploadAuthority,
  sourceUploadBeginIdentity,
  sourceUploadBytes,
  sourceUploadCapturePart,
  sourceUploadClaim,
  sourceUploadFailure,
  sourceUploadInitialState,
  sourceUploadJson,
  sourceUploadMutation,
  sourceUploadOwnerValues,
  sourceUploadParsed,
  sourceUploadPreparedBundle,
  sourceUploadPreparedManifest,
  sourceUploadRawSnapshot,
  sourceUploadRead,
  sourceUploadSame,
  sourceUploadSealDigest,
  sourceUploadVerifyPrepared,
} from "./project-source-upload-store-support.ts";
import {
  sqliteUploadState,
  sqliteUploadRaw,
  sqliteUploadParsed,
  sourceUploadSqliteFilter,
  sourceUploadSqliteValues,
} from "./project-source-upload-sqlite-records.ts";
import {
  admitSqliteSourceUploadInstallation,
  captureSourceUploadInstallationAdmission,
  qualifySourceUploadInstallation,
  type SourceUploadInstallationAdmission,
} from "./project-source-upload-plugin-installation.ts";

type Input<M extends keyof ProjectSourceUploadStore> =
  ProjectSourceUploadStore[M] extends (...args: infer A) => unknown
    ? A[0]
    : never;
/** Durable journal on the original host connection; construction performs no DDL. */
export class SqliteProjectSourceUploadStore
  implements ProjectSourceUploadStore
{
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  readonly #installationAdmission:
    | SourceUploadInstallationAdmission
    | undefined;
  #realmId: string | null = null;
  constructor(input: {
    database: DatabaseSync;
    assertOpen(): void;
    installationAdmission?: SourceUploadInstallationAdmission;
  }) {
    this.#database = input.database;
    this.#assertOpen = input.assertOpen;
    this.#installationAdmission = captureSourceUploadInstallationAdmission(
      input.installationAdmission,
    );
  }
  get storageRealmId(): string {
    this.#assertOpen();
    if (this.#realmId === null)
      sourceUploadFailure(
        "project_source_upload_schema_unavailable",
        "internal",
      );
    return this.#realmId;
  }
  async migrate(): Promise<void> {
    const realm = this.#transaction("write", () =>
      migrateSqliteProjectSourceUploads(this.#database),
    );
    this.#realmId = realm;
  }
  async loadBeginReceipt(
    input: Input<"loadBeginReceipt">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadBeginIdentity(input),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        null,
        ["projectSourceUpload:begin"],
        q.actor,
      );
    return this.#read(
      authority,
      (access) => this.#beginReceipt(q, access),
      true,
    );
  }
  async begin(
    input: Input<"begin">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadBeginIdentity(input, true),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        null,
        ["projectSourceUpload:begin"],
        q.actor,
      ),
      initial = q.initial!;
    sourceUploadSame(initial.owner, q.owner);
    sourceUploadSame(initial.requestDigest, q.receipt.requestDigest);
    sourceUploadSame(initial.createdByActorId, q.actor.actorId);
    return this.#write(authority, (access) => {
      const prior = this.#beginReceipt(q, access);
      if (prior) return prior;
      sourceUploadSame(initial.storageRealmId, this.storageRealmId);
      const state = sourceUploadInitialState(initial);
      this.#database
        .prepare(
          "INSERT INTO project_source_uploads(tenant_id,space_id,owner_principal_id,upload_id,idempotency_key,request_digest,file_digest,byte_length,record_json) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          ...sourceUploadSqliteValues({
            owner: q.owner,
            uploadId: initial.uploadId,
          }),
          q.receipt.idempotencyKey,
          q.receipt.requestDigest,
          initial.fileDigest,
          initial.byteLength,
          sourceUploadJson(initial),
        );
      this.#database
        .prepare(
          "INSERT INTO project_source_upload_heads(tenant_id,space_id,owner_principal_id,upload_id,revision,phase,record_json) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          ...sourceUploadSqliteValues({
            owner: q.owner,
            uploadId: initial.uploadId,
          }),
          state.revision,
          state.phase,
          sourceUploadJson(state),
        );
      this.#event(state);
      return this.#result(state);
    });
  }
  async load(input: Input<"load">, grant: ProjectSourceUploadCommitAuthority) {
    const q = sourceUploadRead(input),
      authority = sourceUploadAuthority(grant, q.owner, q.uploadId, [
        "projectSourceUpload:status",
        "projectSourceUpload:prepare",
        "projectSourceUpload:write",
        "projectSourceUpload:cancel",
        "projectSourceUpload:adopt",
      ]);
    return this.#read(authority, (access) =>
      sqliteUploadState(this.#database, q, this.storageRealmId, access),
    );
  }
  async writePart(
    input: Input<"writePart">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input, ["part", "bytes"]),
      rawPart = Object.freeze(
        sourceUploadFields(q.part, [
          "index",
          "byteOffset",
          "byteLength",
          "rawDigest",
        ]),
      ),
      bytes = sourceUploadBytes(q.bytes, 65_536);
    const authority = sourceUploadAuthority(
      grant,
      q.owner,
      q.uploadId,
      ["projectSourceUpload:write"],
      q.actor,
    );
    return this.#write(authority, (access) => {
      const state = this.#state(q, access),
        part = sourceUploadCapturePart(state, rawPart, bytes).part,
        prior = state.parts.find((item) => item.index === part.index);
      if (prior) {
        if (sourceUploadJson(prior) !== sourceUploadJson(part))
          sourceUploadFailure("project_source_upload_part_conflict");
        const payload = this.#database
          .prepare(
            `SELECT payload FROM project_source_upload_part_payloads WHERE ${sourceUploadSqliteFilter} AND part_index=?`,
          )
          .get(...sourceUploadSqliteValues(q), part.index);
        if (!payload)
          sourceUploadFailure("project_source_upload_payload_unavailable");
        const actual = sourceUploadBytes(
          payload.payload,
          65_536,
          part.byteLength,
        );
        if (actual.some((value, index) => value !== bytes[index]))
          sourceUploadFailure("project_source_upload_part_conflict");
        sourceUploadAssertPhase(state, ["receiving"]);
        return this.#result(state, "replayed");
      }
      sourceUploadAssertPhase(state, ["receiving"]);
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      this.#database
        .prepare(
          "INSERT INTO project_source_upload_parts(tenant_id,space_id,owner_principal_id,upload_id,part_index,byte_offset,byte_length,raw_digest,record_json) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          ...sourceUploadSqliteValues(q),
          part.index,
          part.byteOffset,
          part.byteLength,
          part.rawDigest,
          sourceUploadJson(part),
        );
      this.#database
        .prepare(
          "INSERT INTO project_source_upload_part_payloads(tenant_id,space_id,owner_principal_id,upload_id,part_index,payload) VALUES(?,?,?,?,?,?)",
        )
        .run(...sourceUploadSqliteValues(q), part.index, bytes);
      const next = sourceUploadAdvance(state, q.at, {
        parts: [...state.parts, part].sort((a, b) => a.index - b.index),
      });
      this.#head(state, next);
      return this.#result(next);
    });
  }
  async sealRaw(
    input: Input<"sealRaw">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        q.uploadId,
        ["projectSourceUpload:prepare"],
        q.actor,
      );
    const snapshot = await this.#read(authority, (access) => {
      const state = this.#state(q, access);
      return {
        state,
        rows:
          state.sealed === null
            ? sqliteUploadRaw(this.#database, state, access)
            : null,
      };
    });
    if (snapshot.rows !== null)
      sourceUploadRawSnapshot(snapshot.state, snapshot.rows);
    const uploadDigest = sourceUploadSealDigest(
      snapshot.state.initial,
      snapshot.state.parts,
    );
    return this.#write(authority, (access) => {
      const state = this.#state(q, access);
      if (state.sealed !== null) {
        sourceUploadAssertPhase(state, [
          "raw-sealed",
          "preparing",
          "ready",
          "rejected",
        ]);
        sourceUploadSame(state.sealed.uploadDigest, uploadDigest);
        return this.#result(state, "replayed");
      }
      sourceUploadAssertPhase(state, ["receiving"]);
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      sourceUploadSame(state.parts, snapshot.state.parts);
      sourceUploadSame(state.initial, snapshot.state.initial);
      if (snapshot.rows === null)
        sourceUploadFailure("project_source_upload_state_conflict");
      const sealed = Object.freeze({ uploadDigest, sealedAt: q.at }),
        next = sourceUploadAdvance(state, q.at, {
          phase: "raw-sealed",
          sealed,
        });
      this.#database
        .prepare(
          "INSERT INTO project_source_upload_seals(tenant_id,space_id,owner_principal_id,upload_id,upload_digest,record_json) VALUES(?,?,?,?,?,?)",
        )
        .run(
          ...sourceUploadSqliteValues(q),
          uploadDigest,
          sourceUploadJson(sealed),
        );
      this.#head(state, next);
      return this.#result(next);
    });
  }
  async claimPreparation(
    input: Input<"claimPreparation">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input, ["claim"]),
      claim = captureSourceUploadClaim(q.claim),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        q.uploadId,
        ["projectSourceUpload:prepare"],
        q.actor,
      );
    return this.#write(authority, (access) => {
      const state = this.#state(q, access);
      if (
        state.phase === "ready" ||
        (state.phase === "preparing" && state.claim!.expiresAt > q.at)
      )
        return Object.freeze({ disposition: "existing" as const, state });
      sourceUploadAssertPhase(state, ["raw-sealed", "preparing"]);
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      const next = sourceUploadAdvance(state, q.at, {
        phase: "preparing",
        claim: sourceUploadClaim(state, claim, q.at),
      });
      this.#head(state, next);
      return Object.freeze({ disposition: "claimed" as const, state: next });
    });
  }
  async loadRawBytes(
    input: Input<"loadRawBytes">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadRead(input, ["uploadDigest", "claimId"]),
      uploadDigest = creativeProjectDigest(q.uploadDigest),
      claimId = creativeProjectOpaqueId(q.claimId),
      authority = sourceUploadAuthority(grant, q.owner, q.uploadId, [
        "projectSourceUpload:prepare",
      ]);
    const snapshot = await this.#read(authority, (access) => {
      const state = this.#state(q, access);
      sourceUploadAssertClaim(state, claimId);
      sourceUploadSame(state.sealed!.uploadDigest, uploadDigest);
      return { state, rows: sqliteUploadRaw(this.#database, state, access) };
    });
    const bytes = sourceUploadRawSnapshot(snapshot.state, snapshot.rows);
    await assertSourceUploadCurrent(authority);
    return bytes;
  }
  async completePreparation(
    input: Input<"completePreparation">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input, ["claimId", "parsed"]),
      claimId = creativeProjectOpaqueId(q.claimId),
      parsed = sourceUploadParsed(q.parsed, q.actor, q.uploadId),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        q.uploadId,
        ["projectSourceUpload:prepare"],
        q.actor,
      );
    const snapshot = await this.#read(authority, (access) =>
        this.#state(q, access),
      ),
      bundle = sourceUploadPreparedBundle(snapshot, parsed, q.at);
    return this.#write(authority, (access) => {
      const state = this.#state(q, access);
      if (state.phase === "ready") {
        if (state.claim!.claimId !== claimId)
          sourceUploadFailure("project_source_upload_claim_conflict");
        const {
          pointer: _pointer,
          preparedAt: _at,
          ...metrics
        } = bundle.manifest;
        sourceUploadSame(
          sourceUploadPreparedManifest(
            state,
            metrics,
            state.prepared!.preparedAt,
          ),
          state.prepared,
        );
        return this.#result(state, "replayed");
      }
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      sourceUploadAssertClaim(state, claimId, q.at);
      sourceUploadSame(snapshot.claim, state.claim);
      sourceUploadSame(snapshot.sealed, state.sealed);
      const next = sourceUploadAdvance(state, q.at, {
        phase: "ready",
        prepared: bundle.manifest,
      });
      this.#database
        .prepare(
          "INSERT INTO project_source_upload_prepared(tenant_id,space_id,owner_principal_id,upload_id,prepared_digest,content_digest,parser_version,record_json) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          ...sourceUploadSqliteValues(q),
          bundle.manifest.pointer.preparedDigest,
          bundle.manifest.digest,
          bundle.manifest.pointer.normalizationParserVersion,
          sourceUploadJson(bundle.manifest),
        );
      const chunk = this.#database.prepare(
        "INSERT INTO project_source_upload_prepared_chunks(tenant_id,space_id,owner_principal_id,upload_id,chunk_index,start_offset,character_length,content,content_digest) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const item of bundle.source.chunks)
        chunk.run(
          ...sourceUploadSqliteValues(q),
          item.index,
          item.startOffset,
          projectSourceScalarLength(item.content),
          item.content,
          item.digest,
        );
      const chapter = this.#database.prepare(
        "INSERT INTO project_source_upload_prepared_chapters(tenant_id,space_id,owner_principal_id,upload_id,chapter_id,start_offset,end_offset,record_json) VALUES(?,?,?,?,?,?,?,?)",
      );
      for (const item of bundle.source.chapters)
        chapter.run(
          ...sourceUploadSqliteValues(q),
          item.chapterId,
          item.startOffset,
          item.endOffset,
          sourceUploadJson(item),
        );
      this.#head(state, next);
      return this.#result(next);
    });
  }
  async rejectPreparation(
    input: Input<"rejectPreparation">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input, ["claimId", "failureCode"]),
      claimId = creativeProjectOpaqueId(q.claimId),
      failureCode = creativeProjectOpaqueId(q.failureCode),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        q.uploadId,
        ["projectSourceUpload:prepare"],
        q.actor,
      );
    return this.#write(authority, (access) => {
      const state = this.#state(q, access);
      if (
        state.phase === "rejected" &&
        state.claim!.claimId === claimId &&
        state.failureCode === failureCode
      )
        return this.#result(state, "replayed");
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      sourceUploadAssertClaim(state, claimId, q.at);
      const next = sourceUploadAdvance(state, q.at, {
        phase: "rejected",
        failureCode,
      });
      this.#head(state, next);
      return this.#result(next);
    });
  }
  async cancel(
    input: Input<"cancel">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadMutation(input),
      authority = sourceUploadAuthority(
        grant,
        q.owner,
        q.uploadId,
        ["projectSourceUpload:cancel"],
        q.actor,
      );
    return this.#write(authority, (access) => {
      const state = this.#state(q, access);
      if (state.phase === "cancelled") return this.#result(state, "replayed");
      sourceUploadAssertPhase(state, ["receiving", "raw-sealed", "preparing"]);
      sourceUploadAssertRevision(state, q.expectedRevision, q.at);
      const next = sourceUploadAdvance(state, q.at, { phase: "cancelled" });
      this.#head(state, next);
      return this.#result(next);
    });
  }
  async loadPrepared(
    input: Input<"loadPrepared">,
    grant: ProjectSourceUploadCommitAuthority,
  ) {
    const q = sourceUploadRead(input, ["fileDigest"]),
      fileDigest = creativeProjectDigest(q.fileDigest),
      authority = sourceUploadAuthority(grant, q.owner, q.uploadId, [
        "projectSourceUpload:adopt",
      ]);
    const snapshot = await this.#read(authority, (access) => {
      const state = sqliteUploadState(
        this.#database,
        q,
        this.storageRealmId,
        access,
      );
      if (state === null) return null;
      if (state.initial.fileDigest !== fileDigest)
        sourceUploadFailure("project_source_upload_digest_mismatch");
      sourceUploadAssertPhase(state, ["ready"]);
      return {
        state,
        parsed: sqliteUploadParsed(this.#database, state, access),
      };
    });
    if (snapshot === null) return null;
    const prepared = sourceUploadVerifyPrepared(
      snapshot.state,
      snapshot.parsed,
    );
    await assertSourceUploadCurrent(authority);
    return prepared;
  }
  #beginReceipt(
    q: ReturnType<typeof sourceUploadBeginIdentity>,
    access: SqliteSourceUploadLegacyAccess,
  ) {
    const row = this.#database
      .prepare(
        "SELECT upload_id,request_digest FROM project_source_uploads WHERE tenant_id=? AND space_id=? AND owner_principal_id=? AND idempotency_key=?",
      )
      .get(...sourceUploadOwnerValues(q.owner), q.receipt.idempotencyKey);
    if (row === undefined) return null;
    access.assertUpload({ owner: q.owner, uploadId: String(row.upload_id) });
    if (row.request_digest !== q.receipt.requestDigest)
      sourceUploadFailure("project_source_upload_idempotency_conflict");
    return this.#result(
      this.#state({ owner: q.owner, uploadId: String(row.upload_id) }, access),
      "replayed",
    );
  }
  #state(
    q: ProjectSourceUploadRead,
    access: SqliteSourceUploadLegacyAccess,
  ): ProjectSourceUploadState {
    const state = sqliteUploadState(
      this.#database,
      q,
      this.storageRealmId,
      access,
    );
    if (state === null)
      sourceUploadFailure("project_source_upload_not_found", "notFound");
    return state;
  }
  #event(state: ProjectSourceUploadState): void {
    this.#database
      .prepare(
        "INSERT INTO project_source_upload_events(tenant_id,space_id,owner_principal_id,upload_id,head_revision,phase,record_json) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        ...sourceUploadSqliteValues({
          owner: state.initial.owner,
          uploadId: state.initial.uploadId,
        }),
        state.revision,
        state.phase,
        sourceUploadJson(state),
      );
  }
  #head(prior: ProjectSourceUploadState, next: ProjectSourceUploadState): void {
    const result = this.#database
      .prepare(
        `UPDATE project_source_upload_heads SET revision=?,phase=?,record_json=? WHERE ${sourceUploadSqliteFilter} AND revision=?`,
      )
      .run(
        next.revision,
        next.phase,
        sourceUploadJson(next),
        ...sourceUploadSqliteValues({
          owner: prior.initial.owner,
          uploadId: prior.initial.uploadId,
        }),
        prior.revision,
      );
    if (result.changes !== 1)
      sourceUploadFailure("project_source_upload_revision_conflict");
    this.#event(next);
  }
  #result(
    state: ProjectSourceUploadState,
    disposition: "committed" | "replayed" = "committed",
  ) {
    return Object.freeze({ disposition, state });
  }
  #schema(): void {
    const realm = assertSqliteProjectSourceUploadSchema(this.#database);
    if (realm === false)
      sourceUploadFailure(
        "project_source_upload_schema_unavailable",
        "internal",
      );
    if (this.#realmId !== null) sourceUploadSame(realm, this.#realmId);
    this.#realmId = realm;
  }
  async #read<T>(
    authority: ProjectSourceUploadCommitAuthority,
    work: (access: SqliteSourceUploadLegacyAccess) => T,
    mutation = false,
  ): Promise<T> {
    qualifySourceUploadInstallation(
      authority,
      this.#installationAdmission,
      mutation,
    );
    await assertSourceUploadCurrent(authority);
    await assertProjectSourceUploadTransactionCurrent(authority);
    return this.#transaction("read", () => {
      const access = captureSqliteSourceUploadLegacyAccess(this.#database);
      this.#schema();
      admitSqliteSourceUploadInstallation(
        this.#database,
        authority,
        this.#installationAdmission,
        mutation,
      );
      assertSourceUploadActive(authority);
      const result = work(access);
      access.assertCurrent();
      assertSourceUploadActive(authority);
      return result;
    });
  }
  async #write<T>(
    authority: ProjectSourceUploadCommitAuthority,
    work: (access: SqliteSourceUploadLegacyAccess) => T,
  ): Promise<T> {
    qualifySourceUploadInstallation(
      authority,
      this.#installationAdmission,
      true,
    );
    await assertSourceUploadCurrent(authority);
    await assertProjectSourceUploadTransactionCurrent(authority);
    return this.#transaction("write", () => {
      const access = captureSqliteSourceUploadLegacyAccess(this.#database);
      this.#schema();
      admitSqliteSourceUploadInstallation(
        this.#database,
        authority,
        this.#installationAdmission,
        true,
      );
      assertSourceUploadActive(authority);
      const result = work(access);
      access.assertCurrent();
      assertSourceUploadActive(authority);
      return result;
    });
  }
  #transaction<T>(kind: "read" | "write", work: () => T): T {
    this.#assertOpen();
    this.#database.exec(kind === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = work();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        /* Preserve original failure. */
      }
      throw error;
    }
  }
}
