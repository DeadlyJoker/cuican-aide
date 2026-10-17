import { DatabaseSync } from "node:sqlite";
import {
  RunStoreError,
  type WorkflowVersionAsset,
  type WorkflowVersionStore,
  type WorkflowVersionCatalogStore,
  type WorkflowVersionCatalogQuery,
  type WorkflowVersionListCursor,
} from "@crewon/application";
import {
  parseCompiledWorkflowVersion,
  MAX_WORKFLOW_DEFINITION_BYTES,
  type WorkflowContentDigester,
} from "@crewon/domain";
import type { Pool } from "pg";

import {
  migratePostgresWorkflowVersions,
  migrateSqliteWorkflowVersions,
} from "./workflow-version-schema.ts";

export class InMemoryWorkflowVersionStore
  implements WorkflowVersionStore, WorkflowVersionCatalogStore
{
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
  async listWorkflowVersionCatalog(input: WorkflowVersionCatalogQuery) {
    catalogInput(input);
    const page = [...this.#assets.values()]
      .filter(
        (asset) =>
          asset.tenantId === input.tenantId && afterCatalog(asset, input.after),
      )
      .sort(compareCatalog)
      .slice(0, input.limit);
    catalogBudget(page.map((asset) => Buffer.byteLength(asset.definitionJson)));
    return page.map((asset) => catalogEntry(asset, this.#digester));
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    return [...this.#assets.values()]
      .filter(
        (asset) =>
          asset.tenantId === input.tenantId &&
          asset.workflowId === input.workflowId,
      )
      .sort((a, b) => compareUtf8(a.workflowVersionId, b.workflowVersionId))
      .filter(
        (asset) =>
          input.after === null ||
          compareUtf8(asset.workflowVersionId, input.after.workflowVersionId) >
            0,
      )
      .slice(0, input.limit)
      .map((asset) => structuredClone(asset));
  }
}

export class SqliteWorkflowVersionStore
  implements WorkflowVersionStore, WorkflowVersionCatalogStore
{
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
    const stored = await this.loadWorkflowVersion({
      tenantId: asset.tenantId,
      workflowVersionId: asset.workflowVersionId,
    });
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
    try {
      const row = this.#database
        .prepare(
          `SELECT * FROM workflow_versions WHERE tenant_id=? AND workflow_version_id=?`,
        )
        .get(input.tenantId, input.workflowVersionId) as Row | undefined;
      return row ? decode(row, this.#digester) : null;
    } catch (error) {
      throw corruption(error);
    }
  }
  async listWorkflowVersionCatalog(input: WorkflowVersionCatalogQuery) {
    catalogInput(input);
    const rows = this.#database
      .prepare(
        `WITH page AS MATERIALIZED (
      SELECT tenant_id,workflow_version_id FROM workflow_versions WHERE tenant_id=? AND
      (? IS NULL OR (CAST(workflow_id AS BLOB),CAST(workflow_version_id AS BLOB))>(CAST(? AS BLOB),CAST(? AS BLOB)))
      ORDER BY CAST(workflow_id AS BLOB),CAST(workflow_version_id AS BLOB) LIMIT ?
    ), bounded AS (SELECT v.*,SUM(length(CAST(v.definition_json AS BLOB))) OVER () AS page_bytes FROM workflow_versions v JOIN page p USING(tenant_id,workflow_version_id))
    SELECT tenant_id,workflow_id,workflow_version_id,content_digest,created_at,
      CASE WHEN page_bytes<=? AND length(CAST(definition_json AS BLOB))<=? THEN definition_json ELSE NULL END AS definition_json
    FROM bounded ORDER BY CAST(workflow_id AS BLOB),CAST(workflow_version_id AS BLOB)`,
      )
      .all(
        input.tenantId,
        input.after?.workflowId ?? null,
        input.after?.workflowId ?? null,
        input.after?.workflowVersionId ?? null,
        input.limit,
        CATALOG_DEFINITION_BYTES,
        MAX_WORKFLOW_DEFINITION_BYTES,
      ) as unknown as Row[];
    return catalogEntries(rows, this.#digester);
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    const rows = this.#database
      .prepare(
        `SELECT * FROM workflow_versions WHERE tenant_id=? AND workflow_id=?
      AND CAST(workflow_version_id AS BLOB)>CAST(? AS BLOB)
      ORDER BY CAST(workflow_version_id AS BLOB) LIMIT ?`,
      )
      .all(
        input.tenantId,
        input.workflowId,
        input.after?.workflowVersionId ?? "",
        input.limit,
      ) as unknown as Row[];
    try {
      return rows.map((row) => decode(row, this.#digester));
    } catch (error) {
      throw corruption(error);
    }
  }
}

export class PostgresWorkflowVersionStore
  implements WorkflowVersionStore, WorkflowVersionCatalogStore
{
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
    const stored = await this.loadWorkflowVersion({
      tenantId: asset.tenantId,
      workflowVersionId: asset.workflowVersionId,
    });
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
    try {
      return result.rows[0] ? decode(result.rows[0], this.#digester) : null;
    } catch (error) {
      throw corruption(error);
    }
  }
  async listWorkflowVersionCatalog(input: WorkflowVersionCatalogQuery) {
    catalogInput(input);
    const result = await this.#pool.query<Row>(
      `WITH page AS MATERIALIZED (
      SELECT tenant_id,workflow_version_id FROM ${this.#schema}.workflow_versions WHERE tenant_id=$1 AND
      ($2::text IS NULL OR (workflow_id COLLATE "C",workflow_version_id COLLATE "C")>($2 COLLATE "C",$3 COLLATE "C"))
      ORDER BY workflow_id COLLATE "C",workflow_version_id COLLATE "C" LIMIT $4
    ), bounded AS (SELECT v.*,SUM(octet_length(v.definition_json)) OVER () AS page_bytes FROM ${this.#schema}.workflow_versions v JOIN page p USING(tenant_id,workflow_version_id))
    SELECT tenant_id,workflow_id,workflow_version_id,content_digest,created_at::text,
      CASE WHEN page_bytes<=$5 AND octet_length(definition_json)<=$6 THEN definition_json ELSE NULL END AS definition_json
    FROM bounded ORDER BY workflow_id COLLATE "C",workflow_version_id COLLATE "C"`,
      [
        input.tenantId,
        input.after?.workflowId ?? null,
        input.after?.workflowVersionId ?? null,
        input.limit,
        CATALOG_DEFINITION_BYTES,
        MAX_WORKFLOW_DEFINITION_BYTES,
      ],
    );
    return catalogEntries(result.rows, this.#digester);
  }
  async listWorkflowVersions(input: ListInput) {
    listInput(input);
    const result = await this.#pool.query<Row>(
      `SELECT tenant_id, workflow_id, workflow_version_id, content_digest,
      definition_json, created_at::text FROM ${this.#schema}.workflow_versions WHERE tenant_id=$1 AND workflow_id=$2
      AND workflow_version_id COLLATE "C">$3 COLLATE "C"
      ORDER BY workflow_version_id COLLATE "C" LIMIT $4`,
      [
        input.tenantId,
        input.workflowId,
        input.after?.workflowVersionId ?? "",
        input.limit,
      ],
    );
    try {
      return result.rows.map((row) => decode(row, this.#digester));
    } catch (error) {
      throw corruption(error);
    }
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
  const asset = rowAsset(row);
  validateAsset(asset, digester);
  return asset;
}
function rowAsset(row: Row): WorkflowVersionAsset {
  return {
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    contentDigest: row.content_digest,
    definitionJson: row.definition_json,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function validateAsset(
  asset: WorkflowVersionAsset,
  digester: WorkflowContentDigester,
) {
  if (
    !isPlainObject(asset) ||
    !hasExactKeys(asset, [
      "contentDigest",
      "createdAt",
      "definitionJson",
      "schemaVersion",
      "tenantId",
      "workflowId",
      "workflowVersionId",
    ]) ||
    asset.schemaVersion !== "crewon.workflow-version-asset.v0"
  )
    throw new RunStoreError("workflow_version_asset_invalid");
  boundedId(asset.tenantId, "workflow_version_tenant_invalid");
  boundedId(asset.workflowId, "workflow_id_invalid");
  boundedId(asset.workflowVersionId, "workflow_version_id_invalid");
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(asset.contentDigest) ||
    !canonicalUtc(asset.createdAt) ||
    typeof asset.definitionJson !== "string"
  )
    throw new RunStoreError("workflow_version_asset_invalid");
  let compiled;
  try {
    compiled = parseCompiledWorkflowVersion(asset.definitionJson, digester);
  } catch (error) {
    throw new RunStoreError("workflow_version_definition_invalid", {
      cause: error,
    });
  }
  if (
    compiled.workflowId !== asset.workflowId ||
    compiled.workflowVersionId !== asset.workflowVersionId ||
    compiled.contentDigest !== asset.contentDigest
  )
    throw new RunStoreError("workflow_version_authority_mismatch");
  return compiled;
}
function locator(input: { tenantId: string; workflowVersionId: string }) {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["tenantId", "workflowVersionId"])
  )
    throw new RunStoreError("workflow_version_locator_invalid");
  boundedId(input.tenantId, "workflow_version_locator_invalid");
  boundedId(input.workflowVersionId, "workflow_version_locator_invalid");
}
function listInput(input: ListInput) {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["after", "limit", "tenantId", "workflowId"]) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== null && input.after.workflowId !== input.workflowId)
  )
    throw new RunStoreError("workflow_version_list_invalid");
  boundedId(input.tenantId, "workflow_version_list_invalid");
  boundedId(input.workflowId, "workflow_version_list_invalid");
  if (input.after !== null) {
    if (
      !isPlainObject(input.after) ||
      !hasExactKeys(input.after, ["workflowId", "workflowVersionId"])
    )
      throw new RunStoreError("workflow_version_cursor_invalid");
    boundedId(input.after.workflowId, "workflow_version_cursor_invalid");
    boundedId(input.after.workflowVersionId, "workflow_version_cursor_invalid");
  }
}
function compareUtf8(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
function boundedId(value: unknown, code: string) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    throw new RunStoreError(code);
}
function canonicalUtc(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function hasExactKeys(value: object, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}
function corruption(error: unknown) {
  return error instanceof RunStoreError &&
    error.code === "workflow_version_store_corrupt"
    ? error
    : new RunStoreError("workflow_version_store_corrupt", {
        cause: error instanceof Error ? error : undefined,
      });
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

const CATALOG_DEFINITION_BYTES = 8 * 1024 * 1024;
function catalogBudget(sizes: number[]) {
  if (
    sizes.some((size) => size > MAX_WORKFLOW_DEFINITION_BYTES) ||
    sizes.reduce((total, size) => total + size, 0) > CATALOG_DEFINITION_BYTES
  )
    throw new RunStoreError("workflow_version_catalog_limit");
}
function catalogEntries(rows: Row[], digester: WorkflowContentDigester) {
  if (rows.some((row) => typeof row.definition_json !== "string"))
    throw new RunStoreError("workflow_version_catalog_limit");
  catalogBudget(rows.map((row) => Buffer.byteLength(row.definition_json)));
  try {
    return rows.map((row) => catalogEntry(rowAsset(row), digester));
  } catch (error) {
    throw corruption(error);
  }
}
function catalogEntry(
  asset: WorkflowVersionAsset,
  digester: WorkflowContentDigester,
) {
  const workflow = validateAsset(asset, digester);
  return {
    workflowId: asset.workflowId,
    workflowVersionId: asset.workflowVersionId,
    contentDigest: asset.contentDigest,
    name: workflow.name,
    description: workflow.description,
    createdAt: asset.createdAt,
  };
}
function compareCatalog(
  left: WorkflowVersionAsset,
  right: WorkflowVersionListCursor,
) {
  return (
    compareUtf8(left.workflowId, right.workflowId) ||
    compareUtf8(left.workflowVersionId, right.workflowVersionId)
  );
}
function afterCatalog(
  asset: WorkflowVersionAsset,
  cursor: WorkflowVersionListCursor | null,
) {
  return cursor === null || compareCatalog(asset, cursor) > 0;
}
function catalogInput(input: WorkflowVersionCatalogQuery) {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["tenantId", "after", "limit"]) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 20
  )
    throw new RunStoreError("workflow_version_catalog_query_invalid");
  boundedId(input.tenantId, "workflow_version_catalog_query_invalid");
  if (input.after !== null) {
    if (
      !isPlainObject(input.after) ||
      !hasExactKeys(input.after, ["workflowId", "workflowVersionId"])
    )
      throw new RunStoreError("workflow_version_cursor_invalid");
    boundedId(input.after.workflowId, "workflow_version_cursor_invalid");
    boundedId(input.after.workflowVersionId, "workflow_version_cursor_invalid");
  }
}
