import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  ApplicationError,
  type DeliveryScope,
  type DeliveryStorePort,
} from "@crewon/application";
import {
  DELIVERY_LIMITS,
  parseDeliveryTargetRef,
  type DeliveryInputRecord,
  type DeliveryVersionRecord,
} from "@crewon/domain";

type FileRecord = DeliveryInputRecord | DeliveryVersionRecord;
type Row = {
  record_json: string;
  record_mac: Uint8Array;
  content: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
};
const scoped = (scope: DeliveryScope) =>
  JSON.stringify([
    scope.target.tenantId,
    scope.target.spaceId,
    scope.target.threadId,
    scope.target.targetId,
    scope.ownerActorId,
  ]);
const identifier = (record: FileRecord) =>
  "inputId" in record ? record.inputId : record.versionId;
const hash = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A separate durable vault: saved inputs/versions never enter tool-output retention. */
export class SqliteDeliveryStore implements DeliveryStorePort {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #quota: number;
  constructor(config: {
    databasePath: string;
    encryptionKey: Uint8Array;
    maxStoredBytes?: number;
  }) {
    if (
      config.encryptionKey.byteLength !== 32 ||
      (config.databasePath !== ":memory:" &&
        !path.isAbsolute(config.databasePath))
    )
      throw new ApplicationError(
        "validation",
        "delivery_store_configuration_invalid",
      );
    this.#quota = config.maxStoredBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#quota) || this.#quota < 1)
      throw new ApplicationError("validation", "delivery_store_quota_invalid");
    this.#key = createHmac("sha256", config.encryptionKey)
      .update("crewon.delivery-vault.v1")
      .digest();
    if (config.databasePath !== ":memory:")
      mkdirSync(path.dirname(config.databasePath), {
        recursive: true,
        mode: 0o700,
      });
    this.#db = new DatabaseSync(config.databasePath);
    if (config.databasePath !== ":memory:")
      chmodSync(config.databasePath, 0o600);
    this.#db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
    );
    const version = Number(
      this.#db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version !== 0 && version !== 1) {
      this.#db.close();
      throw new ApplicationError("internal", "delivery_schema_unsupported");
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_files (
        scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('input','version')),
        delivery_id TEXT, record_json TEXT NOT NULL, record_mac BLOB NOT NULL,
        content BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL, byte_length INTEGER NOT NULL,
        PRIMARY KEY(scope,id)
      );
      CREATE TABLE IF NOT EXISTS delivery_heads (scope TEXT NOT NULL, delivery_id TEXT NOT NULL, version_id TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(scope,delivery_id));
      CREATE TABLE IF NOT EXISTS delivery_operations (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, file_id TEXT NOT NULL, PRIMARY KEY(scope,key));
      CREATE INDEX IF NOT EXISTS delivery_history ON delivery_files(scope,delivery_id);
      PRAGMA user_version=1;
    `);
  }
  async catalog(scope: DeliveryScope) {
    this.#validateScope(scope);
    const rows = this.#db
      .prepare(
        "SELECT record_json, record_mac FROM delivery_files WHERE scope=? AND kind='input' ORDER BY rowid",
      )
      .all(scoped(scope));
    const versions = this.#db
      .prepare(
        "SELECT f.record_json,f.record_mac FROM delivery_files f JOIN delivery_heads h ON h.scope=f.scope AND h.version_id=f.id WHERE f.scope=? ORDER BY f.rowid DESC",
      )
      .all(scoped(scope));
    return {
      target: structuredClone(scope.target),
      inputs: rows.map(
        (r) => this.#record(r as Row, scope) as DeliveryInputRecord,
      ),
      deliveries: versions.map(
        (r) => this.#record(r as Row, scope) as DeliveryVersionRecord,
      ),
    };
  }
  async history(scope: DeliveryScope, deliveryId: string) {
    this.#validateScope(scope);
    return this.#db
      .prepare(
        "SELECT record_json,record_mac FROM delivery_files WHERE scope=? AND delivery_id=? AND kind='version' ORDER BY rowid DESC",
      )
      .all(scoped(scope), deliveryId)
      .map((r) => this.#record(r as Row, scope) as DeliveryVersionRecord);
  }
  async getInput(scope: DeliveryScope, inputId: string) {
    return this.#read(scope, inputId, "input") as {
      record: DeliveryInputRecord;
      content: Uint8Array;
    } | null;
  }
  async getVersion(scope: DeliveryScope, versionId: string) {
    return this.#read(scope, versionId, "version") as {
      record: DeliveryVersionRecord;
      content: Uint8Array;
    } | null;
  }
  async findOperation(scope: DeliveryScope, key: string, fingerprint: string) {
    return this.#operation(scope, key, fingerprint);
  }
  async putInput(input: {
    scope: DeliveryScope;
    record: DeliveryInputRecord;
    content: Uint8Array;
    key: string;
    fingerprint: string;
  }) {
    return this.#transaction(() => {
      const prior = this.#operation(input.scope, input.key, input.fingerprint);
      if (prior) return this.#asKind(prior, "input") as DeliveryInputRecord;
      this.#insert(input, "input");
      return structuredClone(input.record);
    });
  }
  async commitVersion(input: {
    scope: DeliveryScope;
    record: DeliveryVersionRecord;
    content: Uint8Array;
    expected: { versionId: string; contentDigest: string } | null;
    key: string;
    fingerprint: string;
  }) {
    return this.#transaction(() => {
      const prior = this.#operation(input.scope, input.key, input.fingerprint);
      if (prior) return this.#asKind(prior, "version") as DeliveryVersionRecord;
      const head = this.#db
        .prepare(
          "SELECT version_id,digest FROM delivery_heads WHERE scope=? AND delivery_id=?",
        )
        .get(scoped(input.scope), input.record.deliveryId);
      if (
        input.expected === null
          ? head !== undefined || input.record.parentVersionId !== null
          : head?.version_id !== input.expected.versionId ||
            head?.digest !== input.expected.contentDigest ||
            input.record.parentVersionId !== input.expected.versionId
      )
        throw new ApplicationError("conflict", "delivery_version_conflict");
      this.#insert(input, "version");
      this.#db
        .prepare(
          "INSERT INTO delivery_heads VALUES (?,?,?,?) ON CONFLICT(scope,delivery_id) DO UPDATE SET version_id=excluded.version_id,digest=excluded.digest",
        )
        .run(
          scoped(input.scope),
          input.record.deliveryId,
          input.record.versionId,
          input.record.contentDigest,
        );
      return structuredClone(input.record);
    });
  }
  async close() {
    this.#db.close();
  }
  #validateScope(scope: DeliveryScope) {
    parseDeliveryTargetRef(scope.target);
    if (!scope.ownerActorId)
      throw new ApplicationError("validation", "delivery_owner_invalid");
  }
  #asKind(record: FileRecord, kind: "input" | "version") {
    if ("inputId" in record !== (kind === "input"))
      throw new ApplicationError("conflict", "delivery_idempotency_conflict");
    return record;
  }
  #operation(
    scope: DeliveryScope,
    key: string,
    fingerprint: string,
  ): FileRecord | null {
    this.#validateScope(scope);
    const op = this.#db
      .prepare(
        "SELECT fingerprint,file_id FROM delivery_operations WHERE scope=? AND key=?",
      )
      .get(scoped(scope), key);
    if (!op) return null;
    if (op.fingerprint !== fingerprint)
      throw new ApplicationError("conflict", "delivery_idempotency_conflict");
    const row = this.#db
      .prepare("SELECT * FROM delivery_files WHERE scope=? AND id=?")
      .get(scoped(scope), op.file_id as string) as Row | undefined;
    if (!row)
      throw new ApplicationError("internal", "delivery_store_incomplete");
    this.#decrypt(row, scope);
    return this.#record(row, scope);
  }
  #read(scope: DeliveryScope, id: string, kind: "input" | "version") {
    this.#validateScope(scope);
    const row = this.#db
      .prepare("SELECT * FROM delivery_files WHERE scope=? AND id=? AND kind=?")
      .get(scoped(scope), id, kind) as Row | undefined;
    return row
      ? { record: this.#record(row, scope), content: this.#decrypt(row, scope) }
      : null;
  }
  #record(row: Row, scope: DeliveryScope): FileRecord {
    const mac = createHmac("sha256", this.#key)
      .update("metadata:")
      .update(row.record_json)
      .digest();
    if (
      row.record_mac.byteLength !== mac.byteLength ||
      !timingSafeEqual(mac, row.record_mac)
    )
      throw new ApplicationError("internal", "delivery_metadata_corrupt");
    const record = JSON.parse(row.record_json) as FileRecord;
    if (
      scoped({ target: record.target, ownerActorId: record.ownerActorId }) !==
      scoped(scope)
    )
      throw new ApplicationError("internal", "delivery_scope_corrupt");
    return record;
  }
  #decrypt(row: Row, scope: DeliveryScope): Uint8Array {
    const record = this.#record(row, scope);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
      decipher.setAAD(Buffer.from(row.record_json));
      decipher.setAuthTag(Buffer.from(row.tag));
      const bytes = Buffer.concat([
        decipher.update(row.content),
        decipher.final(),
      ]);
      if (
        bytes.byteLength !== record.byteLength ||
        hash(bytes) !== record.contentDigest
      )
        throw new Error("digest");
      return new Uint8Array(bytes);
    } catch (cause) {
      throw new ApplicationError("internal", "delivery_content_corrupt", {
        cause,
      });
    }
  }
  #insert(
    input: {
      scope: DeliveryScope;
      record: FileRecord;
      content: Uint8Array;
      key: string;
      fingerprint: string;
    },
    kind: "input" | "version",
  ) {
    this.#validateScope(input.scope);
    if (
      scoped({
        target: input.record.target,
        ownerActorId: input.record.ownerActorId,
      }) !== scoped(input.scope) ||
      hash(input.content) !== input.record.contentDigest ||
      input.content.byteLength !== input.record.byteLength ||
      input.content.byteLength < 1 ||
      input.content.byteLength > DELIVERY_LIMITS.fileBytes
    )
      throw new ApplicationError("validation", "delivery_content_mismatch");
    const count = Number(
      this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM delivery_files WHERE scope=? AND kind=?",
        )
        .get(scoped(input.scope), kind)?.n,
    );
    const stored = Number(
      this.#db
        .prepare("SELECT COALESCE(SUM(byte_length),0) AS n FROM delivery_files")
        .get()?.n,
    );
    if (
      count >=
        (kind === "input"
          ? DELIVERY_LIMITS.inputs
          : DELIVERY_LIMITS.versions) ||
      stored + input.content.byteLength > this.#quota
    )
      throw new ApplicationError("validation", "delivery_storage_limit");
    const json = JSON.stringify(input.record);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(json));
    const encrypted = Buffer.concat([
      cipher.update(input.content),
      cipher.final(),
    ]);
    const values: SQLInputValue[] = [
      scoped(input.scope),
      identifier(input.record),
      kind,
      "deliveryId" in input.record ? input.record.deliveryId : null,
      json,
      createHmac("sha256", this.#key).update("metadata:").update(json).digest(),
      encrypted,
      iv,
      cipher.getAuthTag(),
      input.content.byteLength,
    ];
    this.#db
      .prepare("INSERT INTO delivery_files VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(...values);
    this.#db
      .prepare("INSERT INTO delivery_operations VALUES (?,?,?,?)")
      .run(
        scoped(input.scope),
        input.key,
        input.fingerprint,
        identifier(input.record),
      );
  }
  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
