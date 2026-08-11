import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import {
  validateWorkspaceOperationRecord,
  type WorkspaceDeliverySettlementResult,
  type WorkspaceOperationRecord,
} from "@crewon/application";

import { POSTGRES_WORKSPACE_OPERATION_SCHEMA_VERSION } from "./postgres-workspace-operation-schema.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { PostgresThreadStore } from "./postgres-thread-store.ts";
import {
  prepareInput,
  receiptQuery,
  registerWorkspaceOperationStoreConformance,
  seedWorkspaceThread,
} from "./workspace-operation-store-conformance.test-support.ts";
import { workspaceOperationResultDigest } from "./workspace-operation-store-support.ts";

export class TestPostgresDomainStore extends PostgresDomainStore {
  readonly admin: Pool;
  readonly schemaName: string;
  readonly quotedSchema: string;
  readonly #ownsSchema: boolean;
  #closed = false;

  constructor(url: string, schema: string, ownsSchema = true) {
    super({
      connectionString: url,
      schema,
      maxPoolSize: 3,
      statementTimeoutMs: 2_000,
    });
    this.admin = new Pool({ connectionString: url, max: 3 });
    this.schemaName = schema;
    this.quotedSchema = `"${schema}"`;
    this.#ownsSchema = ownsSchema;
  }

  override async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await super.close();
    try {
      if (this.#ownsSchema) {
        await this.admin.query(
          `DROP SCHEMA IF EXISTS ${this.quotedSchema} CASCADE`,
        );
      }
    } finally {
      await this.admin.end();
    }
  }
}

export async function createTestStore(
  url: string,
): Promise<TestPostgresDomainStore> {
  const schema = `crewon_workspace_${randomUUID().replaceAll("-", "_")}`;
  const store = new TestPostgresDomainStore(url, schema);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

export function receiptLockKey(schema: string): string {
  const query = receiptQuery("execute");
  return [
    "workspace-operation-receipt",
    schema,
    query.tenantId,
    query.spaceId,
    query.phase,
    query.idempotency.scope,
    query.idempotency.key,
  ].join(":");
}

export function unknownWorkspaceRevision(
  prepared: WorkspaceOperationRecord,
  revision: number,
): WorkspaceOperationRecord {
  return validateWorkspaceOperationRecord({
    ...prepared,
    revision,
    status: "unknownOutcome",
    resolution: {
      status: "unknownOutcome",
      executionId: prepared.executionId,
      actionDigest: prepared.command.actionDigest,
      commandDigest: prepared.command.commandDigest,
      providerReceiptId: null,
    },
  });
}

export function workspaceOperationLocator(operation: WorkspaceOperationRecord) {
  return {
    tenantId: operation.tenantId,
    spaceId: operation.spaceId,
    threadId: operation.threadId,
    executionId: operation.executionId,
  };
}

export async function waitForAdvisoryWaiter(
  pool: Pool,
  classid: string,
  objid: string,
  expected = 1,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory' AND granted = false
         AND classid = $1::oid AND objid = $2::oid`,
      [classid, objid],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("workspace_receipt_lock_waiter_timeout");
}

export async function waitForRelationWaiters(
  pool: Pool,
  relation: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_locks
       WHERE relation = $1::regclass AND granted = false`,
      [relation],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("workspace_relation_lock_waiter_timeout");
}

export async function waitForTransactionWaiters(
  pool: Pool,
  transactionId: string,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM pg_locks
       WHERE locktype = 'transactionid' AND granted = false
         AND transactionid = $1::xid`,
      [transactionId],
    );
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("workspace_transaction_lock_waiter_timeout");
}

export function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: string }).code === code;
}
