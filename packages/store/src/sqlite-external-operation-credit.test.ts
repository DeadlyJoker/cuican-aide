import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { paidExternalOperationFixture } from "./sqlite-external-operation-credit.test-support.ts";
import { SqliteExternalOperationStore } from "./sqlite-external-operation-store.ts";
import { digest, timestamp } from "./extension-store.test-support.ts";

const denied = /external_operation_credit_dispatch_denied/u;
const invalid = /external_operation_credit_admission_invalid/u;

/** Deliberately remove a linked fact on this fixture's own SQL connection. */
async function deleteLinkedFixtureRecord(
  sql: (statement: string) => Promise<void>,
  statement: string,
): Promise<void> {
  await sql("PRAGMA foreign_keys=OFF;");
  try {
    await sql(statement);
  } finally {
    await sql("PRAGMA foreign_keys=ON;");
  }
}

test("SQLite reserves one actual paid dispatch across independent parent connections", async (t) => {
  const f = await paidExternalOperationFixture(t);
  assert.equal(
    f.committed.creditAdmission?.reservation.scope.principalId,
    f.creditAdmission.reservation.scope.principalId,
  );
  const results = await Promise.all([
    f.operations.reserveExternalOperation(f.operation),
    f.secondOperations.reserveExternalOperation({
      ...f.operation,
      operationId: randomUUID(),
      correlationId: randomUUID(),
    }),
  ]);
  assert.deepEqual(results.map((value) => value.disposition).sort(), [
    "created",
    "existing",
  ]);
  assert.deepEqual(results[0]?.operation, results[1]?.operation);
  assert.equal(await f.count("extension_external_operations"), 1);
  assert.equal(
    (await f.credits.getAccount(f.creditAdmission.reservation.scope))
      ?.reservedCredits,
    "30",
  );
  const reopened = await f.open();
  assert.deepEqual(
    await reopened.parent
      .externalOperationStore()
      .reserveExternalOperation(f.operation),
    { disposition: "existing", operation: results[0]!.operation },
  );
});

test("SQLite a paid queued Run cannot dispatch until the original leased start commits", async (t) => {
  const f = await paidExternalOperationFixture(t, { start: false });
  assert.equal((await f.parent.loadRun(f.binding))?.status, "queued");
  await assert.rejects(
    f.operations.reserveExternalOperation(f.operation),
    denied,
  );
  assert.equal(await f.count("extension_external_operations"), 0);
  await f.transition("run.started", {});
  assert.equal(
    (await f.operations.reserveExternalOperation(f.operation)).disposition,
    "created",
  );
});

for (const status of [
  "completed",
  "failed",
  "canceled",
  "waitingApproval",
  "suspended",
  "reconciling",
] as const) {
  test(`SQLite paid ${status} Run denies new dispatch while an exact old receipt remains observable`, async (t) => {
    const f = await paidExternalOperationFixture(t);
    const original = await f.operations.reserveExternalOperation(f.operation);
    if (status === "completed")
      await f.transition("run.completed", { outputRef: null });
    else if (status === "failed")
      await f.transition("run.failed", {
        code: "fixture_failure",
        retryable: false,
      });
    else if (status === "canceled") {
      await f.transition("run.cancel.requested", {
        actorId: f.binding.actorId,
      });
      await f.transition("run.canceled", { reasonCode: "fixture_cancel" });
    } else if (status === "waitingApproval")
      await f.transition("run.approval.required", {
        approvalId: "fixture-approval",
        actionDigest: digest,
      });
    else if (status === "suspended")
      await f.transition("run.suspended", { reasonCode: "fixture_suspend" });
    else
      await f.transition("run.reconciliation.required", {
        receiptId: "fixture-reconciliation",
      });
    assert.equal((await f.parent.loadRun(f.binding))?.status, status);
    await assert.rejects(
      f.operations.reserveExternalOperation(f.nextOperation()),
      denied,
    );
    assert.deepEqual(
      await f.secondOperations.reserveExternalOperation(f.operation),
      {
        disposition: "existing",
        operation: original.operation,
      },
    );
    await assert.rejects(
      f.operations.reserveExternalOperation({
        ...f.operation,
        requestDigest: `sha256:${"b".repeat(64)}`,
      }),
      /external_operation_identity_conflict/u,
    );
    const advanced = await f.operations.advanceExternalOperation({
      tenantId: f.binding.tenantId,
      runId: f.binding.runId,
      bindingDigest: f.binding.bindingDigest,
      operationId: original.operation.operationId,
      expectedRevision: original.operation.revision,
      status: "submitted",
      providerOperationId: "provider-operation-fixture",
      resultJson: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    assert.equal(advanced.disposition, "updated");
    assert.equal(await f.count("extension_external_operations"), 1);
  });
}

test("SQLite actual cancellation intent denies a new paid dispatch before terminal reduction", async (t) => {
  const f = await paidExternalOperationFixture(t);
  await f.transition("run.cancel.requested", { actorId: f.binding.actorId });
  const current = await f.parent.loadRun(f.binding);
  assert.equal(current?.status, "running");
  assert.equal(current?.cancelRequested, true);
  await assert.rejects(
    f.operations.reserveExternalOperation(f.operation),
    denied,
  );
  assert.equal(await f.count("extension_external_operations"), 0);
});

for (const state of ["settled", "released"] as const) {
  test(`SQLite ${state} actual personal reservation cannot authorize another supplier dispatch`, async (t) => {
    const f = await paidExternalOperationFixture(t);
    const original = await f.operations.reserveExternalOperation(f.operation);
    const identity = {
      scope: f.creditAdmission.reservation.scope,
      reservationId: f.creditAdmission.reservation.reservationId,
    };
    if (state === "settled")
      await f.credits.settle({ ...identity, actualCredits: "20" });
    else await f.credits.release(identity);
    assert.equal((await f.credits.getReservation(identity))?.state, state);
    await assert.rejects(
      f.operations.reserveExternalOperation(f.nextOperation()),
      denied,
    );
    assert.deepEqual(await f.operations.reserveExternalOperation(f.operation), {
      disposition: "existing",
      operation: original.operation,
    });
    assert.equal(await f.count("extension_external_operations"), 1);
  });
}

test("SQLite a caller cannot turn a paid Run into an unpriced dispatch with another binding digest", async (t) => {
  const f = await paidExternalOperationFixture(t);
  await assert.rejects(
    f.operations.reserveExternalOperation({
      ...f.operation,
      bindingDigest: `sha256:${"b".repeat(64)}`,
    }),
    invalid,
  );
  assert.equal(await f.count("extension_external_operations"), 0);
});

for (const corruption of [
  "admission",
  "binding",
  "reservation",
  "account",
  "quote",
  "receipt",
  "runActor",
  "runRoute",
  "unknownStatus",
  "cancelFlag",
  "runMissing",
] as const) {
  test(`SQLite paid dispatch fails closed for actual ${corruption} corruption`, async (t) => {
    const f = await paidExternalOperationFixture(t);
    if (corruption === "admission")
      await f.sql(
        "DROP TRIGGER extension_credit_admissions_no_delete; DELETE FROM extension_credit_admissions;",
      );
    else if (corruption === "binding")
      await f.sql("DELETE FROM extension_run_bindings;");
    else if (corruption === "reservation")
      await deleteLinkedFixtureRecord(
        f.sql,
        "DELETE FROM plugin_credit_reservations;",
      );
    else if (corruption === "account")
      await deleteLinkedFixtureRecord(
        f.sql,
        "DELETE FROM plugin_credit_accounts;",
      );
    else if (corruption === "quote")
      await f.sql(
        "UPDATE plugin_credit_reservations SET record_json=json_set(record_json,'$.quotedCredits','31');",
      );
    else if (corruption === "receipt")
      await f.sql("DELETE FROM extension_mutation_receipts WHERE kind='task';");
    else if (corruption === "runActor")
      await f.sql(
        "UPDATE run_snapshots SET state_json=json_set(state_json,'$.createdByActorId','another-user');",
      );
    else if (corruption === "runRoute")
      await f.sql(
        "UPDATE run_snapshots SET state_json=json_set(state_json,'$.authorityId','another-authority');",
      );
    else if (corruption === "unknownStatus")
      await f.sql(
        "UPDATE run_snapshots SET state_json=json_set(state_json,'$.status','futureTerminal');",
      );
    else if (corruption === "cancelFlag")
      await f.sql(
        "UPDATE run_snapshots SET state_json=json_remove(state_json,'$.cancelRequested');",
      );
    else await deleteLinkedFixtureRecord(f.sql, "DELETE FROM run_snapshots;");
    await assert.rejects(
      f.operations.reserveExternalOperation(f.operation),
      corruption === "unknownStatus" || corruption === "cancelFlag"
        ? denied
        : invalid,
    );
    assert.equal(await f.count("extension_external_operations"), 0);
  });
}

test("SQLite original unpriced operation path remains usable with no credit or Run schema", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const operations = new SqliteExternalOperationStore(database);
    await operations.migrate();
    const input = {
      tenantId: "legacy-tenant",
      runId: "legacy-run",
      bindingDigest: digest,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      executionId: "legacy-execution",
      idempotencyKey: "legacy-key",
      actionDigest: digest,
      requestDigest: digest,
      createdAt: timestamp,
    };
    const saved = await operations.reserveExternalOperation(input);
    assert.equal(saved.disposition, "created");
    assert.deepEqual(await operations.reserveExternalOperation(input), {
      disposition: "existing",
      operation: saved.operation,
    });
    const schema = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    assert.deepEqual(
      schema.map((row) => row.name),
      ["extension_external_operations"],
    );
  } finally {
    database.close();
  }
});

test("SQLite a historical unpriced Run remains unpriced when another Run's billing schema exists", async (t) => {
  const f = await paidExternalOperationFixture(t, {
    billing: "unpriced",
    start: false,
  });
  assert.equal(f.committed.creditAdmission, undefined);
  assert.equal(await f.count("extension_credit_admissions"), 0);
  const saved = await f.operations.reserveExternalOperation(f.operation);
  assert.equal(saved.disposition, "created");
  assert.equal((await f.parent.loadRun(f.binding))?.status, "queued");
  assert.equal(await f.count("plugin_credit_reservations"), 0);
});

test("SQLite paid schema corruption cannot silently revert new reservations to the old path", async (t) => {
  const f = await paidExternalOperationFixture(t);
  await f.sql("UPDATE extension_credit_schema_version SET version=9;");
  await assert.rejects(
    f.operations.reserveExternalOperation(f.operation),
    invalid,
  );
  assert.equal(await f.count("extension_external_operations"), 0);
});

test("SQLite losing both credit schema markers cannot turn an original priced receipt into a free dispatch", async (t) => {
  const f = await paidExternalOperationFixture(t);
  const original = await f.operations.reserveExternalOperation(f.operation);
  await f.sql(
    "DROP TABLE extension_credit_admissions; DROP TABLE extension_credit_schema_version;",
  );
  assert.equal(await f.count("extension_mutation_receipts"), 3);
  await assert.rejects(
    f.operations.reserveExternalOperation(f.nextOperation()),
    invalid,
  );
  await assert.rejects(
    f.operations.reserveExternalOperation({
      ...f.nextOperation(),
      bindingDigest: `sha256:${"b".repeat(64)}`,
    }),
    invalid,
  );
  assert.deepEqual(await f.operations.reserveExternalOperation(f.operation), {
    disposition: "existing",
    operation: original.operation,
  });
  assert.equal(await f.count("extension_external_operations"), 1);
});

test("SQLite original genuinely unpriced receipts stay usable after both billing markers are absent", async (t) => {
  const f = await paidExternalOperationFixture(t, {
    billing: "unpriced",
    start: false,
  });
  await f.sql(
    "DROP TABLE extension_credit_admissions; DROP TABLE extension_credit_schema_version;",
  );
  assert.equal(f.committed.creditAdmission, undefined);
  assert.equal(
    (await f.operations.reserveExternalOperation(f.operation)).disposition,
    "created",
  );
  assert.equal(await f.count("extension_external_operations"), 1);
  assert.equal(await f.count("plugin_credit_reservations"), 0);
});
