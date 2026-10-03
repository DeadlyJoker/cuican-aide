import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { PostgresExternalOperationStore } from "./postgres-external-operation-store.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  holdPostgresRunLock,
  postgresPaidOperationFixture,
  postgresUnpricedOperationFixture,
  postgresWriteBarrier,
  retirePostgresBarrier,
  waitForPostgresBlocker,
} from "./postgres-paid-operation-dispatch.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
const options = {
  skip:
    connectionString === undefined
      ? "requires real CREWON_TEST_POSTGRES_URL"
      : false,
  timeout: 20_000,
};
const denied = /external_operation_credit_dispatch_denied/u;
const invalid = /external_operation_credit_admission_invalid/u;

test(
  "PostgreSQL paid supplier dispatch requires the original leased Run start, preserves replay and does not change personal credits",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    const input = f.operation("one");
    const before = await f.credits.getAccount(f.admission.reservation.scope);
    await assert.rejects(f.first.reserveExternalOperation(input), denied);
    await f.start();
    const [first, second] = await Promise.all([
      f.first.reserveExternalOperation(input),
      f.second.reserveExternalOperation({
        ...input,
        operationId: randomUUID(),
      }),
    ]);
    assert.deepEqual([first.disposition, second.disposition].sort(), [
      "created",
      "existing",
    ]);
    assert.deepEqual(first.operation, second.operation);
    assert.equal(await f.count("extension_external_operations"), 1);
    assert.deepEqual(
      await f.credits.getAccount(f.admission.reservation.scope),
      before,
    );
    assert.equal(await f.count("plugin_credit_entries"), 2);
    await f.commitEvent({ type: "run.completed", data: { outputRef: null } });
    await f.credits.settle({
      scope: f.admission.reservation.scope,
      reservationId: f.admission.reservation.reservationId,
      actualCredits: "12",
    });
    assert.deepEqual(
      (await f.first.reserveExternalOperation(input)).operation,
      first.operation,
    );
    await assert.rejects(
      f.first.reserveExternalOperation(f.operation("after-settlement")),
      denied,
    );
    await assert.rejects(
      f.first.reserveExternalOperation({
        ...input,
        requestDigest: extensionStoreDigester.sha256("changed"),
      }),
      /external_operation_identity_conflict/u,
    );
    const observed = await f.second.advanceExternalOperation({
      ...first.operation,
      expectedRevision: first.operation.revision,
      status: "succeeded",
      providerOperationId: "confirmed-provider-operation",
      resultJson: JSON.stringify({
        images: [{ filename: "actual-fixture.png" }],
      }),
      updatedAt: new Date().toISOString(),
    });
    assert.equal(observed.operation.status, "succeeded");
    assert.deepEqual(
      await f.first.loadExternalOperation(input),
      observed.operation,
    );
  },
);

test(
  "PostgreSQL paid dispatch rejects approval, suspension and reconciliation until the original Run resumes",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    for (const change of [
      {
        type: "run.approval.required" as const,
        data: {
          approvalId: "fixture-approval",
          actionDigest: extensionStoreDigester.sha256("approval"),
        },
      },
      {
        type: "run.suspended" as const,
        data: { reasonCode: "fixture-suspended" },
      },
      {
        type: "run.reconciliation.required" as const,
        data: { receiptId: "fixture-reconciliation" },
      },
    ]) {
      await f.commitEvent(change);
      await assert.rejects(
        f.first.reserveExternalOperation(f.operation()),
        denied,
      );
      assert.equal(await f.count("extension_external_operations"), 0);
      await f.commitEvent({
        type: "run.resumed",
        data: { reasonCode: "fixture-resume" },
      });
    }
    assert.equal(
      (await f.first.reserveExternalOperation(f.operation())).disposition,
      "created",
    );
  },
);

for (const terminal of ["failed", "completed", "canceled"] as const)
  test(
    `PostgreSQL paid dispatch rejects ${terminal} and preserves original credits`,
    options,
    async (t) => {
      const f = await postgresPaidOperationFixture(t);
      await f.start();
      const before = await f.credits.getAccount(f.admission.reservation.scope);
      if (terminal === "failed")
        await f.commitEvent({
          type: "run.failed",
          data: { code: "fixture-failure", retryable: false },
        });
      else if (terminal === "completed")
        await f.commitEvent({
          type: "run.completed",
          data: { outputRef: null },
        });
      else {
        await f.commitEvent({
          type: "run.cancel.requested",
          data: { actorId: f.input.binding.actorId },
        });
        await assert.rejects(
          f.first.reserveExternalOperation(f.operation("cancel-requested")),
          denied,
        );
        await f.commitEvent({
          type: "run.canceled",
          data: { reasonCode: "fixture-cancel" },
        });
      }
      await assert.rejects(
        f.first.reserveExternalOperation(f.operation()),
        denied,
      );
      assert.equal(await f.count("extension_external_operations"), 0);
      assert.deepEqual(
        await f.credits.getAccount(f.admission.reservation.scope),
        before,
      );
    },
  );

test(
  "PostgreSQL paid dispatch checks the actual original identity, binding and quote instead of trusting request digest",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    await assert.rejects(
      f.first.reserveExternalOperation({
        ...f.operation(),
        bindingDigest: extensionStoreDigester.sha256("foreign-binding"),
      }),
      invalid,
    );
    const original = await f.parent.loadRun(f.locator);
    assert.ok(original);
    for (const field of [
      "spaceId",
      "createdByActorId",
      "agentVersionId",
      "authorityId",
      "runtimeGeneration",
      "policySnapshotId",
      "workspaceBindingId",
    ] as const) {
      await f.admin.query(
        `UPDATE ${f.prefix}run_snapshots SET state_json=jsonb_set(state_json,$3::text[],$4::jsonb) WHERE tenant_id=$1 AND run_id=$2`,
        [
          f.locator.tenantId,
          f.locator.runId,
          [field],
          JSON.stringify("foreign"),
        ],
      );
      await assert.rejects(
        f.first.reserveExternalOperation(f.operation()),
        invalid,
      );
      await f.admin.query(
        `UPDATE ${f.prefix}run_snapshots SET state_json=$3 WHERE tenant_id=$1 AND run_id=$2`,
        [f.locator.tenantId, f.locator.runId, original],
      );
    }
    await f.admin.query(
      `UPDATE ${f.prefix}plugin_credit_reservations SET record_json=jsonb_set(record_json,'{quotedCredits}', '"31"'::jsonb) WHERE tenant_id=$1 AND reservation_id=$2`,
      [f.locator.tenantId, f.locator.runId],
    );
    await assert.rejects(
      f.first.reserveExternalOperation(f.operation()),
      invalid,
    );
    assert.equal(await f.count("extension_external_operations"), 0);
  },
);

test(
  "PostgreSQL paid receipt prevents a missing credit-admission row or schema from reopening free dispatch",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    await f.admin.query(
      `ALTER TABLE ${f.prefix}extension_credit_admissions RENAME TO retained_credit_admissions`,
    );
    await assert.rejects(
      f.first.reserveExternalOperation(f.operation("missing-schema")),
      invalid,
    );
    await f.admin.query(
      `ALTER TABLE ${f.prefix}retained_credit_admissions RENAME TO extension_credit_admissions`,
    );
    await f.admin.query(
      `DROP TRIGGER extension_credit_admissions_no_update_or_delete ON ${f.prefix}extension_credit_admissions`,
    );
    await f.admin.query(
      `DELETE FROM ${f.prefix}extension_credit_admissions WHERE tenant_id=$1 AND run_id=$2`,
      [f.locator.tenantId, f.locator.runId],
    );
    await assert.rejects(
      f.first.reserveExternalOperation(f.operation("missing-row")),
      invalid,
    );
    await f.admin.query(`DROP TABLE ${f.prefix}extension_credit_admissions`);
    await f.admin.query(
      `DROP TABLE ${f.prefix}extension_credit_schema_version`,
    );
    await assert.rejects(
      f.first.reserveExternalOperation(
        f.operation("both-credit-markers-missing"),
      ),
      invalid,
    );
    assert.equal(await f.count("extension_external_operations"), 0);
  },
);

test(
  "PostgreSQL paid dispatch rejects a hold whose actual personal account no longer contains its reserved amount",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    const scope = f.admission.reservation.scope;
    const before = await f.credits.getAccount(scope);
    assert.ok(before);
    // Deliberate persisted-account corruption, with the arithmetic invariant
    // still valid: no production funding or settlement policy is installed.
    await f.admin.query(
      `UPDATE ${f.prefix}plugin_credit_accounts SET account_json=$4 WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3`,
      [
        scope.tenantId,
        scope.principalId,
        scope.poolId,
        {
          ...before,
          availableCredits: before.grantedCredits,
          reservedCredits: "0",
        },
      ],
    );
    await assert.rejects(
      f.first.reserveExternalOperation(f.operation()),
      invalid,
    );
    assert.equal(await f.count("extension_external_operations"), 0);
  },
);

test(
  "PostgreSQL original Run lock serializes a terminal commit before a new paid dispatch",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    const barrier = await holdPostgresRunLock(f.admin, f.locator);
    let retired = false;
    const terminal = f.commitEvent({
      type: "run.failed",
      data: { code: "fixture-before-dispatch", retryable: false },
    });
    void terminal.catch(() => {});
    let dispatch: ReturnType<typeof f.first.reserveExternalOperation> | null =
      null;
    try {
      const terminalPid = await waitForPostgresBlocker(f.admin, barrier.pid);
      dispatch = f.first.reserveExternalOperation(f.operation());
      void dispatch.catch(() => {});
      const dispatchPid = await waitForPostgresBlocker(
        f.admin,
        barrier.pid,
        terminalPid,
      );
      assert.notEqual(dispatchPid, terminalPid);
      assert.equal(await f.count("extension_external_operations"), 0);
      await retirePostgresBarrier(barrier.client);
      retired = true;
      assert.equal((await terminal).state.status, "failed");
      await assert.rejects(dispatch, denied);
      assert.equal(await f.count("extension_external_operations"), 0);
    } finally {
      if (!retired) await retirePostgresBarrier(barrier.client);
      await Promise.allSettled([
        terminal,
        ...(dispatch === null ? [] : [dispatch]),
      ]);
    }
  },
);

for (const mutation of ["settle", "release"] as const)
  test(
    `PostgreSQL actual personal-account lock makes dispatch wait for ${mutation} and reject the terminal hold`,
    options,
    async (t) => {
      const f = await postgresPaidOperationFixture(t);
      await f.start();
      const barrier = await postgresWriteBarrier(
        f.admin,
        f.prefix,
        "plugin_credit_reservations",
        "UPDATE",
      );
      let retired = false;
      const value = {
        scope: f.admission.reservation.scope,
        reservationId: f.admission.reservation.reservationId,
      };
      const accounting =
        mutation === "settle"
          ? f.credits.settle({ ...value, actualCredits: "12" })
          : f.credits.release(value);
      void accounting.catch(() => {});
      let dispatch: ReturnType<typeof f.first.reserveExternalOperation> | null =
        null;
      try {
        const accountingPid = await waitForPostgresBlocker(
          f.admin,
          barrier.pid,
        );
        dispatch = f.first.reserveExternalOperation(f.operation());
        void dispatch.catch(() => {});
        const dispatchPid = await waitForPostgresBlocker(
          f.admin,
          accountingPid,
        );
        assert.notEqual(dispatchPid, accountingPid);
        assert.equal(await f.count("extension_external_operations"), 0);
        await retirePostgresBarrier(barrier.client);
        retired = true;
        assert.equal(
          (await accounting).state,
          mutation === "settle" ? "settled" : "released",
        );
        await assert.rejects(dispatch, denied);
        assert.equal(await f.count("extension_external_operations"), 0);
        assert.equal(await f.count("plugin_credit_entries"), 3);
      } finally {
        if (!retired) await retirePostgresBarrier(barrier.client);
        await Promise.allSettled([
          accounting,
          ...(dispatch === null ? [] : [dispatch]),
        ]);
      }
    },
  );

test(
  "PostgreSQL new supplier reservation holds the original Run lock until its durable insert finishes",
  options,
  async (t) => {
    const f = await postgresPaidOperationFixture(t);
    await f.start();
    const barrier = await postgresWriteBarrier(
      f.admin,
      f.prefix,
      "extension_external_operations",
      "INSERT",
    );
    let retired = false;
    const dispatch = f.first.reserveExternalOperation(f.operation());
    void dispatch.catch(() => {});
    let terminal: ReturnType<typeof f.commitEvent> | null = null;
    try {
      const dispatchPid = await waitForPostgresBlocker(f.admin, barrier.pid);
      terminal = f.commitEvent({
        type: "run.failed",
        data: { code: "fixture-after-reservation", retryable: false },
      });
      void terminal.catch(() => {});
      const terminalPid = await waitForPostgresBlocker(f.admin, dispatchPid);
      assert.notEqual(terminalPid, dispatchPid);
      assert.equal(await f.count("extension_external_operations"), 0);
      await retirePostgresBarrier(barrier.client);
      retired = true;
      assert.equal((await dispatch).disposition, "created");
      assert.equal((await terminal).state.status, "failed");
      assert.equal(await f.count("extension_external_operations"), 1);
      assert.equal(
        (await f.credits.getReservation({
          scope: f.admission.reservation.scope,
          reservationId: f.admission.reservation.reservationId,
        }))!.state,
        "reserved",
      );
    } finally {
      if (!retired) await retirePostgresBarrier(barrier.client);
      await Promise.allSettled([
        dispatch,
        ...(terminal === null ? [] : [terminal]),
      ]);
    }
  },
);

test(
  "PostgreSQL operation-only legacy storage stays unpriced and does not migrate credit tables",
  options,
  async (t) => {
    assert.ok(connectionString);
    const schema = `legacy_operation_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString, max: 2 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    t.after(async () => {
      try {
        await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    });
    const store = new PostgresExternalOperationStore(pool, schema);
    await store.migrate();
    const operationId = randomUUID();
    const input = {
      tenantId: "legacy-tenant",
      runId: "legacy-run",
      bindingDigest: extensionStoreDigester.sha256("legacy-binding"),
      operationId,
      correlationId: operationId,
      executionId: "legacy-execution",
      idempotencyKey: "legacy-key",
      actionDigest: extensionStoreDigester.sha256("legacy-action"),
      requestDigest: extensionStoreDigester.sha256("legacy-request"),
      createdAt: new Date().toISOString(),
    };
    assert.equal(
      (await store.reserveExternalOperation(input)).disposition,
      "created",
    );
    assert.equal(
      (await store.reserveExternalOperation(input)).disposition,
      "existing",
    );
    const tables = await pool.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 ORDER BY tablename`,
      [schema],
    );
    assert.deepEqual(
      tables.rows.map((row) => row.name),
      ["extension_external_operations"],
    );
  },
);

for (const creditSchema of ["absent", "migrated"] as const)
  test(
    `PostgreSQL original full unpriced Turn accepts dispatch with ${creditSchema} credit schema without funding or credit writes`,
    options,
    async (t) => {
      const f = await postgresUnpricedOperationFixture(t, creditSchema);
      assert.equal(
        (await f.operations.reserveExternalOperation(f.operation)).disposition,
        "created",
      );
      assert.equal(
        (await f.operations.reserveExternalOperation(f.operation)).disposition,
        "existing",
      );
      assert.equal(await f.count("extension_external_operations"), 1);
      if (creditSchema === "migrated") {
        for (const table of [
          "extension_credit_admissions",
          "plugin_credit_accounts",
          "plugin_credit_reservations",
          "plugin_credit_entries",
        ])
          assert.equal(await f.count(table), 0);
      } else {
        const tables = await f.admin.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname=$1 AND tablename LIKE '%credit%'",
          [f.prefix.slice(1, -2)],
        );
        assert.deepEqual(tables.rows, []);
      }
    },
  );

for (const corruption of [
  "version-only",
  "admissions-only",
  "unknown-version",
  "missing-version-row",
  "version-view",
  "admissions-view",
] as const)
  test(
    `PostgreSQL original unpriced dispatch rejects ${corruption} credit schema without creating an operation`,
    options,
    async (t) => {
      const f = await postgresUnpricedOperationFixture(t, "migrated");
      switch (corruption) {
        case "version-only":
          await f.admin.query(
            `DROP TABLE ${f.prefix}extension_credit_admissions`,
          );
          break;
        case "admissions-only":
          await f.admin.query(
            `DROP TABLE ${f.prefix}extension_credit_schema_version`,
          );
          break;
        case "unknown-version":
          await f.admin.query(
            `UPDATE ${f.prefix}extension_credit_schema_version SET version=9`,
          );
          break;
        case "missing-version-row":
          await f.admin.query(
            `DELETE FROM ${f.prefix}extension_credit_schema_version`,
          );
          break;
        case "version-view":
          await f.admin.query(
            `ALTER TABLE ${f.prefix}extension_credit_schema_version RENAME TO retained_credit_version`,
          );
          await f.admin.query(
            `CREATE VIEW ${f.prefix}extension_credit_schema_version AS SELECT id,version FROM ${f.prefix}retained_credit_version`,
          );
          break;
        case "admissions-view":
          await f.admin.query(
            `ALTER TABLE ${f.prefix}extension_credit_admissions RENAME TO retained_credit_admissions`,
          );
          await f.admin.query(
            `CREATE VIEW ${f.prefix}extension_credit_admissions AS SELECT * FROM ${f.prefix}retained_credit_admissions`,
          );
          break;
      }
      await assert.rejects(
        f.operations.reserveExternalOperation(f.operation),
        invalid,
      );
      assert.equal(await f.count("extension_external_operations"), 0);
      for (const table of [
        "plugin_credit_accounts",
        "plugin_credit_reservations",
        "plugin_credit_entries",
      ])
        assert.equal(await f.count(table), 0);
    },
  );
