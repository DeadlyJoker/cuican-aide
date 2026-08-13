import type { DatabaseSync } from "node:sqlite";
import type {
  CommitOfficeDefinitionInput,
  CommitOfficeDefinitionResult,
  OfficeDefinitionStore,
  OfficeListCursor,
  OfficeLocator,
} from "@crewon/application";
import { parseOfficeDefinition } from "@crewon/domain";

export function migrateSqliteOffices(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS office_definitions (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, office_id TEXT NOT NULL,
      office_version_id TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at TEXT NOT NULL, definition_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, space_id, office_version_id),
      UNIQUE (tenant_id, space_id, office_id, revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS office_definitions_list
      ON office_definitions (tenant_id, space_id, created_at DESC, office_version_id DESC);
    CREATE TABLE IF NOT EXISTS office_create_receipts (
      tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
      office_version_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, space_id, actor_id, idempotency_key)
    ) STRICT;
  `);
}

export class SqliteOfficeStore implements OfficeDefinitionStore {
  readonly #database: DatabaseSync;
  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  async commitOfficeDefinition(
    input: CommitOfficeDefinitionInput,
  ): Promise<CommitOfficeDefinitionResult> {
    const value = input.definition;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.#database
        .prepare(
          `SELECT request_digest, office_version_id FROM office_create_receipts WHERE tenant_id = ? AND space_id = ? AND actor_id = ? AND idempotency_key = ?`,
        )
        .get(
          value.tenantId,
          value.spaceId,
          input.receipt.actorId,
          input.receipt.idempotencyKey,
        ) as { request_digest: string; office_version_id: string } | undefined;
      if (receipt !== undefined) {
        if (receipt.request_digest !== input.receipt.requestDigest)
          throw new Error("office_idempotency_conflict");
        const definition = this.load(
          value.tenantId,
          value.spaceId,
          receipt.office_version_id,
        );
        if (definition === null) throw new Error("office_receipt_corrupt");
        this.#database.exec("COMMIT");
        return { disposition: "replayed", definition };
      }
      const latest = this.#database
        .prepare(
          `SELECT revision FROM office_definitions WHERE tenant_id = ? AND space_id = ? AND office_id = ? ORDER BY revision DESC LIMIT 1`,
        )
        .get(value.tenantId, value.spaceId, value.officeId) as
        | { revision: number }
        | undefined;
      if ((latest?.revision ?? 0) !== input.expectedRevision)
        throw new Error("office_revision_conflict");
      this.#database
        .prepare(
          `INSERT INTO office_definitions (tenant_id, space_id, office_id, office_version_id, revision, created_at, definition_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.tenantId,
          value.spaceId,
          value.officeId,
          value.officeVersionId,
          value.revision,
          value.createdAt,
          JSON.stringify(value),
        );
      this.#database
        .prepare(
          `INSERT INTO office_create_receipts (tenant_id, space_id, actor_id, idempotency_key, request_digest, office_version_id) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.tenantId,
          value.spaceId,
          input.receipt.actorId,
          input.receipt.idempotencyKey,
          input.receipt.requestDigest,
          value.officeVersionId,
        );
      this.#database.exec("COMMIT");
      return { disposition: "created", definition: value };
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  async loadOfficeDefinition(locator: OfficeLocator) {
    return this.load(
      locator.tenantId,
      locator.spaceId,
      locator.officeVersionId,
    );
  }
  async listOfficeDefinitions(input: {
    tenantId: string;
    spaceId: string;
    before: OfficeListCursor | null;
    limit: number;
  }) {
    const args: (string | number)[] = [input.tenantId, input.spaceId];
    let cursor = "";
    if (input.before !== null) {
      cursor =
        " AND (created_at < ? OR (created_at = ? AND office_version_id < ?))";
      args.push(
        input.before.createdAt,
        input.before.createdAt,
        input.before.officeVersionId,
      );
    }
    args.push(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT definition_json FROM office_definitions WHERE tenant_id = ? AND space_id = ?${cursor} ORDER BY created_at DESC, office_version_id DESC LIMIT ?`,
      )
      .all(...args) as { definition_json: string }[];
    return rows.map((row) =>
      parseOfficeDefinition(JSON.parse(row.definition_json)),
    );
  }
  private load(tenantId: string, spaceId: string, officeVersionId: string) {
    const row = this.#database
      .prepare(
        `SELECT definition_json FROM office_definitions WHERE tenant_id = ? AND space_id = ? AND office_version_id = ?`,
      )
      .get(tenantId, spaceId, officeVersionId) as
      | { definition_json: string }
      | undefined;
    return row === undefined
      ? null
      : parseOfficeDefinition(JSON.parse(row.definition_json));
  }
}
