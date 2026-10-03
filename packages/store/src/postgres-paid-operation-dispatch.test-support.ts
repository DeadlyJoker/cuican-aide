import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { ReserveExternalOperation } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import { extensionFixture } from "./extension-store.test-support.ts";
import { seedProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";

/** Original full unpriced Turn; no quote, grant or installation payer is inferred. */
export async function postgresUnpricedOperationFixture(
  t: TestContext,
  creditSchema: "absent" | "migrated",
) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(connectionString);
  const f = await extensionFixture(t, "postgres");
  await f.seed();
  const input = extensionTurnInput("original-unpriced-run");
  await f.prepare({
    ...input,
    commit: {
      ...input.turn.run,
      tenantId: input.turn.tenantId,
      idempotency: input.turn.idempotency,
    },
  });
  if (creditSchema === "migrated") await f.first.store.migrateCredits();
  const accepted = await f.first.store.commitExtensionTurn(input);
  assert.equal(accepted.creditAdmission, undefined);
  const admin = new Pool({ connectionString, max: 2 });
  t.after(async () => admin.end());
  const operationId = randomUUID();
  const operation: ReserveExternalOperation = {
    tenantId: input.binding.tenantId,
    runId: input.binding.runId,
    bindingDigest: input.binding.bindingDigest,
    operationId,
    correlationId: operationId,
    executionId: "original-unpriced-execution",
    idempotencyKey: "original-unpriced-dispatch",
    actionDigest: extensionStoreDigester.sha256("original-unpriced-action"),
    requestDigest: extensionStoreDigester.sha256("original-unpriced-request"),
    createdAt: new Date().toISOString(),
  };
  return {
    ...f,
    admin,
    operation,
    operations: f.first.parent.externalOperationStore(),
  };
}

/** Real PostgreSQL, original paid Turn transaction and original leased Run start. */
export async function postgresPaidOperationFixture(t: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  assert.ok(connectionString);
  const f = await extensionFixture(t, "postgres");
  const input = await seedProbeAdmission(f);
  assert.ok(input.creditAdmission);
  const admission = input.creditAdmission;
  const schema = f.prefix.slice(1, -2);
  const admin = new Pool({ connectionString, max: 4 });
  t.after(async () => admin.end());
  const parent = f.first.parent;
  const credits = parent.pluginCreditStore();
  const first = parent.externalOperationStore();
  const second = f.second.parent.externalOperationStore();
  const locator = {
    tenantId: input.binding.tenantId,
    runId: input.binding.runId,
  };
  const operation = (key: string = randomUUID()): ReserveExternalOperation => {
    const operationId = randomUUID();
    return {
      ...locator,
      bindingDigest: input.binding.bindingDigest,
      operationId,
      correlationId: operationId,
      executionId: `paid-operation-${key}`,
      idempotencyKey: `paid-dispatch-${key}`,
      actionDigest: extensionStoreDigester.sha256(`action:${key}`),
      requestDigest: extensionStoreDigester.sha256(`request:${key}`),
      createdAt: new Date().toISOString(),
    };
  };
  const start = async () => {
    const claim = await parent.claimNextWorkItem({
      ownerId: "paid-operation-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });
    assert.ok(claim);
    return parent.commitLeasedRun({
      lease: {
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      },
      commit: {
        tenantId: locator.tenantId,
        idempotency: {
          scope: "postgres-paid-operation-start",
          key: locator.runId,
          requestFingerprint: extensionStoreDigester.sha256("paid-start"),
        },
        expectedRevision: 1,
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: locator.runId },
            eventId: randomUUID(),
            sequence: 2,
            occurredAt: new Date().toISOString(),
            type: "run.started",
            data: {},
          },
        ],
        outbox: [],
        workItems: [],
      },
      history: null,
    });
  };
  const commitEvent = async (
    change:
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.failed" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.completed" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.cancel.requested" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.canceled" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.suspended" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.resumed" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.approval.required" }>,
          "type" | "data"
        >
      | Pick<
          Extract<RunLifecycleEvent, { type: "run.reconciliation.required" }>,
          "type" | "data"
        >,
  ) => {
    const run = await parent.loadRun(locator);
    assert.ok(run);
    const key = randomUUID();
    return parent.commitRun({
      tenantId: locator.tenantId,
      idempotency: {
        scope: "postgres-paid-operation-lifecycle",
        key,
        requestFingerprint: extensionStoreDigester.sha256(key),
      },
      expectedRevision: run.revision,
      events: [
        {
          schemaVersion: "crewon.run-event.v0",
          identity: { runId: locator.runId },
          eventId: key,
          sequence: run.lastSequence + 1,
          occurredAt: new Date().toISOString(),
          ...change,
        },
      ],
      outbox: [],
      workItems: [],
    });
  };
  return {
    ...f,
    admin,
    schema,
    parent,
    input,
    admission,
    locator,
    credits,
    first,
    second,
    operation,
    start,
    commitEvent,
  };
}

/** Wait for PostgreSQL's actual lock graph, never infer a blocked write from time. */
export async function waitForPostgresBlocker(
  observer: Pool,
  blockerPid: number,
  excludePid: number | null = null,
): Promise<number> {
  const until = Date.now() + 5_000;
  do {
    const result = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
       AND wait_event='advisory' AND ($2::integer IS NULL OR pid<>$2)
       ORDER BY pid LIMIT 1`,
      [blockerPid, excludePid],
    );
    if (result.rows[0] !== undefined) return result.rows[0].pid;
    await delay(10);
  } while (Date.now() < until);
  assert.fail("expected an actual PostgreSQL advisory-lock waiter");
}

export async function holdPostgresRunLock(
  admin: Pool,
  locator: { tenantId: string; runId: string },
) {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`run:${locator.tenantId}:${locator.runId}`],
    );
    const result = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    return { client, pid: result.rows[0]!.pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }
}

/** A real trigger pauses the normal ledger/operation writer inside its transaction. */
export async function postgresWriteBarrier(
  admin: Pool,
  prefix: string,
  table: "plugin_credit_reservations" | "extension_external_operations",
  mutation: "UPDATE" | "INSERT",
) {
  const key = `paid-operation-barrier-${randomUUID()}`;
  await admin.query(`
    CREATE FUNCTION ${prefix}paid_operation_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${key}',0));
      RETURN NEW;
    END; $$;
    CREATE TRIGGER paid_operation_barrier BEFORE ${mutation} ON ${prefix}${table}
      FOR EACH ROW EXECUTE FUNCTION ${prefix}paid_operation_barrier();
  `);
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      key,
    ]);
    const pid = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    return { client, pid: pid.rows[0]!.pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw error;
  }
}

export async function retirePostgresBarrier(client: PoolClient) {
  try {
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
