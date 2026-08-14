import type {
  CommitOfficeDefinitionInput,
  CommitOfficeDefinitionResult,
  OfficeDefinitionStore,
  OfficeListCursor,
  OfficeLocator,
} from "@crewon/application";
import { parseOfficeDefinition, type OfficeDefinition } from "@crewon/domain";
import type { Pool } from "pg";

export class PostgresOfficeStore implements OfficeDefinitionStore {
  readonly #pool: Pool;
  readonly #schema: string;
  constructor(pool: Pool, schema: string) {
    this.#pool = pool;
    this.#schema = schema;
  }
  async migrate() {
    await this.#pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.#schema}.office_definitions (
         tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, office_id TEXT NOT NULL,
         office_version_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
         created_at TEXT NOT NULL, definition_json JSONB NOT NULL,
         PRIMARY KEY (tenant_id, space_id, office_version_id),
         UNIQUE (tenant_id, space_id, office_id, revision)
       );
       CREATE INDEX IF NOT EXISTS office_definitions_list
         ON ${this.#schema}.office_definitions
         (tenant_id, space_id, created_at DESC, office_version_id DESC);
       CREATE TABLE IF NOT EXISTS ${this.#schema}.office_create_receipts (
         tenant_id TEXT NOT NULL, space_id TEXT NOT NULL, actor_id TEXT NOT NULL,
         idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
         office_version_id TEXT NOT NULL,
         PRIMARY KEY (tenant_id, space_id, actor_id, idempotency_key)
       );
       CREATE TABLE IF NOT EXISTS ${this.#schema}.office_delegations (
         tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
         delegation_id TEXT NOT NULL, office_id TEXT NOT NULL,
         office_version_id TEXT NOT NULL, workflow_version_id TEXT NOT NULL,
         thread_id TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL,
         delegation_json JSONB NOT NULL,
         PRIMARY KEY (tenant_id, delegation_id),
         UNIQUE (tenant_id, run_id),
         FOREIGN KEY (tenant_id, space_id, office_version_id)
           REFERENCES ${this.#schema}.office_definitions
             (tenant_id, space_id, office_version_id),
         FOREIGN KEY (tenant_id, run_id)
           REFERENCES ${this.#schema}.run_snapshots (tenant_id, run_id)
       );
       CREATE INDEX IF NOT EXISTS office_delegations_list
         ON ${this.#schema}.office_delegations
         (tenant_id, space_id, office_version_id, created_at DESC,
          delegation_id COLLATE "C" DESC);
       CREATE TABLE IF NOT EXISTS ${this.#schema}.office_delegation_receipts (
         tenant_id TEXT NOT NULL, space_id TEXT NOT NULL,
         scope TEXT NOT NULL, idempotency_key TEXT NOT NULL,
         fingerprint TEXT NOT NULL, delegation_id TEXT NOT NULL, run_id TEXT NOT NULL,
         PRIMARY KEY (scope, idempotency_key),
         UNIQUE (tenant_id, delegation_id),
         UNIQUE (tenant_id, run_id),
         FOREIGN KEY (tenant_id, delegation_id)
           REFERENCES ${this.#schema}.office_delegations (tenant_id, delegation_id),
         FOREIGN KEY (tenant_id, run_id)
           REFERENCES ${this.#schema}.run_snapshots (tenant_id, run_id)
       );`,
    );
  }
  async commitOfficeDefinition(
    input: CommitOfficeDefinitionInput,
  ): Promise<CommitOfficeDefinitionResult> {
    const value = validateCommit(input);
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `office:${value.tenantId}:${value.spaceId}:${value.officeId}`,
      ]);
      const receipt = await client.query<{
        request_digest: string;
        office_version_id: string;
      }>(
        `SELECT request_digest, office_version_id FROM ${this.#schema}.office_create_receipts WHERE tenant_id=$1 AND space_id=$2 AND actor_id=$3 AND idempotency_key=$4`,
        [
          value.tenantId,
          value.spaceId,
          input.receipt.actorId,
          input.receipt.idempotencyKey,
        ],
      );
      if (receipt.rows[0] !== undefined) {
        if (receipt.rows[0].request_digest !== input.receipt.requestDigest)
          throw new Error("office_idempotency_conflict");
        const found = await client.query<{ definition_json: OfficeDefinition }>(
          `SELECT definition_json FROM ${this.#schema}.office_definitions WHERE tenant_id=$1 AND space_id=$2 AND office_version_id=$3`,
          [value.tenantId, value.spaceId, receipt.rows[0].office_version_id],
        );
        if (found.rows[0] === undefined)
          throw new Error("office_receipt_corrupt");
        await client.query("COMMIT");
        return {
          disposition: "replayed",
          definition: parseOfficeDefinition(found.rows[0].definition_json),
        };
      }
      const latest = await client.query<{ revision: number }>(
        `SELECT revision FROM ${this.#schema}.office_definitions WHERE tenant_id=$1 AND space_id=$2 AND office_id=$3 ORDER BY revision DESC LIMIT 1`,
        [value.tenantId, value.spaceId, value.officeId],
      );
      if ((latest.rows[0]?.revision ?? 0) !== input.expectedRevision)
        throw new Error("office_revision_conflict");
      await client.query(
        `INSERT INTO ${this.#schema}.office_definitions VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          value.tenantId,
          value.spaceId,
          value.officeId,
          value.officeVersionId,
          value.revision,
          value.createdAt,
          value,
        ],
      );
      await client.query(
        `INSERT INTO ${this.#schema}.office_create_receipts VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          value.tenantId,
          value.spaceId,
          input.receipt.actorId,
          input.receipt.idempotencyKey,
          input.receipt.requestDigest,
          value.officeVersionId,
        ],
      );
      await client.query("COMMIT");
      return { disposition: "created", definition: value };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  async loadOfficeDefinition(locator: OfficeLocator) {
    const result = await this.#pool.query<{
      definition_json: OfficeDefinition;
    }>(
      `SELECT definition_json FROM ${this.#schema}.office_definitions WHERE tenant_id=$1 AND space_id=$2 AND office_version_id=$3`,
      [locator.tenantId, locator.spaceId, locator.officeVersionId],
    );
    return result.rows[0] === undefined
      ? null
      : parseOfficeDefinition(result.rows[0].definition_json);
  }
  async listOfficeDefinitions(input: {
    tenantId: string;
    spaceId: string;
    before: OfficeListCursor | null;
    limit: number;
  }) {
    const values: unknown[] = [input.tenantId, input.spaceId];
    let cursor = "";
    if (input.before !== null) {
      cursor =
        " AND (created_at < $3 OR (created_at = $3 AND office_version_id < $4))";
      values.push(input.before.createdAt, input.before.officeVersionId);
    }
    values.push(input.limit);
    const limit = `$${values.length}`;
    const result = await this.#pool.query<{
      definition_json: OfficeDefinition;
    }>(
      `SELECT definition_json FROM ${this.#schema}.office_definitions WHERE tenant_id=$1 AND space_id=$2${cursor} ORDER BY created_at DESC, office_version_id DESC LIMIT ${limit}`,
      values,
    );
    return result.rows.map((row) => parseOfficeDefinition(row.definition_json));
  }
}

function validateCommit(input: CommitOfficeDefinitionInput) {
  const value = parseOfficeDefinition(input.definition);
  if (
    value.revision !== input.expectedRevision + 1 ||
    value.createdByActorId !== input.receipt.actorId
  )
    throw new Error("office_commit_authority_mismatch");
  return value;
}
