import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowVersionAsset,
  type WorkflowVersionStore,
} from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { Pool, PoolClient } from "pg";

export const WORKFLOW_VERSION_SCHEMA_VERSION = 1;

export class InMemoryWorkflowVersionStore implements WorkflowVersionStore {
  readonly #assets = new Map<string, WorkflowVersionAsset>();
  readonly #digester: WorkflowContentDigester;
  constructor(digester: WorkflowContentDigester) {
    this.#digester = digester;
  }
  async registerWorkflowVersion(asset: WorkflowVersionAsset) {
    validateAsset(asset, this.#digester);
    const existing = this.#assets.get(key(asset));
    if (existing) return replay(existing, asset);
    this.#assets.set(key(asset), structuredClone(asset));
    return {
      disposition: "registered" as const,
      asset: structuredClone(asset),
    };
  }
  async loadWorkflowVersion(input: {
    tenantId: string;
    workflowVersionId: string;
  }) {
    locator(input);
    const asset = this.#assets.get(key(input));
    return asset ? structuredClone(asset) : null;
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    return [...this.#assets.values()]
      .filter(
        (asset) =>
          asset.tenantId === input.tenantId &&
          asset.workflowId === input.workflowId,
      )
      .sort((a, b) => a.workflowVersionId.localeCompare(b.workflowVersionId))
      .filter(
        (asset) =>
          input.after === null ||
          asset.workflowVersionId > input.after.workflowVersionId,
      )
      .slice(0, input.limit)
      .map((asset) => structuredClone(asset));
  }
}

export class SqliteWorkflowVersionStore implements WorkflowVersionStore {
  readonly #database: DatabaseSync;
  readonly #digester: WorkflowContentDigester;
  constructor(database: DatabaseSync, digester: WorkflowContentDigester) {
    this.#database = database;
    this.#digester = digester;
    migrateSqliteWorkflowVersions(database);
  }
  async registerWorkflowVersion(asset: WorkflowVersionAsset) {
    validateAsset(asset, this.#digester);
    const inserted = this.#database
      .prepare(
        `INSERT INTO workflow_versions VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        asset.tenantId,
        asset.workflowId,
        asset.workflowVersionId,
        asset.contentDigest,
        asset.definitionJson,
        asset.createdAt,
      );
    const stored = await this.loadWorkflowVersion(asset);
    if (!stored) throw new RunStoreError("workflow_version_store_failed");
    if (inserted.changes === 1)
      return { disposition: "registered" as const, asset: stored };
    return replay(stored, asset);
  }
  async loadWorkflowVersion(input: {
    tenantId: string;
    workflowVersionId: string;
  }) {
    locator(input);
    const row = this.#database
      .prepare(
        `SELECT * FROM workflow_versions WHERE tenant_id=? AND workflow_version_id=?`,
      )
      .get(input.tenantId, input.workflowVersionId) as Row | undefined;
    return row ? decode(row, this.#digester) : null;
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_versions WHERE tenant_id=? AND workflow_id=?
      AND workflow_version_id>? ORDER BY workflow_version_id LIMIT ?`,
      )
      .all(
        input.tenantId,
        input.workflowId,
        input.after?.workflowVersionId ?? "",
        input.limit,
      ) as unknown as Row[];
    return rows.map((row) => decode(row, this.#digester));
  }
}

export class PostgresWorkflowVersionStore implements WorkflowVersionStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #digester: WorkflowContentDigester;
  constructor(pool: Pool, schema: string, digester: WorkflowContentDigester) {
    this.#pool = pool;
    this.#schema = schema;
    this.#digester = digester;
    if (!/^[a-z_][a-z0-9_]*$/u.test(schema))
      throw new RunStoreError("postgres_schema_invalid");
  }
  async migrate() {
    const client = await this.#pool.connect();
    try {
      await migratePostgresWorkflowVersions(client, this.#schema);
    } finally {
      client.release();
    }
  }
  async registerWorkflowVersion(asset: WorkflowVersionAsset) {
    validateAsset(asset, this.#digester);
    const inserted = await this.#pool.query(
      `INSERT INTO ${this.#schema}.workflow_versions VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        asset.tenantId,
        asset.workflowId,
        asset.workflowVersionId,
        asset.contentDigest,
        asset.definitionJson,
        asset.createdAt,
      ],
    );
    const stored = await this.loadWorkflowVersion(asset);
    if (!stored) throw new RunStoreError("workflow_version_store_failed");
    if (inserted.rowCount === 1)
      return { disposition: "registered" as const, asset: stored };
    return replay(stored, asset);
  }
  async loadWorkflowVersion(input: {
    tenantId: string;
    workflowVersionId: string;
  }) {
    locator(input);
    const result = await this.#pool.query<Row>(
      `SELECT tenant_id, workflow_id, workflow_version_id, content_digest,
      definition_json, created_at::text FROM ${this.#schema}.workflow_versions WHERE tenant_id=$1 AND workflow_version_id=$2`,
      [input.tenantId, input.workflowVersionId],
    );
    return result.rows[0] ? decode(result.rows[0], this.#digester) : null;
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    const result = await this.#pool.query<Row>(
      `SELECT tenant_id, workflow_id, workflow_version_id, content_digest,
      definition_json, created_at::text FROM ${this.#schema}.workflow_versions WHERE tenant_id=$1 AND workflow_id=$2
      AND workflow_version_id>$3 ORDER BY workflow_version_id LIMIT $4`,
      [
        input.tenantId,
        input.workflowId,
        input.after?.workflowVersionId ?? "",
        input.limit,
      ],
    );
    return result.rows.map((row) => decode(row, this.#digester));
  }
}

export function migrateSqliteWorkflowVersions(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS workflow_version_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
    INSERT INTO workflow_version_schema VALUES(1,1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS workflow_versions (tenant_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
      workflow_version_id TEXT NOT NULL, content_digest TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
      created_at TEXT NOT NULL, PRIMARY KEY(tenant_id, workflow_version_id)) STRICT;`);
  const row = database
    .prepare("SELECT version FROM workflow_version_schema WHERE singleton=1")
    .get() as { version: number } | undefined;
  if (row?.version !== WORKFLOW_VERSION_SCHEMA_VERSION)
    throw new RunStoreError("workflow_version_schema_unsupported");
}

export async function migratePostgresWorkflowVersions(
  client: PoolClient,
  schema: string,
) {
  await client.query("BEGIN");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.workflow_version_schema
      (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL);
      INSERT INTO ${schema}.workflow_version_schema(singleton,version) VALUES(true,1) ON CONFLICT DO NOTHING`);
    const result = await client.query<{ version: number }>(
      `SELECT version FROM ${schema}.workflow_version_schema WHERE singleton=true FOR UPDATE`,
    );
    if (result.rows[0]?.version !== WORKFLOW_VERSION_SCHEMA_VERSION)
      throw new RunStoreError("workflow_version_schema_unsupported");
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.workflow_versions (tenant_id text NOT NULL, workflow_id text NOT NULL,
      workflow_version_id text NOT NULL, content_digest text NOT NULL, definition_json text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY(tenant_id, workflow_version_id))`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type ListInput = Parameters<WorkflowVersionStore["listWorkflowVersions"]>[0];
type Row = {
  tenant_id: string;
  workflow_id: string;
  workflow_version_id: string;
  content_digest: string;
  definition_json: string;
  created_at: string;
};
function decode(
  row: Row,
  digester: WorkflowContentDigester,
): WorkflowVersionAsset {
  const asset: WorkflowVersionAsset = {
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    contentDigest: row.content_digest,
    definitionJson: row.definition_json,
    createdAt: new Date(row.created_at).toISOString(),
  };
  validateAsset(asset, digester);
  return asset;
}
function validateAsset(
  asset: WorkflowVersionAsset,
  digester: WorkflowContentDigester,
) {
  const compiled = parseCompiledWorkflowVersion(asset.definitionJson, digester);
  if (
    compiled.workflowId !== asset.workflowId ||
    compiled.workflowVersionId !== asset.workflowVersionId ||
    compiled.contentDigest !== asset.contentDigest
  )
    throw new RunStoreError("workflow_version_authority_mismatch");
  if (!asset.tenantId || Number.isNaN(Date.parse(asset.createdAt)))
    throw new RunStoreError("workflow_version_asset_invalid");
}
function locator(input: { tenantId: string; workflowVersionId: string }) {
  if (!input.tenantId || !input.workflowVersionId)
    throw new RunStoreError("workflow_version_locator_invalid");
}
function listInput(input: ListInput) {
  if (
    !input.tenantId ||
    !input.workflowId ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== null && input.after.workflowId !== input.workflowId)
  )
    throw new RunStoreError("workflow_version_list_invalid");
}
function key(input: { tenantId: string; workflowVersionId: string }) {
  return `${input.tenantId}\0${input.workflowVersionId}`;
}
function replay(
  existing: WorkflowVersionAsset,
  requested: WorkflowVersionAsset,
) {
  if (
    existing.workflowId !== requested.workflowId ||
    existing.contentDigest !== requested.contentDigest ||
    existing.definitionJson !== requested.definitionJson
  )
    throw new RunStoreError("workflow_version_id_conflict");
  return { disposition: "existing" as const, asset: structuredClone(existing) };
}
