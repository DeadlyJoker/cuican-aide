import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Client, Pool } from "pg";
import type { TestContext } from "node:test";
import type { ReserveExternalOperation } from "@crewon/application";
import type { RunLifecycleEvent } from "@crewon/domain";
import {
  SqliteExternalOperationStore,
  PostgresExternalOperationStore,
} from "@crewon/store";
import { mediaGenerationFixture } from "./project-media-generation.test-support.ts";

/** Original TaskCore, Run lease, unmetered/paid facts and operation SQL. Provider/PDP are named fixtures. */
export async function mediaOperationFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: Readonly<{
    start?: boolean;
    paid?: boolean;
    kind?: "T10" | "D18";
    workflowDigestsFixture?: Partial<
      Record<import("@crewon/application").ProjectMediaWorkflowId, string>
    >;
  }> = {},
) {
  const f = await mediaGenerationFixture(t, backend, {
    unmetered: !options.paid,
    taskClockFixture: "current",
    workflowDigestsFixture: options.workflowDigestsFixture,
  });
  const { task } = await f.prepare(options.kind ?? "T10"),
    accepted = await f.create(task);
  let open = true;
  const host = {
    assertOpen: () => {
      if (!open) throw new Error("named_media_operation_owner_retired");
    },
  };
  const database =
    backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
  const pool =
    backend === "postgres"
      ? new Pool({ connectionString: process.env.CREWON_TEST_POSTGRES_URL })
      : null;
  if (database)
    database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  t.after(async () => {
    database?.close();
    await pool?.end();
  });
  const schema =
    backend === "postgres"
      ? /^"([a-z][a-z0-9_]+)"\.$/u.exec(f.prefix)?.[1]
      : "main";
  assert.ok(schema);
  const operations = database
    ? new SqliteExternalOperationStore(database, host)
    : new PostgresExternalOperationStore(pool!, schema, host);
  await operations.migrate();
  await operations.migrateProjectMediaOperations();
  // Fixture selected-source Runs also have queue work: claim the actual media work item.
  let claim = null;
  for (let i = 0; i < 16; i++) {
    const next = await f.parent.claimNextWorkItem({
      ownerId: "named_media_operation_worker",
      leaseId: randomUUID(),
      leaseDurationMs: 30000,
    });
    assert.ok(next);
    if (next.workItem.runId === accepted.binding.runId) {
      claim = next;
      break;
    }
  }
  assert.ok(claim);
  const lease = {
    workItemId: claim.workItem.workItemId,
    ownerId: claim.lease.ownerId,
    leaseId: claim.lease.leaseId,
    leaseEpoch: claim.lease.epoch,
  };
  const transition = async (
    type: RunLifecycleEvent["type"],
    data: Record<string, unknown>,
  ) => {
    const current = await f.parent.loadRun(accepted.binding);
    assert.ok(current);
    const id = randomUUID(),
      event = {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: current.runId },
        eventId: id,
        sequence: current.lastSequence + 1,
        occurredAt: new Date(Date.parse(current.updatedAt) + 1).toISOString(),
        type,
        data,
      } as RunLifecycleEvent;
    return f.parent.commitLeasedRun({
      lease,
      commit: {
        tenantId: current.tenantId,
        expectedRevision: current.revision,
        idempotency: {
          scope: "named-media-operation-transition",
          key: id,
          requestFingerprint: id,
        },
        events: [event],
        outbox: [
          {
            messageId: id,
            tenantId: current.tenantId,
            runId: current.runId,
            topic: "run.updated",
            payload: {
              eventId: id,
              eventType: type,
              throughSequence: event.sequence,
            },
            createdAt: event.occurredAt,
          },
        ],
        workItems: [],
      },
      history: null,
    });
  };
  if (options.start !== false)
    assert.equal((await transition("run.started", {})).state.status, "running");
  const scope = {
    tenantId: accepted.binding.tenantId,
    runId: accepted.binding.runId,
    bindingDigest: accepted.binding.bindingDigest,
  };
  const operation: ReserveExternalOperation = {
    ...scope,
    operationId: randomUUID(),
    executionId: "named-original-tool-execution",
    idempotencyKey: "named-original-tool-request",
    actionDigest: f.digester.sha256("named-render-action"),
    requestDigest: f.digester.sha256("named-render-request"),
    correlationId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const second = () => ({
    ...operation,
    operationId: randomUUID(),
    executionId: randomUUID(),
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  });
  const counts = async () => ({
    slots: await f.count("project_media_operations"),
    operations: await f.count("extension_external_operations"),
  });
  return {
    ...f,
    task,
    accepted,
    operations,
    scope,
    operation,
    second,
    transition,
    counts,
    claim,
    lease,
    retire: () => {
      open = false;
    },
  };
}

/** Observe physical successful SQL, without replacing its receiver/transaction. */
export function observeMediaOperationInsert(
  backend: "sqlite" | "postgres",
  after: () => void,
) {
  const proto =
      backend === "sqlite" ? DatabaseSync.prototype : Client.prototype,
    method = backend === "sqlite" ? "prepare" : "query",
    descriptor = Object.getOwnPropertyDescriptor(proto, method)!,
    original = descriptor.value as (...args: unknown[]) => unknown;
  Object.defineProperty(proto, method, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(original, this, args);
      if (
        typeof args[0] !== "string" ||
        !/^INSERT INTO (?:"[a-z0-9_]+"\.|main\.)?project_media_operations /u.test(
          args[0],
        )
      )
        return result;
      if (backend === "postgres")
        return (result as Promise<unknown>).then((v) => {
          after();
          return v;
        });
      const statement = result as { all(...v: unknown[]): unknown },
        all = statement.all;
      Object.defineProperty(statement, "all", {
        value: (...v: unknown[]) => {
          const r = Reflect.apply(all, statement, v);
          after();
          return r;
        },
      });
      return statement;
    },
  });
  return () => Object.defineProperty(proto, method, descriptor);
}
