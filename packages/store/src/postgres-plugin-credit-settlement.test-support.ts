import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type {
  PluginCreditSettlementDecision,
  PluginCreditSettlementEvidence,
} from "@crewon/application";
import { prepareToolExecutionReceipt } from "@crewon/domain";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { postgresPaidOperationFixture } from "./postgres-paid-operation-dispatch.test-support.ts";
import { PostgresPluginCreditSettlementStore } from "./postgres-plugin-credit-settlement-store.ts";
import { toolReceipt } from "./run-execution-store-conformance.test-support.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Gate = Readonly<{
  where: "commit" | "ledger" | "operations" | "workItems";
  entered: ReturnType<typeof deferred>;
  resume: ReturnType<typeof deferred>;
}> & { reached: boolean; pid: number | null };

/** Named funded test Turn; real PostgreSQL and original installation/Run/queue writers. */
export async function postgresSettlementFixture(t: TestContext) {
  const gates: Gate[] = [];
  t.after(() => {
    for (const gate of gates) gate.resume.resolve();
  });
  const f = await postgresPaidOperationFixture(t);
  const pool = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    max: 1,
  });
  const secondPool = new Pool({
    connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
    max: 1,
  });
  t.after(async () => {
    await pool.end();
    await secondPool.end();
  });
  let closed = false;
  let gate: Gate | null = null;
  let tracking = false;
  const commands: string[] = [];
  const controlledPool = new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key) {
              if (key === "query")
                return async (sql: string, values?: unknown[]) => {
                  const result = await connection.query(sql, values);
                  const pending = gate;
                  if (pending !== null || tracking) commands.push(sql.trim());
                  const matches =
                    pending !== null &&
                    (pending.where === "commit"
                      ? sql.trim() === "COMMIT"
                      : pending.where === "ledger"
                        ? sql.startsWith(
                            `UPDATE ${f.prefix}plugin_credit_reservations SET`,
                          )
                        : pending.where === "operations"
                          ? sql.includes("extension_external_operations") &&
                            sql.includes("ORDER BY") &&
                            sql.includes("FOR UPDATE")
                          : sql.includes("work_items") &&
                            sql.includes("ORDER BY") &&
                            sql.includes("FOR UPDATE"));
                  if (pending !== null && !pending.reached && matches) {
                    pending.reached = true;
                    pending.pid = (
                      await connection.query<{ pid: number }>(
                        "SELECT pg_backend_pid() AS pid",
                      )
                    ).rows[0]!.pid;
                    pending.entered.resolve();
                    await pending.resume.promise;
                  }
                  return result;
                };
              const value: unknown = Reflect.get(connection, key, connection);
              return typeof value === "function"
                ? value.bind(connection)
                : value;
            },
          }) as PoolClient;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ownerInput = {
    pool: controlledPool,
    schema: f.schema,
    assertOpen() {
      if (closed) throw new Error("settlement_test_host_closed");
    },
  };
  const first = new PostgresPluginCreditSettlementStore(ownerInput);
  const second = new PostgresPluginCreditSettlementStore({
    pool: secondPool,
    schema: f.schema,
    assertOpen() {},
  });
  await first.migrate();
  await second.migrate();
  async function startWithLease() {
    const claim = await f.parent.claimNextWorkItem({
      ownerId: "settlement-test-worker",
      leaseId: randomUUID(),
      leaseDurationMs: 60_000,
    });
    assert.ok(claim);
    const lease = {
      workItemId: claim.workItem.workItemId,
      ownerId: claim.lease.ownerId,
      leaseId: claim.lease.leaseId,
      leaseEpoch: claim.lease.epoch,
    };
    const eventId = randomUUID();
    await f.parent.commitLeasedRun({
      lease,
      history: null,
      commit: {
        tenantId: f.locator.tenantId,
        expectedRevision: 1,
        idempotency: {
          scope: "settlement-test-start",
          key: eventId,
          requestFingerprint: extensionStoreDigester.sha256(eventId),
        },
        events: [
          {
            schemaVersion: "crewon.run-event.v0",
            identity: { runId: f.locator.runId },
            eventId,
            sequence: 2,
            occurredAt: new Date().toISOString(),
            type: "run.started",
            data: {},
          },
        ],
        outbox: [],
        workItems: [],
      },
    });
    return { claim, lease };
  }
  async function ready() {
    const current = await startWithLease();
    await f.commitEvent({ type: "run.completed", data: { outputRef: null } });
    await f.parent.completeWorkItem(current.lease);
    const evidence = await first.loadEvidence(f.locator);
    assert.ok(evidence?.readyToFinalize);
    return { ...current, evidence };
  }
  async function prepareMutation() {
    const current = await startWithLease();
    const base = toolReceipt(current.claim);
    const receipt = prepareToolExecutionReceipt({
      ...base,
      preparedAt: new Date().toISOString(),
      actionIntent: {
        ...base.actionIntent!,
        policySnapshotId: f.input.binding.target.policySnapshotId,
        workspaceBindingId: f.input.binding.target.workspaceBindingId,
      },
    });
    await f.parent.beginRunAttempt({
      ...f.locator,
      lease: current.lease,
      stepId: receipt.stepId,
      attemptId: receipt.attemptId,
      kind: "tool",
      startedAt: receipt.preparedAt,
    });
    await f.parent.prepareToolExecution({ lease: current.lease, receipt });
    const dispatched = await f.parent.transitionToolExecution({
      ...f.locator,
      receiptId: receipt.receiptId,
      lease: current.lease,
      expectedRevision: receipt.revision,
      transition: { kind: "dispatch", occurredAt: new Date().toISOString() },
    });
    return { ...current, receipt: dispatched };
  }
  function mutationInput(current: Awaited<ReturnType<typeof prepareMutation>>) {
    return {
      ...f.operation("settlement-mutation"),
      executionId: current.receipt.executionId,
      actionDigest: current.receipt.actionDigest,
      idempotencyKey: current.receipt.idempotencyKey,
    };
  }
  async function mutation() {
    const current = await prepareMutation();
    const operation = await f.first.reserveExternalOperation(
      mutationInput(current),
    );
    assert.equal(operation.disposition, "created");
    return { ...current, operation: operation.operation };
  }
  async function finishMutation(current: Awaited<ReturnType<typeof mutation>>) {
    await f.first.advanceExternalOperation({
      ...current.operation,
      expectedRevision: current.operation.revision,
      status: "succeeded",
      providerOperationId: "named-settlement-test-provider",
      resultJson: JSON.stringify({ output: "named stored provider result" }),
      updatedAt: new Date().toISOString(),
    });
    const output = "named stored provider result";
    await f.parent.transitionToolExecution({
      ...f.locator,
      receiptId: current.receipt.receiptId,
      lease: current.lease,
      expectedRevision: current.receipt.revision,
      transition: {
        kind: "complete",
        occurredAt: new Date().toISOString(),
        providerReceiptId: "named-settlement-test-provider",
        result: {
          output,
          outputDigest: extensionStoreDigester.sha256(output),
          isError: false,
          artifactRef: null,
        },
      },
    });
    await f.parent.completeRunAttempt({
      ...f.locator,
      lease: current.lease,
      attempt: {
        stepId: current.receipt.stepId,
        attemptId: current.receipt.attemptId,
        finishedAt: new Date().toISOString(),
        checkpointDigest: null,
      },
    });
    await f.commitEvent({ type: "run.completed", data: { outputRef: null } });
    await f.parent.completeWorkItem(current.lease);
  }
  async function financialState() {
    return {
      account: await f.credits.getAccount(f.admission.reservation.scope),
      reservation: await f.credits.getReservation({
        scope: f.admission.reservation.scope,
        reservationId: f.admission.reservation.reservationId,
      }),
      entries: await f.credits.listEntries({
        scope: f.admission.reservation.scope,
        afterRevision: 0,
        limit: 100,
      }),
      finalizations: await f.count("plugin_credit_settlement_finalizations"),
    };
  }
  return {
    ...f,
    operations: f.first,
    first,
    second,
    startWithLease,
    ready,
    prepareMutation,
    mutationInput,
    mutation,
    finishMutation,
    financialState,
    commands,
    closeHost() {
      closed = true;
    },
    replaceOwnerChecker() {
      ownerInput.assertOpen = () => {};
    },
    trackQueries() {
      commands.length = 0;
      tracking = true;
    },
    arm(where: Gate["where"]) {
      gate = {
        where,
        entered: deferred(),
        resume: deferred(),
        reached: false,
        pid: null,
      };
      gates.push(gate);
      return gate;
    },
  };
}

export function namedSettlementDecision(
  evidence: PluginCreditSettlementEvidence,
  outcome: PluginCreditSettlementDecision["outcome"] = {
    kind: "settle",
    actualCredits: "12",
  },
): PluginCreditSettlementDecision {
  return {
    schemaVersion: "crewon.plugin-credit-settlement-decision.v1",
    evidenceDigest: evidence.evidenceDigest,
    authorityId: "named-postgres-settlement-test-policy",
    authorityRevision: "test-policy-1",
    decisionId: randomUUID(),
    outcome,
  };
}

/** Observe PostgreSQL's actual lock graph rather than infer blocking from a delay. */
export async function waitForSettlementRowWaiter(
  pool: Pool,
  blockerPid: number,
): Promise<void> {
  const until = performance.now() + 5_000;
  do {
    const result = await pool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock' LIMIT 1",
      [blockerPid],
    );
    if (result.rows.length === 1) return;
    await delay(10);
  } while (performance.now() < until);
  assert.fail("expected actual PostgreSQL evidence row-lock waiter");
}
