import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  automationApplicationService,
  automationCreateCommand,
} from "./automation-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { SQLITE_SCHEMA_VERSION, readUserVersion } from "./sqlite-schema.ts";
import { commitThreadRollbackFixture } from "./thread-rollback-store-conformance.test-support.ts";
import {
  prepareInput,
  receiptQuery,
  seedWorkspaceThread,
} from "./workspace-operation-store-conformance.test-support.ts";

test("SQLite v21 to v23 preserves rollback, Provider, and Automation authority", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-v23-"));
  const path = join(directory, "authority.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(path);
  const rollback = await commitThreadRollbackFixture(store);
  const thread = await store.loadThread({
    tenantId: "tenant-1",
    threadId: "thread-1",
  });
  assert.ok(thread !== null);
  const automationCommand = {
    ...automationCreateCommand(),
    expectedThreadRevision: thread.revision,
  };
  const automation = await automationApplicationService(store).createAutomation(
    {
      principalId: "principal-1",
      actorId: "actor-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
    },
    automationCommand,
  );
  const standardBefore = await store.listMessages(
    { tenantId: "tenant-1", threadId: "thread-1" },
    0,
    100,
  );
  const auditBefore = await store.listMessages(
    { tenantId: "tenant-1", threadId: "thread-1" },
    0,
    100,
    "audit",
  );
  await store.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("PRAGMA foreign_keys = OFF");
  legacy
    .prepare(
      `INSERT INTO model_provider_settings (
         tenant_id, revision, active_provider_id, catalog_json, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      "provider-preservation-tenant",
      1,
      null,
      JSON.stringify({ preserved: true }),
      "2026-08-10T00:00:00.000Z",
    );
  const providerBefore = legacy
    .prepare(
      `SELECT tenant_id, revision, active_provider_id, catalog_json, updated_at
       FROM model_provider_settings
       WHERE tenant_id = 'provider-preservation-tenant'`,
    )
    .get();
  legacy.exec(`
    DROP TABLE workspace_operation_receipts;
    DROP TABLE workspace_delivery_attempts;
    DROP TABLE workspace_operation_revisions;
    DROP TABLE workspace_operations;
    PRAGMA user_version = 21;
  `);
  legacy.close();

  const migrated = new SqliteRunStore(path);
  try {
    const versionDatabase = new DatabaseSync(path);
    try {
      assert.equal(readUserVersion(versionDatabase), SQLITE_SCHEMA_VERSION);
    } finally {
      versionDatabase.close();
    }
    assert.deepEqual(
      await migrated.listMessages(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
      ),
      standardBefore,
    );
    assert.deepEqual(
      await migrated.listMessages(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
        "audit",
      ),
      auditBefore,
    );
    assert.deepEqual(
      await migrated.loadThreadRollbackReceipt({
        tenantId: rollback.input.tenantId,
        threadId: rollback.input.event.identity.threadId,
        idempotency: rollback.input.idempotency,
      }),
      { ...rollback.result, disposition: "replayed" },
    );
    assert.deepEqual(
      await migrated.loadAutomation({
        tenantId: "tenant-1",
        spaceId: "space-1",
        automationId: automation.record.definition.automationId,
      }),
      automation.record,
    );
    const raw = new DatabaseSync(path);
    try {
      assert.deepEqual(
        raw
          .prepare(
            `SELECT tenant_id, revision, active_provider_id, catalog_json, updated_at
             FROM model_provider_settings
             WHERE tenant_id = 'provider-preservation-tenant'`,
          )
          .get(),
        providerBefore,
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT name FROM sqlite_schema
             WHERE type = 'table'
               AND name IN (
                 'workspace_operations', 'workspace_operation_revisions',
                 'workspace_delivery_attempts', 'workspace_operation_receipts'
               )
             ORDER BY name`,
          )
          .all()
          .map((row) => String(row.name)),
        [
          "workspace_delivery_attempts",
          "workspace_operation_receipts",
          "workspace_operation_revisions",
          "workspace_operations",
        ],
      );
    } finally {
      raw.close();
    }
  } finally {
    await migrated.close();
  }
});

test("SQLite v23 workspace authority is STRICT and rejects corrupted durable JSON", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-strict-"));
  const path = join(directory, "authority.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const database = new DatabaseSync(path);
  try {
    const tableSql = database
      .prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'table'
           AND name IN (
             'workspace_operations', 'workspace_operation_revisions',
             'workspace_delivery_attempts', 'workspace_operation_receipts'
           )
         ORDER BY name`,
      )
      .all() as Array<{ name: string; sql: string }>;
    assert.deepEqual(
      tableSql.map(({ name, sql }) => ({
        name,
        strict: /\)\s*STRICT\s*$/iu.test(sql),
      })),
      [
        { name: "workspace_delivery_attempts", strict: true },
        { name: "workspace_operation_receipts", strict: true },
        { name: "workspace_operation_revisions", strict: true },
        { name: "workspace_operations", strict: true },
      ],
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO workspace_operations (
           tenant_id, space_id, thread_id, execution_id, revision, status,
             base_revision, action_digest, command_digest, operation_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "tenant-1",
          "space-1",
          "thread-1",
          "wrong-type",
          "not-an-integer",
          "prepared",
          1,
          `sha256:${"a".repeat(64)}`,
          `sha256:${"b".repeat(64)}`,
          "{}",
        ),
    );
    database
      .prepare(
        `INSERT INTO workspace_operations (
           tenant_id, space_id, thread_id, execution_id, revision, status,
           base_revision, action_digest, command_digest, operation_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "tenant-1",
        "space-1",
        "thread-1",
        "corrupt-json-authority",
        1,
        "prepared",
        1,
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        "{}",
      );
  } finally {
    database.close();
  }
  const corrupted = new SqliteRunStore(path);
  try {
    await assert.rejects(
      corrupted.loadWorkspaceOperation({
        tenantId: "tenant-1",
        spaceId: "space-1",
        threadId: "thread-1",
        executionId: "corrupt-json-authority",
      }),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite v22 to v23 freezes legacy receipts at the preserved head", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "crewon-workspace-v22-data-"));
  const path = join(directory, "authority.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const input = prepareInput();
  const query = receiptQuery("execute");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE workspace_operation_receipts;
    DROP TABLE workspace_delivery_attempts;
    DROP TABLE workspace_operation_revisions;
    DROP TABLE workspace_operations;
    CREATE TABLE workspace_operations (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      command_digest TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      PRIMARY KEY (tenant_id, execution_id)
    ) STRICT;
    CREATE INDEX workspace_operations_thread_idx
      ON workspace_operations (tenant_id, space_id, thread_id, execution_id);
    CREATE TABLE workspace_operation_receipts (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      command_digest TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY (tenant_id, space_id, phase, scope, idempotency_key),
      FOREIGN KEY (tenant_id, execution_id)
        REFERENCES workspace_operations(tenant_id, execution_id)
    ) STRICT;
  `);
  legacy
    .prepare(
      `INSERT INTO workspace_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.operation.tenantId,
      input.operation.spaceId,
      input.operation.threadId,
      input.operation.executionId,
      input.operation.revision,
      input.operation.status,
      input.operation.command.actionDigest,
      input.operation.command.commandDigest,
      JSON.stringify(input.operation),
    );
  legacy
    .prepare(
      `INSERT INTO workspace_operation_receipts VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
    .run(
      query.tenantId,
      query.spaceId,
      query.phase,
      query.idempotency.scope,
      query.idempotency.key,
      input.operation.threadId,
      input.operation.executionId,
      input.operation.command.actionDigest,
      input.operation.command.commandDigest,
      query.idempotency.requestFingerprint,
    );
  legacy.exec("PRAGMA user_version = 22");
  legacy.close();

  const migrated = new SqliteRunStore(path);
  try {
    assert.deepEqual(await migrated.loadWorkspaceOperationReceipt(query), {
      disposition: "replayed",
      operation: input.operation,
    });
    assert.deepEqual(
      await migrated.loadWorkspaceOperation({
        tenantId: input.operation.tenantId,
        spaceId: input.operation.spaceId,
        threadId: input.operation.threadId,
        executionId: input.operation.executionId,
      }),
      input.operation,
    );
  } finally {
    await migrated.close();
  }
});

test("SQLite delivery codec rejects redundant column drift from attempt JSON", async (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-workspace-attempt-drift-"),
  );
  const path = join(directory, "authority.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new SqliteRunStore(path);
  await seedWorkspaceThread(store);
  const input = prepareInput();
  await store.prepareWorkspaceOperation(input);
  await store.close();
  const database = new DatabaseSync(path);
  database
    .prepare(
      `UPDATE workspace_delivery_attempts SET phase = 'cancel'
       WHERE tenant_id = ? AND execution_id = ? AND attempt_number = 1`,
    )
    .run(input.operation.tenantId, input.operation.executionId);
  database.close();
  const corrupted = new SqliteRunStore(path);
  try {
    await assert.rejects(
      corrupted.listWorkspaceOperationDeliveryAttempts({
        tenantId: input.operation.tenantId,
        spaceId: input.operation.spaceId,
        threadId: input.operation.threadId,
        executionId: input.operation.executionId,
        afterAttemptNumber: 0,
        limit: 100,
        view: "audit",
      }),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite v23 refuses a receipt table without its physical idempotency key", async (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "crewon-workspace-schema-drift-"),
  );
  const path = join(directory, "authority.sqlite");
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = new SqliteRunStore(path);
  await initialized.close();
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE workspace_operation_receipts
      RENAME TO workspace_operation_receipts_valid;
    CREATE TABLE workspace_operation_receipts (
      tenant_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      action_digest TEXT NOT NULL,
      command_digest TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      attempt_number INTEGER,
      attempt_identity TEXT,
      seed_result_revision INTEGER NOT NULL,
      seed_result_digest TEXT NOT NULL
    ) STRICT;
    DROP TABLE workspace_operation_receipts_valid;
  `);
  database.close();
  assert.throws(
    () => new SqliteRunStore(path),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "sqlite_schema_version_unsupported",
  );
});
