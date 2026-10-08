import type { Pool } from "pg";
import {
  captureSourceUploadClaim,
  sourceUploadFields,
  type ProjectSourceUploadCommitAuthority,
  type ProjectSourceUploadMutationResult,
  type ProjectSourceUploadPreparedSource,
  type ProjectSourceUploadState,
  type ProjectSourceUploadStore,
} from "@crewon/application";
import { creativeProjectDigest, creativeProjectOpaqueId } from "@crewon/domain";
import {
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
  assertPostgresUploadScope,
  decodePostgresUploadChunk,
  decodePostgresUploadChapter,
} from "./project-source-upload-postgres-records.ts";
import {
  ProjectSourceUploadPostgresQueries,
  uploadPostgresOwnerValues as values,
} from "./project-source-upload-postgres-queries.ts";

type Method = Exclude<keyof ProjectSourceUploadStore, "storageRealmId">;
type Input<K extends Method> = Parameters<ProjectSourceUploadStore[K]>[0];
type Authority = ProjectSourceUploadCommitAuthority;
const ownerKey = "tenant_id,space_id,owner_principal_id,upload_id";
const whereOwner =
  "tenant_id=$1 AND space_id=$2 AND owner_principal_id=$3 AND upload_id=$4";
const readActions = [
  "projectSourceUpload:status",
  "projectSourceUpload:write",
  "projectSourceUpload:prepare",
  "projectSourceUpload:cancel",
  "projectSourceUpload:adopt",
] as const;

/** Explicit opt-in, borrowed original pool/schema; no parser or full-byte hash owns a write connection. */
export class PostgresProjectSourceUploadStore
  implements ProjectSourceUploadStore
{
  readonly #io: ProjectSourceUploadPostgresQueries;
  constructor(input: { pool: Pool; schema: string; assertOpen(): void }) {
    this.#io = new ProjectSourceUploadPostgresQueries(input);
  }
  get storageRealmId(): string {
    return this.#io.storageRealmId;
  }
  async migrate(): Promise<void> {
    await this.#io.migrate();
  }

  async loadBeginReceipt(
    input: Input<"loadBeginReceipt">,
    supplied: Authority,
  ) {
    const identity = sourceUploadBeginIdentity(input);
    const authority = sourceUploadAuthority(
      supplied,
      identity.owner,
      null,
      ["projectSourceUpload:begin"],
      identity.actor,
    );
    return this.#io.read(async (client) => {
      const row = await this.#io.beginReceipt(client, identity);
      if (row === undefined) return null;
      this.#io.assertReceipt(row, identity);
      return result(
        await this.#io.requireState(client, {
          owner: identity.owner,
          uploadId: String(row.upload_id),
        }),
        "replayed",
      );
    }, authority);
  }
  async begin(input: Input<"begin">, supplied: Authority) {
    const identity = sourceUploadBeginIdentity(input, true),
      initial = identity.initial!;
    const authority = sourceUploadAuthority(
      supplied,
      identity.owner,
      null,
      ["projectSourceUpload:begin"],
      identity.actor,
    );
    sourceUploadSame(initial.owner, identity.owner);
    sourceUploadSame(initial.requestDigest, identity.receipt.requestDigest);
    sourceUploadSame(initial.createdByActorId, identity.actor.actorId);
    const state = sourceUploadInitialState(initial);
    return this.#io.transaction(async (client) => {
      await this.#io.requireSchema(client);
      sourceUploadSame(initial.storageRealmId, this.#io.storageRealmId);
      await this.#io.lock(client, [
        "project-source-upload-begin",
        this.#io.prefix,
        ...sourceUploadOwnerValues(identity.owner),
        identity.receipt.idempotencyKey,
      ]);
      const prior = await this.#io.beginReceipt(client, identity);
      if (prior !== undefined) {
        this.#io.assertReceipt(prior, identity);
        const scope = {
          owner: identity.owner,
          uploadId: String(prior.upload_id),
        };
        await this.#io.uploadLock(client, scope);
        const actual = await this.#io.requireState(client, scope);
        for (const field of [
          "fileName",
          "format",
          "byteLength",
          "fileDigest",
          "partBytes",
          "partCount",
        ] as const)
          sourceUploadSame(actual.initial[field], initial[field]);
        return result(actual, "replayed");
      }
      const scope = { owner: identity.owner, uploadId: initial.uploadId };
      await this.#io.uploadLock(client, scope);
      if (await this.#io.state(client, scope))
        sourceUploadFailure("project_source_upload_id_conflict");
      await this.#io.query(
        client,
        `INSERT INTO ${this.#io.prefix}project_source_uploads (${ownerKey},idempotency_key,request_digest,file_digest,byte_length,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ...values(scope),
          identity.receipt.idempotencyKey,
          identity.receipt.requestDigest,
          initial.fileDigest,
          initial.byteLength,
          sourceUploadJson(initial),
        ],
      );
      await this.#io.query(
        client,
        `INSERT INTO ${this.#io.prefix}project_source_upload_heads (${ownerKey},revision,phase,record_json) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          ...values(scope),
          state.revision,
          state.phase,
          sourceUploadJson(state),
        ],
      );
      await this.#io.event(client, state);
      return result(state, "committed");
    }, authority);
  }
  async load(input: Input<"load">, supplied: Authority) {
    const scope = sourceUploadRead(input);
    const authority = sourceUploadAuthority(
      supplied,
      scope.owner,
      scope.uploadId,
      readActions,
    );
    return this.#io.read((client) => this.#io.state(client, scope), authority);
  }

  async writePart(input: Input<"writePart">, supplied: Authority) {
    const command = sourceUploadMutation(input, ["part", "bytes"]);
    const rawPart = Object.freeze(
      sourceUploadFields(command.part, [
        "index",
        "byteOffset",
        "byteLength",
        "rawDigest",
      ]),
    );
    const rawBytes = sourceUploadBytes(command.bytes, 65_536);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:write"],
      command.actor,
    );
    const snapshot = await this.#io.read(
      (client) => this.#io.requireState(client, command),
      authority,
    );
    const captured = sourceUploadCapturePart(snapshot, rawPart, rawBytes);
    return this.#io.change(command, authority, async (client, state) => {
      const prior = state.parts.find(
        (part) => part.index === captured.part.index,
      );
      if (prior !== undefined) {
        if (sourceUploadJson(prior) !== sourceUploadJson(captured.part))
          sourceUploadFailure("project_source_upload_part_conflict");
        const rows = await this.#io.query(
          client,
          `SELECT * FROM ${this.#io.prefix}project_source_upload_part_payloads WHERE ${whereOwner} AND part_index=$5`,
          [...values(command), prior.index],
        );
        if (rows.rows.length !== 1)
          sourceUploadFailure("project_source_upload_payload_unavailable");
        assertPostgresUploadScope(rows.rows[0]!, command);
        const bytes = sourceUploadBytes(
          rows.rows[0]!.payload,
          65_536,
          prior.byteLength,
        );
        if (!Buffer.from(bytes).equals(Buffer.from(captured.bytes)))
          sourceUploadFailure("project_source_upload_part_conflict");
        sourceUploadAssertPhase(state, ["receiving"]);
        return result(state, "replayed");
      }
      sourceUploadAssertPhase(state, ["receiving"]);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      await this.#io.query(
        client,
        `INSERT INTO ${this.#io.prefix}project_source_upload_parts (${ownerKey},part_index,byte_offset,byte_length,raw_digest,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ...values(command),
          captured.part.index,
          captured.part.byteOffset,
          captured.part.byteLength,
          captured.part.rawDigest,
          sourceUploadJson(captured.part),
        ],
      );
      await this.#io.query(
        client,
        `INSERT INTO ${this.#io.prefix}project_source_upload_part_payloads (${ownerKey},part_index,payload) VALUES($1,$2,$3,$4,$5,$6)`,
        [...values(command), captured.part.index, Buffer.from(captured.bytes)],
      );
      const next = sourceUploadAdvance(state, command.at, {
        parts: [...state.parts, captured.part].sort(
          (a, b) => a.index - b.index,
        ),
      });
      await this.#io.head(client, state, next);
      return result(next, "committed");
    });
  }
  async sealRaw(input: Input<"sealRaw">, supplied: Authority) {
    const command = sourceUploadMutation(input);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:prepare"],
      command.actor,
    );
    const snapshot = await this.#io.read(async (client) => {
      const state = await this.#io.requireState(client, command);
      return {
        state,
        raw:
          state.sealed === null ? await this.#io.rawRows(client, state) : null,
      };
    }, authority);
    if (snapshot.raw !== null)
      sourceUploadRawSnapshot(snapshot.state, snapshot.raw);
    const uploadDigest = sourceUploadSealDigest(
      snapshot.state.initial,
      snapshot.state.parts,
    );
    return this.#io.change(command, authority, async (client, state) => {
      if (state.sealed !== null) return result(state, "replayed");
      sourceUploadAssertPhase(state, ["receiving"]);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      sourceUploadSame(state, snapshot.state);
      const sealed = Object.freeze({ uploadDigest, sealedAt: command.at });
      await this.#io.query(
        client,
        `INSERT INTO ${this.#io.prefix}project_source_upload_seals (${ownerKey},upload_digest,record_json) VALUES($1,$2,$3,$4,$5,$6)`,
        [...values(command), uploadDigest, sourceUploadJson(sealed)],
      );
      const next = sourceUploadAdvance(state, command.at, {
        phase: "raw-sealed",
        sealed,
      });
      await this.#io.head(client, state, next);
      return result(next, "committed");
    });
  }
  async claimPreparation(
    input: Input<"claimPreparation">,
    supplied: Authority,
  ) {
    const command = sourceUploadMutation(input, ["claim"]);
    const capturedClaim = captureSourceUploadClaim(command.claim);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:prepare"],
      command.actor,
    );
    return this.#io.change(command, authority, async (client, state) => {
      if (
        state.phase === "ready" ||
        (state.phase === "preparing" && state.claim!.expiresAt > command.at)
      )
        return Object.freeze({ disposition: "existing" as const, state });
      sourceUploadAssertPhase(state, ["raw-sealed", "preparing"]);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      const claim = sourceUploadClaim(state, capturedClaim, command.at);
      if (state.claim !== null && state.claim.claimId === claim.claimId)
        sourceUploadFailure("project_source_upload_claim_conflict");
      const next = sourceUploadAdvance(state, command.at, {
        phase: "preparing",
        claim,
      });
      await this.#io.head(client, state, next);
      return Object.freeze({ disposition: "claimed" as const, state: next });
    });
  }
  async loadRawBytes(input: Input<"loadRawBytes">, supplied: Authority) {
    const scope = sourceUploadRead(input, ["uploadDigest", "claimId"]);
    const uploadDigest = creativeProjectDigest(scope.uploadDigest),
      claimId = creativeProjectOpaqueId(scope.claimId);
    const authority = sourceUploadAuthority(
      supplied,
      scope.owner,
      scope.uploadId,
      ["projectSourceUpload:prepare"],
    );
    const snapshot = await this.#io.read(async (client) => {
      const state = await this.#io.requireState(client, scope);
      sourceUploadAssertClaim(state, claimId);
      if (state.sealed!.uploadDigest !== uploadDigest)
        sourceUploadFailure(
          "project_source_upload_ledger_mismatch",
          "internal",
        );
      return { state, raw: await this.#io.rawRows(client, state) };
    }, authority);
    const bytes = sourceUploadRawSnapshot(snapshot.state, snapshot.raw);
    await assertSourceUploadCurrent(authority);
    return bytes;
  }
  async completePreparation(
    input: Input<"completePreparation">,
    supplied: Authority,
  ) {
    const command = sourceUploadMutation(input, ["claimId", "parsed"]);
    const parsed = sourceUploadParsed(
      command.parsed,
      command.actor,
      command.uploadId,
    );
    const claimId = creativeProjectOpaqueId(command.claimId);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:prepare"],
      command.actor,
    );
    const snapshot = await this.#io.read(
      (client) => this.#io.requireState(client, command),
      authority,
    );
    if (snapshot.claim?.claimId !== claimId)
      sourceUploadFailure("project_source_upload_claim_conflict");
    sourceUploadAssertPhase(snapshot, ["preparing", "ready"]);
    const bundle = sourceUploadPreparedBundle(
      snapshot,
      parsed,
      snapshot.prepared?.preparedAt ?? command.at,
    );
    return this.#io.change(command, authority, async (client, state) => {
      if (state.claim?.claimId !== claimId)
        sourceUploadFailure("project_source_upload_claim_conflict");
      if (state.phase === "ready") {
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
        return result(state, "replayed");
      }
      sourceUploadAssertClaim(state, claimId, command.at);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      sourceUploadSame(state, snapshot);
      await this.#io.prepared(client, command, bundle);
      const next = sourceUploadAdvance(state, command.at, {
        phase: "ready",
        prepared: bundle.manifest,
      });
      await this.#io.head(client, state, next);
      return result(next, "committed");
    });
  }
  async rejectPreparation(
    input: Input<"rejectPreparation">,
    supplied: Authority,
  ) {
    const command = sourceUploadMutation(input, ["claimId", "failureCode"]);
    const claimId = creativeProjectOpaqueId(command.claimId),
      failureCode = creativeProjectOpaqueId(command.failureCode);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:prepare"],
      command.actor,
    );
    return this.#io.change(command, authority, async (client, state) => {
      if (
        state.phase === "rejected" &&
        state.claim?.claimId === claimId &&
        state.failureCode === failureCode
      )
        return result(state, "replayed");
      sourceUploadAssertClaim(state, claimId, command.at);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      const next = sourceUploadAdvance(state, command.at, {
        phase: "rejected",
        failureCode,
      });
      await this.#io.head(client, state, next);
      return result(next, "committed");
    });
  }
  async cancel(input: Input<"cancel">, supplied: Authority) {
    const command = sourceUploadMutation(input);
    const authority = sourceUploadAuthority(
      supplied,
      command.owner,
      command.uploadId,
      ["projectSourceUpload:cancel"],
      command.actor,
    );
    return this.#io.change(command, authority, async (client, state) => {
      if (state.phase === "cancelled") return result(state, "replayed");
      sourceUploadAssertPhase(state, ["receiving", "raw-sealed", "preparing"]);
      sourceUploadAssertRevision(state, command.expectedRevision, command.at);
      const next = sourceUploadAdvance(state, command.at, {
        phase: "cancelled",
      });
      await this.#io.head(client, state, next);
      return result(next, "committed");
    });
  }
  async loadPrepared(
    input: Input<"loadPrepared">,
    supplied: Authority,
  ): Promise<ProjectSourceUploadPreparedSource | null> {
    const scope = sourceUploadRead(input, ["fileDigest"]),
      fileDigest = creativeProjectDigest(scope.fileDigest);
    const authority = sourceUploadAuthority(
      supplied,
      scope.owner,
      scope.uploadId,
      ["projectSourceUpload:adopt"],
    );
    const snapshot = await this.#io.read(async (client) => {
      const state = await this.#io.state(client, scope);
      if (state === null) return null;
      if (state.initial.fileDigest !== fileDigest)
        sourceUploadFailure("project_source_upload_digest_mismatch");
      if (state.phase !== "ready") return null;
      const chunks = (
        await this.#io.query(
          client,
          `SELECT * FROM ${this.#io.prefix}project_source_upload_prepared_chunks WHERE ${whereOwner} ORDER BY chunk_index LIMIT 20001`,
          values(scope),
        )
      ).rows.map((row) => decodePostgresUploadChunk(row, scope));
      const chapters = (
        await this.#io.query(
          client,
          `SELECT * FROM ${this.#io.prefix}project_source_upload_prepared_chapters WHERE ${whereOwner} ORDER BY start_offset LIMIT 20001`,
          values(scope),
        )
      ).rows.map((row) => decodePostgresUploadChapter(row, scope));
      return {
        state,
        parsed: {
          fileName: state.initial.fileName,
          format: state.initial.format,
          byteLength: state.initial.byteLength,
          fileDigest,
          digest: state.prepared!.digest,
          characterLength: state.prepared!.characterLength,
          chunks,
          chapters,
        },
      };
    }, authority);
    if (snapshot === null) return null;
    const source = sourceUploadVerifyPrepared(snapshot.state, snapshot.parsed);
    await assertSourceUploadCurrent(authority);
    return source;
  }
}
function result(
  state: ProjectSourceUploadState,
  disposition: ProjectSourceUploadMutationResult["disposition"],
): ProjectSourceUploadMutationResult {
  return Object.freeze({ disposition, state });
}
