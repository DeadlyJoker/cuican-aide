import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ArtifactStoreError,
  type ArtifactContent,
  type ArtifactLocator,
  type ArtifactStorePort,
  type PutArtifactInput,
  type PutArtifactResult,
  type ArtifactRetentionStore,
} from "@crewon/application";
import { parseArtifactRecord, type ArtifactRecord } from "@crewon/domain";
import { ArtifactRetentionQuery } from "./artifact-retention-query.ts";
import {
  configureArtifactRetention,
  maintainFilesystemArtifacts,
  artifactIsRetired,
} from "./artifact-retention.ts";
import {
  artifactStagingPath,
  discardArtifactStaging,
  promoteArtifactBlob,
  readBoundedArtifactBlob,
  stageArtifactBlob,
  validateArtifactDirectories,
} from "./artifact-blob-file.ts";

const FILE_MAGIC = Buffer.from("CRWARTV0", "ascii");
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = FILE_MAGIC.byteLength + IV_BYTES + AUTH_TAG_BYTES;
const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;
const ARTIFACT_ROW_COLUMNS = `
  CASE WHEN length(CAST(tenant_id AS BLOB))<=512 THEN tenant_id ELSE NULL END AS tenant_id,
  CASE WHEN length(CAST(artifact_id AS BLOB))<=512 THEN artifact_id ELSE NULL END AS artifact_id,
  CASE WHEN length(CAST(fingerprint AS BLOB))<=128 THEN fingerprint ELSE NULL END AS fingerprint,
  CASE WHEN length(CAST(record_json AS BLOB))<=16384 THEN record_json ELSE NULL END AS record_json,
  state,
  CASE WHEN length(CAST(relative_path AS BLOB))<=256 THEN relative_path ELSE NULL END AS relative_path,
  CASE WHEN length(CAST(iv_base64 AS BLOB))<=64 THEN iv_base64 ELSE NULL END AS iv_base64`;

type ArtifactRow = Readonly<{
  tenant_id: string;
  artifact_id: string;
  fingerprint: string;
  record_json: string;
  state: "writing" | "ready";
  relative_path: string;
  iv_base64: string;
}>;

export class FilesystemArtifactStore implements ArtifactStorePort {
  readonly #database: DatabaseSync;
  readonly #rootDirectory: string;
  readonly #blobDirectory: string;
  readonly #encryptionKey: Buffer;
  readonly #keyId: string;
  readonly #maxInlineBytes: number;
  #closed = false;
  #maintenance: Promise<unknown> | null = null;
  readonly #maintenanceAbort = new AbortController();
  readonly #retentionQuery = new ArtifactRetentionQuery();
  readonly retention: ArtifactRetentionStore = {
    resourceSnapshot: () => this.#retentionQuery.resourceSnapshot(),
    maintainArtifacts: async (input) => {
      this.#assertOpen();
      if (this.#maintenance !== null || !this.#retentionQuery.available)
        return {
          disposition: "deferred",
          indexed: 0,
          checked: 0,
          deleted: 0,
          deletedBytes: 0,
          recovered: 0,
          recoveredBytes: 0,
          recoveryDeferred: 0,
        };
      const work = maintainFilesystemArtifacts({
        ...input,
        policy: { ...input.policy },
        signal: AbortSignal.any([input.signal, this.#maintenanceAbort.signal]),
        database: this.#database,
        blobDirectory: this.#blobDirectory,
        relativeBlobPath,
        authorityQuery: this.#retentionQuery,
        recoverWriting: (candidate) => this.#recoverWriting(candidate),
      });
      this.#maintenance = work;
      try {
        return await work;
      } finally {
        if (this.#maintenance === work) this.#maintenance = null;
      }
    },
  };

  constructor(config: {
    rootDirectory: string;
    databasePath: string;
    encryptionKey: Uint8Array;
    keyId: string;
    maxInlineBytes?: number;
  }) {
    this.#rootDirectory = requireAbsolutePath(
      config.rootDirectory,
      "artifact_root_invalid",
    );
    const databasePath = requireAbsolutePath(
      config.databasePath,
      "artifact_database_path_invalid",
    );
    requireOpaqueId(config.keyId, "artifact_key_id_invalid");
    if (config.encryptionKey.byteLength !== 32) {
      throw new ArtifactStoreError("artifact_key_length_invalid");
    }
    this.#maxInlineBytes = config.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxInlineBytes) ||
      this.#maxInlineBytes < 1 ||
      this.#maxInlineBytes > 1024 * 1024 * 1024
    ) {
      throw new ArtifactStoreError("artifact_inline_limit_invalid");
    }
    this.#encryptionKey = Buffer.from(config.encryptionKey);
    this.#keyId = config.keyId;
    this.#blobDirectory = path.join(this.#rootDirectory, "blobs");
    mkdirSync(this.#rootDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(this.#blobDirectory, { recursive: true, mode: 0o700 });
    chmodSync(this.#rootDirectory, 0o700);
    chmodSync(this.#blobDirectory, 0o700);
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databasePath);
    try {
      configureDatabase(this.#database);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw normalizeError(error);
    }
  }

  async put(input: PutArtifactInput): Promise<PutArtifactResult> {
    this.#assertOpen();
    const record = parseArtifactRecord(input.record);
    requireIdempotencyKey(input.idempotencyKey);
    this.#validateContent(record, input.content);
    const fingerprint = artifactFingerprint(record);

    let row: ArtifactRow;
    let disposition: PutArtifactResult["disposition"];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#loadByIdempotency(
        record.tenantId,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint) {
          throw new ArtifactStoreError("artifact_idempotency_conflict");
        }
        row = existing;
        disposition = "replayed";
      } else {
        const iv = randomBytes(IV_BYTES);
        const relativePath = relativeBlobPath(
          record.tenantId,
          record.artifactId,
        );
        this.#database
          .prepare(
            `INSERT INTO artifacts (
               tenant_id,
               artifact_id,
               idempotency_key,
               fingerprint,
               record_json,
               state,
               relative_path,
               iv_base64
             ) VALUES (?, ?, ?, ?, ?, 'writing', ?, ?)`,
          )
          .run(
            record.tenantId,
            record.artifactId,
            input.idempotencyKey,
            fingerprint,
            stableJson(record),
            relativePath,
            iv.toString("base64"),
          );
        row = this.#requireByArtifactId(record.tenantId, record.artifactId);
        disposition = "created";
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw normalizeError(error);
    }

    const storedRecord = parseStoredRecord(row.record_json);
    try {
      this.#validateRow(row, storedRecord);
      if (
        artifactIsRetired(
          this.#database,
          record.tenantId,
          storedRecord.artifactId,
        )
      )
        return {
          disposition: "replayed",
          record: structuredClone(storedRecord),
        };
      if (row.state === "writing") {
        this.#finishWrite(row, storedRecord, input.content);
      } else {
        this.#validateContent(storedRecord, this.#decrypt(row, storedRecord));
      }
      return { disposition, record: structuredClone(storedRecord) };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async get(locator: ArtifactLocator): Promise<ArtifactRecord | null> {
    this.#assertOpen();
    validateLocator(locator);
    try {
      const row = this.#loadByArtifactId(locator.tenantId, locator.artifactId);
      if (row?.state !== "ready") return null;
      const record = parseStoredRecord(row.record_json);
      this.#validateRow(row, record);
      return structuredClone(record);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async read(locator: ArtifactLocator): Promise<ArtifactContent | null> {
    this.#assertOpen();
    validateLocator(locator);
    try {
      const row = this.#loadByArtifactId(locator.tenantId, locator.artifactId);
      if (row === null || row.state !== "ready") {
        return null;
      }
      if (
        artifactIsRetired(this.#database, locator.tenantId, locator.artifactId)
      )
        return null;
      const record = parseStoredRecord(row.record_json);
      const content = this.#decrypt(row, record);
      this.#validateContent(record, content);
      return { record: structuredClone(record), content };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#maintenanceAbort.abort("artifact_store_closed");
    this.#retentionQuery.close();
    try {
      await this.#maintenance;
    } catch {
      /* maintenance cannot prevent normal close */
    }
    this.#database.close();
    this.#encryptionKey.fill(0);
  }

  #finishWrite(
    row: ArtifactRow,
    record: ArtifactRecord,
    content: Uint8Array,
  ): void {
    // This separate artifact database lock owns the deterministic staging filename.
    // It is released by process death; Run/event transactions use a different database.
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#requireByArtifactId(row.tenant_id, row.artifact_id);
      if (
        current.record_json !== row.record_json ||
        current.iv_base64 !== row.iv_base64 ||
        current.fingerprint !== row.fingerprint
      )
        throw new ArtifactStoreError("artifact_metadata_invalid");
      this.#validateRow(current, record);
      if (!artifactIsRetired(this.#database, row.tenant_id, row.artifact_id)) {
        const finalPath = this.#resolveBlobPath(current.relative_path);
        if (current.state === "ready" || existsSync(finalPath)) {
          this.#validateContent(record, this.#decrypt(current, record));
          discardArtifactStaging(finalPath);
        } else {
          mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
          validateArtifactDirectories(this.#blobDirectory, finalPath);
          stageArtifactBlob(finalPath, this.#encrypt(current, record, content));
        }
        this.#markReady(current);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #markReady(row: ArtifactRow): void {
    const changed = this.#database
      .prepare(
        "UPDATE artifacts SET state = 'ready' WHERE tenant_id = ? AND artifact_id = ? AND state = 'writing'",
      )
      .run(row.tenant_id, row.artifact_id);
    if (
      (changed.changes !== 0 && changed.changes !== 1) ||
      this.#requireByArtifactId(row.tenant_id, row.artifact_id).state !==
        "ready"
    )
      throw new ArtifactStoreError("artifact_finalize_failed");
  }

  #recoverWriting(input: {
    tenantId: string;
    artifactId: string;
    maxBytes: number;
  }): boolean {
    this.#assertOpen();
    const prior = Number(
      this.#database.prepare("PRAGMA busy_timeout").get()!.timeout,
    );
    this.#database.exec("PRAGMA busy_timeout=0");
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const row = this.#requireByArtifactId(input.tenantId, input.artifactId);
      const record = parseStoredRecord(row.record_json);
      this.#validateRow(row, record);
      if (
        row.state !== "writing" ||
        record.byteLength > Math.min(input.maxBytes, this.#maxInlineBytes) ||
        artifactIsRetired(this.#database, row.tenant_id, row.artifact_id)
      ) {
        this.#database.exec("COMMIT");
        return false;
      }
      const finalPath = this.#resolveBlobPath(row.relative_path);
      const location = existsSync(finalPath) ? "final" : "staging";
      this.#validateContent(record, this.#decrypt(row, record, location));
      if (location === "staging") promoteArtifactBlob(finalPath);
      else discardArtifactStaging(finalPath);
      this.#markReady(row);
      this.#database.exec("COMMIT");
      return true;
    } catch {
      // Busy writers, incomplete ciphertext, wrong keys and missing files never authorize loss.
      // A failed metadata commit leaves a final blob that a later pass can authenticate again.
      rollback(this.#database);
      return false;
    } finally {
      this.#database.exec(`PRAGMA busy_timeout=${prior}`);
    }
  }

  #validateRow(row: ArtifactRow, record: ArtifactRecord): void {
    if (
      row.tenant_id !== record.tenantId ||
      row.artifact_id !== record.artifactId ||
      row.relative_path !==
        relativeBlobPath(record.tenantId, record.artifactId) ||
      row.fingerprint !== artifactFingerprint(record)
    )
      throw new ArtifactStoreError("artifact_metadata_invalid");
    if (typeof row.iv_base64 !== "string")
      throw new ArtifactStoreError("artifact_iv_invalid");
    parseIv(row.iv_base64);
  }

  #encrypt(
    row: ArtifactRow,
    record: ArtifactRecord,
    content: Uint8Array,
  ): Buffer {
    const iv = parseIv(row.iv_base64);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    cipher.setAAD(aad(record));
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    return Buffer.concat([FILE_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  #decrypt(
    row: ArtifactRow,
    record: ArtifactRecord,
    location: "final" | "staging" = "final",
  ): Uint8Array {
    this.#validateRow(row, record);
    if (record.byteLength > this.#maxInlineBytes)
      throw new ArtifactStoreError("artifact_inline_content_too_large");
    const finalPath = this.#resolveBlobPath(row.relative_path);
    validateArtifactDirectories(this.#blobDirectory, finalPath);
    const encrypted = readBoundedArtifactBlob(
      location === "staging" ? artifactStagingPath(finalPath) : finalPath,
      HEADER_BYTES + record.byteLength,
    );
    if (
      encrypted.byteLength < HEADER_BYTES ||
      !encrypted.subarray(0, FILE_MAGIC.byteLength).equals(FILE_MAGIC)
    ) {
      throw new ArtifactStoreError("artifact_ciphertext_invalid");
    }
    const ivStart = FILE_MAGIC.byteLength;
    const tagStart = ivStart + IV_BYTES;
    const ciphertextStart = tagStart + AUTH_TAG_BYTES;
    const iv = encrypted.subarray(ivStart, tagStart);
    if (!iv.equals(parseIv(row.iv_base64))) {
      throw new ArtifactStoreError("artifact_ciphertext_invalid");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, iv);
    decipher.setAAD(aad(record));
    decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
    try {
      return new Uint8Array(
        Buffer.concat([
          decipher.update(encrypted.subarray(ciphertextStart)),
          decipher.final(),
        ]),
      );
    } catch (error) {
      throw new ArtifactStoreError("artifact_authentication_failed", {
        cause: error,
      });
    }
  }

  #validateContent(record: ArtifactRecord, content: Uint8Array): void {
    if (content.byteLength > this.#maxInlineBytes) {
      throw new ArtifactStoreError("artifact_inline_content_too_large");
    }
    if (content.byteLength !== record.byteLength) {
      throw new ArtifactStoreError("artifact_content_size_mismatch");
    }
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== record.contentDigest) {
      throw new ArtifactStoreError("artifact_content_digest_mismatch");
    }
    if (
      record.encryption.scheme !== "aes256gcm" ||
      record.encryption.keyId !== this.#keyId
    ) {
      throw new ArtifactStoreError("artifact_encryption_key_mismatch");
    }
  }

  #loadByIdempotency(
    tenantId: string,
    idempotencyKey: string,
  ): ArtifactRow | null {
    return (
      (this.#database
        .prepare(
          `SELECT ${ARTIFACT_ROW_COLUMNS}
           FROM artifacts
           WHERE tenant_id = ? AND idempotency_key = ?`,
        )
        .get(tenantId, idempotencyKey) as ArtifactRow | undefined) ?? null
    );
  }

  #loadByArtifactId(tenantId: string, artifactId: string): ArtifactRow | null {
    return (
      (this.#database
        .prepare(
          `SELECT ${ARTIFACT_ROW_COLUMNS}
           FROM artifacts
           WHERE tenant_id = ? AND artifact_id = ?`,
        )
        .get(tenantId, artifactId) as ArtifactRow | undefined) ?? null
    );
  }

  #requireByArtifactId(tenantId: string, artifactId: string): ArtifactRow {
    const row = this.#loadByArtifactId(tenantId, artifactId);
    if (row === null) {
      throw new ArtifactStoreError("artifact_metadata_missing");
    }
    return row;
  }

  #resolveBlobPath(relativePath: string): string {
    const resolved = path.resolve(this.#blobDirectory, relativePath);
    const prefix = `${this.#blobDirectory}${path.sep}`;
    if (!resolved.startsWith(prefix)) {
      throw new ArtifactStoreError("artifact_blob_path_invalid");
    }
    return resolved;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ArtifactStoreError("artifact_store_closed");
    }
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("BEGIN IMMEDIATE");
  try {
    const registry = database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='artifact_schema'",
      )
      .get();
    const rows = registry
      ? database.prepare("SELECT singleton,version FROM artifact_schema").all()
      : [];
    if (
      registry &&
      (rows.length !== 1 ||
        rows[0]?.singleton !== 1 ||
        ![1, 2].includes(Number(rows[0]?.version)))
    )
      throw new ArtifactStoreError("artifact_schema_unsupported");
    const expected = registry
      ? rows[0]?.version === 2
        ? [
            "artifacts",
            "artifact_retention_queue",
            "artifact_retention_due",
            "artifact_maintenance",
            "artifact_enqueue_retention",
          ]
        : ["artifacts"]
      : [];
    for (const name of expected) {
      if (
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE name=?")
          .get(name) === undefined
      )
        throw new ArtifactStoreError("artifact_schema_incomplete");
    }
    if (
      !registry &&
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE name IN ('artifacts','artifact_retention_queue','artifact_maintenance') LIMIT 1",
        )
        .get()
    )
      throw new ArtifactStoreError("artifact_schema_incomplete");
    if (rows[0]?.version === 2) {
      const state = database
        .prepare(
          "SELECT singleton,indexed_tenant,indexed_artifact,indexing_complete,next_due_ms,owner FROM artifact_maintenance",
        )
        .all();
      if (state.length !== 1 || state[0]?.singleton !== 1)
        throw new ArtifactStoreError("artifact_schema_incomplete");
    }
    if (!registry || rows[0]?.version === 1) {
      database.exec(
        "DROP TABLE IF EXISTS artifact_schema; CREATE TABLE artifact_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=2)) STRICT; INSERT INTO artifact_schema VALUES (1,2);",
      );
    }
    database.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      tenant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      state TEXT NOT NULL CHECK (state IN ('writing', 'ready')),
      relative_path TEXT NOT NULL UNIQUE,
      iv_base64 TEXT NOT NULL,
      PRIMARY KEY (tenant_id, artifact_id),
      UNIQUE (tenant_id, idempotency_key)
    ) STRICT;
  `);
    configureArtifactRetention(database);
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function artifactFingerprint(record: ArtifactRecord): string {
  const semanticInput = {
    tenantId: record.tenantId,
    spaceId: record.spaceId,
    ownerActorId: record.ownerActorId,
    kind: record.kind,
    mediaType: record.mediaType,
    sensitivity: record.sensitivity,
    source: record.source,
    contentDigest: record.contentDigest,
    byteLength: record.byteLength,
    retentionKind: record.retention.kind,
  };
  return createHash("sha256").update(stableJson(semanticInput)).digest("hex");
}

function relativeBlobPath(tenantId: string, artifactId: string): string {
  const key = createHash("sha256")
    .update(tenantId)
    .update("\0")
    .update(artifactId)
    .digest("hex");
  return path.join(key.slice(0, 2), key.slice(2, 4), `${key}.artifact`);
}

function aad(record: ArtifactRecord): Buffer {
  return Buffer.from(
    stableJson({
      schemaVersion: record.schemaVersion,
      artifactId: record.artifactId,
      tenantId: record.tenantId,
      spaceId: record.spaceId,
      source: record.source,
      contentDigest: record.contentDigest,
      byteLength: record.byteLength,
      keyId: record.encryption.keyId,
    }),
    "utf8",
  );
}

function parseStoredRecord(value: string): ArtifactRecord {
  try {
    if (typeof value !== "string")
      throw new ArtifactStoreError("artifact_metadata_invalid");
    return parseArtifactRecord(JSON.parse(value));
  } catch (error) {
    throw new ArtifactStoreError("artifact_metadata_invalid", { cause: error });
  }
}

function parseIv(value: string): Buffer {
  const iv = Buffer.from(value, "base64");
  if (iv.byteLength !== IV_BYTES || iv.toString("base64") !== value) {
    throw new ArtifactStoreError("artifact_iv_invalid");
  }
  return iv;
}

function validateLocator(locator: ArtifactLocator): void {
  requireOpaqueId(locator.tenantId, "artifact_tenant_invalid");
  requireOpaqueId(locator.artifactId, "artifact_id_invalid");
}

function requireOpaqueId(
  value: unknown,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    throw new ArtifactStoreError(code);
  }
}

function requireIdempotencyKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,1023}$/u.test(value)
  ) {
    throw new ArtifactStoreError("artifact_idempotency_key_invalid");
  }
}

function requireAbsolutePath(value: unknown, code: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ArtifactStoreError(code);
  }
  return path.resolve(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the authoritative operation error when no transaction is active.
  }
}

function normalizeError(error: unknown): ArtifactStoreError {
  return error instanceof ArtifactStoreError
    ? error
    : new ArtifactStoreError("artifact_store_unavailable", { cause: error });
}
