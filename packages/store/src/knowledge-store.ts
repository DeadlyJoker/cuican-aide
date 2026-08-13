import type { DatabaseSync } from "node:sqlite";
import { parseKnowledgeRecord, type KnowledgeRecord } from "@crewon/domain";
import {
  RunStoreError,
  type CommitKnowledgeInput,
  type KnowledgeCreateResult,
  type KnowledgeListQuery,
  type KnowledgeLocator,
  type KnowledgePage,
  type KnowledgeReceiptQuery,
  type KnowledgeStore,
} from "@crewon/application";
import type { Pool } from "pg";

type Row = {
  record_json: string | KnowledgeRecord;
  result_json?: string | KnowledgeCreateResult;
  fingerprint?: string;
};

export class SqliteKnowledgeStore implements KnowledgeStore {
  readonly #database: DatabaseSync;
  readonly #assertOpen: () => void;
  constructor(database: DatabaseSync, assertOpen: () => void) {
    this.#database = database;
    this.#assertOpen = assertOpen;
  }
  async loadKnowledgeReceipt(query: KnowledgeReceiptQuery) {
    this.#assertOpen();
    return replay(
      row(
        this.#database
          .prepare(
            `SELECT fingerprint, result_json FROM knowledge_create_receipts WHERE tenant_id=? AND space_id=? AND scope=? AND idempotency_key=?`,
          )
          .get(
            query.tenantId,
            query.spaceId,
            query.idempotency.scope,
            query.idempotency.key,
          ),
      ),
      query,
      (locator) => this.loadKnowledge(locator),
    );
  }
  async commitKnowledge(
    input: CommitKnowledgeInput,
  ): Promise<KnowledgeCreateResult> {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const prior = await this.loadKnowledgeReceipt(input);
      if (prior !== null) {
        this.#database.exec("COMMIT");
        return prior;
      }
      const record = parseKnowledgeRecord(input.record);
      validateRecordScope(input, record);
      const result = { disposition: "committed", record } as const;
      this.#database
        .prepare(
          `INSERT INTO knowledge_records(tenant_id,space_id,knowledge_id,created_at,record_json) VALUES(?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          input.spaceId,
          record.knowledgeId,
          record.createdAt,
          stable(record),
        );
      this.#database
        .prepare(
          `INSERT INTO knowledge_create_receipts(tenant_id,space_id,scope,idempotency_key,fingerprint,knowledge_id,result_json) VALUES(?,?,?,?,?,?,?)`,
        )
        .run(
          input.tenantId,
          input.spaceId,
          input.idempotency.scope,
          input.idempotency.key,
          input.idempotency.requestFingerprint,
          record.knowledgeId,
          stable(result),
        );
      this.#database.exec("COMMIT");
      return clone(result);
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {}
      throw normalize(error);
    }
  }
  async loadKnowledge(
    locator: KnowledgeLocator,
  ): Promise<KnowledgeRecord | null> {
    this.#assertOpen();
    const value = row(
      this.#database
        .prepare(
          `SELECT record_json FROM knowledge_records WHERE tenant_id=? AND space_id=? AND knowledge_id=?`,
        )
        .get(locator.tenantId, locator.spaceId, locator.knowledgeId),
    );
    return value === null
      ? null
      : parseKnowledgeRecord(parse(value.record_json));
  }
  async listKnowledge(query: KnowledgeListQuery): Promise<KnowledgePage> {
    this.#assertOpen();
    validateList(query);
    const rows = this.#database
      .prepare(
        `SELECT record_json FROM knowledge_records WHERE tenant_id=? AND space_id=? AND (? IS NULL OR created_at < ? OR (created_at=? AND knowledge_id<?)) ORDER BY created_at DESC,knowledge_id DESC LIMIT ?`,
      )
      .all(
        query.tenantId,
        query.spaceId,
        query.before?.createdAt ?? null,
        query.before?.createdAt ?? null,
        query.before?.createdAt ?? null,
        query.before?.knowledgeId ?? null,
        query.limit + 1,
      ) as Row[];
    return page(
      rows.map((item) => parseKnowledgeRecord(parse(item.record_json))),
      query.limit,
    );
  }
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  readonly #pool: Pool;
  readonly #schema: string;
  readonly #assertOpen: () => void;
  constructor(pool: Pool, schema: string, assertOpen: () => void) {
    this.#pool = pool;
    this.#schema = schema;
    this.#assertOpen = assertOpen;
  }
  async loadKnowledgeReceipt(query: KnowledgeReceiptQuery) {
    this.#assertOpen();
    const found = await this.#pool.query<Row>(
      `SELECT fingerprint,result_json FROM ${this.#schema}.knowledge_create_receipts WHERE tenant_id=$1 AND space_id=$2 AND scope=$3 AND idempotency_key=$4`,
      [
        query.tenantId,
        query.spaceId,
        query.idempotency.scope,
        query.idempotency.key,
      ],
    );
    return replay(found.rows[0] ?? null, query, (locator) =>
      this.loadKnowledge(locator),
    );
  }
  async commitKnowledge(
    input: CommitKnowledgeInput,
  ): Promise<KnowledgeCreateResult> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `knowledge:${input.tenantId}:${input.spaceId}:${input.idempotency.scope}:${input.idempotency.key}`,
      ]);
      const found = await client.query<Row>(
        `SELECT fingerprint,result_json FROM ${this.#schema}.knowledge_create_receipts WHERE tenant_id=$1 AND space_id=$2 AND scope=$3 AND idempotency_key=$4`,
        [
          input.tenantId,
          input.spaceId,
          input.idempotency.scope,
          input.idempotency.key,
        ],
      );
      if (found.rows[0]) {
        const result = await replay(found.rows[0], input, async (locator) => {
          const loaded = await client.query<Row>(
            `SELECT record_json FROM ${this.#schema}.knowledge_records WHERE tenant_id=$1 AND space_id=$2 AND knowledge_id=$3`,
            [locator.tenantId, locator.spaceId, locator.knowledgeId],
          );
          return loaded.rows[0]
            ? parseKnowledgeRecord(loaded.rows[0].record_json)
            : null;
        });
        await client.query("COMMIT");
        return result!;
      }
      const record = parseKnowledgeRecord(input.record);
      validateRecordScope(input, record);
      const result = { disposition: "committed", record } as const;
      await client.query(
        `INSERT INTO ${this.#schema}.knowledge_records VALUES($1,$2,$3,$4,$5::jsonb)`,
        [
          input.tenantId,
          input.spaceId,
          record.knowledgeId,
          record.createdAt,
          stable(record),
        ],
      );
      await client.query(
        `INSERT INTO ${this.#schema}.knowledge_create_receipts VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          input.tenantId,
          input.spaceId,
          input.idempotency.scope,
          input.idempotency.key,
          input.idempotency.requestFingerprint,
          record.knowledgeId,
          stable(result),
        ],
      );
      await client.query("COMMIT");
      return clone(result);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      throw normalize(error);
    } finally {
      client.release();
    }
  }
  async loadKnowledge(
    locator: KnowledgeLocator,
  ): Promise<KnowledgeRecord | null> {
    this.#assertOpen();
    const found = await this.#pool.query<Row>(
      `SELECT record_json FROM ${this.#schema}.knowledge_records WHERE tenant_id=$1 AND space_id=$2 AND knowledge_id=$3`,
      [locator.tenantId, locator.spaceId, locator.knowledgeId],
    );
    return found.rows[0]
      ? parseKnowledgeRecord(found.rows[0].record_json)
      : null;
  }
  async listKnowledge(query: KnowledgeListQuery): Promise<KnowledgePage> {
    this.#assertOpen();
    validateList(query);
    const found = await this.#pool.query<Row>(
      `SELECT record_json FROM ${this.#schema}.knowledge_records WHERE tenant_id=$1 AND space_id=$2 AND ($3::timestamptz IS NULL OR (created_at,knowledge_id)<($3::timestamptz,$4)) ORDER BY created_at DESC,knowledge_id DESC LIMIT $5`,
      [
        query.tenantId,
        query.spaceId,
        query.before?.createdAt ?? null,
        query.before?.knowledgeId ?? "",
        query.limit + 1,
      ],
    );
    return page(
      found.rows.map((item) => parseKnowledgeRecord(item.record_json)),
      query.limit,
    );
  }
}

async function replay(
  row: Row | null,
  query: KnowledgeReceiptQuery,
  load: (locator: KnowledgeLocator) => Promise<KnowledgeRecord | null>,
): Promise<KnowledgeCreateResult | null> {
  if (row === null) return null;
  if (row.fingerprint !== query.idempotency.requestFingerprint)
    throw new RunStoreError("knowledge_idempotency_conflict");
  const result = parse(row.result_json!) as KnowledgeCreateResult;
  const record = parseKnowledgeRecord(result.record);
  const authority = await load({
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    knowledgeId: record.knowledgeId,
  });
  if (authority === null || stable(authority) !== stable(record))
    throw new RunStoreError("knowledge_receipt_corrupt");
  return { disposition: "replayed", record };
}
function page(data: readonly KnowledgeRecord[], limit: number): KnowledgePage {
  const visible = data.slice(0, limit);
  const last = visible.at(-1);
  return {
    data: clone(visible),
    next:
      data.length > limit && last
        ? { createdAt: last.createdAt, knowledgeId: last.knowledgeId }
        : null,
  };
}
function validateRecordScope(
  input: CommitKnowledgeInput,
  record: KnowledgeRecord,
): void {
  if (record.tenantId !== input.tenantId || record.spaceId !== input.spaceId)
    throw new RunStoreError("knowledge_scope_mismatch");
}
function validateList(query: KnowledgeListQuery): void {
  if (
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 100
  )
    throw new RunStoreError("knowledge_limit_invalid");
  if (query.before !== null) {
    parseKnowledgeRecord({
      ...fixture(query),
      createdAt: query.before.createdAt,
      knowledgeId: query.before.knowledgeId,
    });
  }
}
function fixture(query: KnowledgeListQuery): KnowledgeRecord {
  return {
    schemaVersion: "crewon.knowledge.v0",
    knowledgeId: "cursor",
    tenantId: query.tenantId,
    spaceId: query.spaceId,
    ownerActorId: "cursor",
    kind: "memory",
    sourceId: "cursor",
    title: "cursor",
    content: "cursor",
    contentDigest: `sha256:${"0".repeat(64)}`,
    createdAt: "2000-01-01T00:00:00.000Z",
  };
}
function row(value: unknown): Row | null {
  return value === undefined ? null : (value as Row);
}
function parse(value: string | object): any {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function stable(value: unknown): string {
  return JSON.stringify(value);
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function normalize(error: unknown): Error {
  return error instanceof Error
    ? error
    : new RunStoreError("knowledge_store_failed");
}
