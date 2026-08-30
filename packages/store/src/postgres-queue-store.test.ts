import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  RunStoreError,
  type OutboxMessage,
  type WorkItem,
} from "@crewon/application";
import { Pool } from "pg";

import { PostgresQueueStore } from "./postgres-queue-store.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const skipWithoutPostgres =
  connectionString === undefined
    ? "CREWON_TEST_POSTGRES_URL is not configured"
    : false;

test("requires explicit bounded PostgreSQL connection configuration", () => {
  assert.throws(
    () => new PostgresQueueStore({}),
    hasStoreCode("postgres_connection_config_invalid"),
  );
  assert.throws(
    () =>
      new PostgresQueueStore({
        connectionString: "postgres://localhost/test",
        schema: "unsafe-schema",
      }),
    hasStoreCode("postgres_schema_name_invalid"),
  );
});

test(
  "migrates concurrently and skips a row locked by another PostgreSQL worker",
  { skip: skipWithoutPostgres },
  async () => {
    const fixture = await postgresFixture();
    try {
      await Promise.all([fixture.first.migrate(), fixture.second.migrate()]);
      const version = await fixture.admin.query<{ version: number }>(
        `SELECT version FROM ${fixture.schemaSql}.schema_migrations
         WHERE component = 'durable_queue'`,
      );
      assert.equal(version.rows[0]?.version, 1);

      const messages = [outbox("outbox-1"), outbox("outbox-2")];
      await Promise.all(
        messages.map((message) => seedOutbox(fixture, message)),
      );

      const blocker = await fixture.admin.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `SELECT message_id FROM ${fixture.schemaSql}.outbox
           ORDER BY outbox_order ASC FOR UPDATE LIMIT 1`,
        );
        const skipped = await fixture.second.claimNextOutbox({
          ownerId: "dispatcher-b",
          leaseId: "lease-b",
          leaseDurationMs: 30_000,
        });
        assert.equal(skipped?.message.messageId, "outbox-2");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }

      const first = await fixture.first.claimNextOutbox({
        ownerId: "dispatcher-a",
        leaseId: "lease-a",
        leaseDurationMs: 30_000,
      });
      assert.equal(first?.message.messageId, "outbox-1");
      assert.deepEqual(await fixture.first.listPendingOutbox(10), []);

      await fixture.admin.query(
        `UPDATE ${fixture.schemaSql}.schema_migrations SET version = 2
         WHERE component = 'durable_queue'`,
      );
      await assert.rejects(
        fixture.first.migrate(),
        hasStoreCode("postgres_schema_too_new"),
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "uses database time and fences reclaimed Outbox and Work Item leases",
  { skip: skipWithoutPostgres },
  async () => {
    const fixture = await postgresFixture();
    try {
      await fixture.first.migrate();
      const message = outbox("outbox-fenced");
      const item = workItem("work-fenced");
      await seedOutbox(fixture, message);
      await seedWorkItem(fixture, item);
      assert.deepEqual(await fixture.first.listPendingOutbox(10), [message]);
      assert.deepEqual(await fixture.first.listPendingWorkItems(10), [item]);

      const original = await fixture.first.claimNextOutbox({
        ownerId: "dispatcher-a",
        leaseId: "outbox-lease-a",
        leaseDurationMs: 60_000,
      });
      assert.ok(original !== null);
      const remaining = await fixture.admin.query<{ remaining_ms: string }>(
        `SELECT extract(epoch FROM (lease_expires_at - clock_timestamp())) * 1000 AS remaining_ms
         FROM ${fixture.schemaSql}.outbox WHERE message_id = $1`,
        [message.messageId],
      );
      assert.ok(Number(remaining.rows[0]?.remaining_ms) > 50_000);

      await fixture.admin.query(
        `UPDATE ${fixture.schemaSql}.outbox
         SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
         WHERE message_id = $1`,
        [message.messageId],
      );
      const reclaimed = await fixture.second.claimNextOutbox({
        ownerId: "dispatcher-b",
        leaseId: "outbox-lease-b",
        leaseDurationMs: 60_000,
      });
      assert.equal(reclaimed?.lease.epoch, 2);
      await assert.rejects(
        fixture.first.acknowledgeOutbox({
          messageId: message.messageId,
          ownerId: original.lease.ownerId,
          leaseId: original.lease.leaseId,
          leaseEpoch: original.lease.epoch,
        }),
        hasStoreCode("stale_lease"),
      );
      assert.ok(reclaimed !== null);
      await fixture.second.acknowledgeOutbox({
        messageId: message.messageId,
        ownerId: reclaimed.lease.ownerId,
        leaseId: reclaimed.lease.leaseId,
        leaseEpoch: reclaimed.lease.epoch,
      });

      const work = await fixture.first.claimNextWorkItem({
        ownerId: "worker-a",
        leaseId: "work-lease-a",
        leaseDurationMs: 30_000,
      });
      assert.ok(work !== null);
      const renewed = await fixture.first.renewWorkItemLease({
        workItemId: item.workItemId,
        ownerId: work.lease.ownerId,
        leaseId: work.lease.leaseId,
        leaseEpoch: work.lease.epoch,
        leaseDurationMs: 60_000,
      });
      assert.equal(renewed.epoch, 1);
      await fixture.first.retryWorkItem({
        workItemId: item.workItemId,
        ownerId: renewed.ownerId,
        leaseId: renewed.leaseId,
        leaseEpoch: renewed.epoch,
        retryAfterMs: 30_000,
        reasonCode: "runtime_unavailable",
      });
      assert.equal(
        await fixture.second.claimNextWorkItem({
          ownerId: "worker-b",
          leaseId: "work-too-early",
          leaseDurationMs: 30_000,
        }),
        null,
      );
      await fixture.admin.query(
        `UPDATE ${fixture.schemaSql}.work_items
         SET available_at = clock_timestamp() - interval '1 millisecond'
         WHERE work_item_id = $1`,
        [item.workItemId],
      );
      const retried = await fixture.second.claimNextWorkItem({
        ownerId: "worker-b",
        leaseId: "work-lease-b",
        leaseDurationMs: 30_000,
      });
      assert.equal(retried?.lease.epoch, 2);
      assert.ok(retried !== null);
      await fixture.second.completeWorkItem({
        workItemId: item.workItemId,
        ownerId: retried.lease.ownerId,
        leaseId: retried.lease.leaseId,
        leaseEpoch: retried.lease.epoch,
      });

      const states = await fixture.admin.query<{
        outbox: string;
        work: string;
      }>(
        `SELECT
           (SELECT status FROM ${fixture.schemaSql}.outbox WHERE message_id = $1) AS outbox,
           (SELECT status FROM ${fixture.schemaSql}.work_items WHERE work_item_id = $2) AS work`,
        [message.messageId, item.workItemId],
      );
      assert.deepEqual(states.rows[0], {
        outbox: "delivered",
        work: "completed",
      });
    } finally {
      await fixture.close();
    }
  },
);

test(
  "claims a Goal activation Work Item with its complete payload",
  { skip: skipWithoutPostgres },
  async () => {
    const fixture = await postgresFixture();
    try {
      await fixture.first.migrate();
      const item: WorkItem = {
        workItemId: "work-goal-activation",
        tenantId: "tenant-1",
        runId: "run-goal-activation",
        kind: "run.execute",
        payload: {
          goalId: "goal-1",
          goalRevision: 1,
          throughSequence: 1,
          trigger: "goalActivation",
        },
        createdAt: "2026-08-09T00:00:00.000Z",
      };
      await seedWorkItem(fixture, item);

      assert.deepEqual(await fixture.first.listPendingWorkItems(10), [item]);
      const claim = await fixture.first.claimNextWorkItem({
        ownerId: "goal-activation-worker",
        leaseId: "goal-activation-lease",
        leaseDurationMs: 30_000,
      });
      assert.deepEqual(claim?.workItem, item);
    } finally {
      await fixture.close();
    }
  },
);

async function postgresFixture(): Promise<{
  admin: Pool;
  first: PostgresQueueStore;
  second: PostgresQueueStore;
  schemaSql: string;
  close(): Promise<void>;
}> {
  assert.ok(connectionString !== undefined);
  const schema = `crewon_test_${randomUUID().replaceAll("-", "_")}`;
  const schemaSql = `"${schema}"`;
  const admin = new Pool({ connectionString, max: 2 });
  const first = new PostgresQueueStore({
    connectionString,
    schema,
    maxPoolSize: 2,
    statementTimeoutMs: 1_000,
  });
  const second = new PostgresQueueStore({
    connectionString,
    schema,
    maxPoolSize: 2,
    statementTimeoutMs: 1_000,
  });
  return {
    admin,
    first,
    second,
    schemaSql,
    async close() {
      await Promise.all([first.close(), second.close()]);
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
      await admin.end();
    },
  };
}

async function seedOutbox(
  fixture: { admin: Pool; schemaSql: string },
  message: OutboxMessage,
): Promise<void> {
  await fixture.admin.query(
    `INSERT INTO ${fixture.schemaSql}.outbox
       (message_id, tenant_id, run_id, topic, message_json, created_at, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() - interval '1 second')`,
    [
      message.messageId,
      message.tenantId,
      message.runId,
      message.topic,
      message,
      message.createdAt,
    ],
  );
}

async function seedWorkItem(
  fixture: { admin: Pool; schemaSql: string },
  item: WorkItem,
): Promise<void> {
  await fixture.admin.query(
    `INSERT INTO ${fixture.schemaSql}.work_items
       (work_item_id, tenant_id, run_id, kind, work_item_json, created_at, available_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() - interval '1 second')`,
    [
      item.workItemId,
      item.tenantId,
      item.runId,
      item.kind,
      item,
      item.createdAt,
    ],
  );
}

function outbox(messageId: string): OutboxMessage {
  return {
    messageId,
    tenantId: "tenant-1",
    runId: "run-1",
    topic: "run.event.committed",
    payload: { throughSequence: 2 },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}

function workItem(workItemId: string): WorkItem {
  return {
    workItemId,
    tenantId: "tenant-1",
    runId: "run-1",
    kind: "run.execute",
    payload: { throughSequence: 2 },
    createdAt: "2026-08-09T00:00:00.000Z",
  };
}

function hasStoreCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RunStoreError && error.code === code;
}
