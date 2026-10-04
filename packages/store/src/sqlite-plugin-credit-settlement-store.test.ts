import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { PluginCreditSettlementStore } from "@crewon/application";
import { SqlitePluginCreditSettlementStore } from "./sqlite-plugin-credit-settlement-store.ts";
import {
  sqliteSettlementFixture,
  settlementDecision,
} from "./sqlite-plugin-credit-settlement.test-support.ts";
import { paidExternalOperationFixture } from "./sqlite-external-operation-credit.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

test("SQLite settlement construction neither opens the host nor creates or funds storage", async () => {
  const database = new DatabaseSync(":memory:");
  database.close();
  let calls = 0;
  const store = new SqlitePluginCreditSettlementStore({
    database,
    assertOpen() {
      calls += 1;
      throw new Error("fixture_host_closed");
    },
  });
  assert.equal(calls, 0);
  await assert.rejects(store.migrate(), /fixture_host_closed/u);
  assert.equal(calls, 1);
});

test("SQLite explicit settlement migration adds only its own schema and rejects future versions", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA user_version=99");
    const store = new SqlitePluginCreditSettlementStore({
      database,
      assertOpen() {},
    });
    await store.migrate();
    await store.migrate();
    assert.equal(
      database.prepare("PRAGMA user_version").get()!.user_version,
      99,
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      [
        "plugin_credit_settlement_finalizations",
        "plugin_credit_settlement_schema_version",
      ],
    );
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM plugin_credit_settlement_finalizations",
        )
        .get()!.count,
      0,
    );
    database.exec(
      "UPDATE plugin_credit_settlement_schema_version SET version=2",
    );
    await assert.rejects(
      store.migrate(),
      /plugin_credit_settlement_schema_version_unsupported/u,
    );
    assert.equal(
      database
        .prepare("SELECT version FROM plugin_credit_settlement_schema_version")
        .get()!.version,
      2,
    );
  } finally {
    database.close();
  }
});

test("SQLite host closure before COMMIT rolls migration back and no assertion occurs after COMMIT", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    let calls = 0;
    const interrupted = new SqlitePluginCreditSettlementStore({
      database,
      assertOpen() {
        if (++calls === 2) throw new Error("fixture_host_closed");
      },
    });
    await assert.rejects(interrupted.migrate(), /fixture_host_closed/u);
    assert.equal(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'",
        )
        .get()!.count,
      0,
    );
    calls = 0;
    const committed = new SqlitePluginCreditSettlementStore({
      database,
      assertOpen() {
        calls += 1;
      },
    });
    await committed.migrate();
    assert.equal(calls, 2);
  } finally {
    database.close();
  }
});

test("SQLite settles the real installed paid Run once across parent connections and freezes replay", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.addMutation("completed");
  await f.addOperation("succeeded");
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence?.readyToFinalize);
  assert.match(evidence.installedAdmissionDigest!, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    evidence.scope.principalId,
    f.input.pluginAdmission!.principalId,
  );
  assert.equal(evidence.operations.length, 1);
  assert.equal(evidence.mutationReceipts.length, 1);
  assert.equal(evidence.attempts.length, 1);
  assert.equal(evidence.workItems[0]?.status, "completed");
  const decision = settlementDecision(evidence);
  const results = await Promise.all([
    f.settlement.finalize({ locator: f.locator, decision }),
    f.secondSettlement.finalize({ locator: f.locator, decision }),
  ]);
  assert.deepEqual(results.map((result) => result.disposition).sort(), [
    "committed",
    "replayed",
  ]);
  const first = results[0]!;
  assert.ok("finalization" in first);
  const saved = first.finalization;
  assert.equal(saved.account.availableCredits, "75");
  assert.equal(saved.account.reservedCredits, "0");
  assert.equal(saved.account.spentCredits, "25");
  assert.equal(saved.reservation.state, "settled");
  assert.equal(await f.count("plugin_credit_entries"), 3);
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 1);
  await f.parent.close();
  await f.second.close();
  const reopened = await f.open();
  const reopenedSettlement = reopened.parent.pluginCreditSettlementStore();
  assert.deepEqual(await reopenedSettlement.getFinalization(f.locator), saved);
  await reopened.parent.pluginCreditStore().grant({
    scope: evidence.scope,
    grantId: "later-unrelated-grant-fixture",
    credits: "5",
  });
  assert.deepEqual(
    await reopenedSettlement.finalize({ locator: f.locator, decision }),
    { disposition: "replayed", finalization: saved },
  );
  assert.equal(
    (await reopened.parent.pluginCreditStore().getAccount(evidence.scope))
      ?.availableCredits,
    "80",
  );
  await assert.rejects(
    reopenedSettlement.finalize({
      locator: f.locator,
      decision: { ...decision, authorityRevision: "changed-fixture-policy" },
    }),
    /plugin_credit_settlement_decision_conflict/u,
  );
  await assert.rejects(
    f.sql(
      "UPDATE plugin_credit_settlement_finalizations SET decision_id='replacement'",
    ),
    /plugin_credit_settlement_immutable/u,
  );
  await assert.rejects(
    f.sql("DELETE FROM plugin_credit_settlement_finalizations"),
    /plugin_credit_settlement_immutable/u,
  );
});

test("SQLite releases only an explicit authority decision over complete saved execution evidence", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.addMutation("completed");
  await f.addOperation("failed");
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence?.readyToFinalize);
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.settlement.getFinalization(f.locator), null);
  const result = await f.settlement.finalize({
    locator: f.locator,
    decision: settlementDecision(evidence, { kind: "release" }),
  });
  assert.ok("finalization" in result);
  assert.equal(result.finalization.account.availableCredits, "100");
  assert.equal(result.finalization.account.reservedCredits, "0");
  assert.equal(result.finalization.account.spentCredits, "0");
  assert.equal(result.finalization.reservation.state, "released");
});

test("SQLite terminal Run alone cannot finalize a still leased Work Item, and changed leases require new evidence", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete({ completeWork: false });
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.run.status, "completed");
  assert.equal(evidence.workItems[0]?.status, "leased");
  assert.equal(evidence.readyToFinalize, false);
  const decision = settlementDecision(evidence);
  assert.deepEqual(
    await f.settlement.finalize({ locator: f.locator, decision }),
    { disposition: "not_ready" },
  );
  await f.parent.completeWorkItem(f.lease);
  assert.deepEqual(
    await f.settlement.finalize({ locator: f.locator, decision }),
    { disposition: "evidence_changed" },
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

test("SQLite queued paid admission retains its reservation without a settlement side effect", async (t) => {
  const f = await sqliteSettlementFixture(t, { start: false });
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.readyToFinalize, false);
  assert.deepEqual(
    await f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence),
    }),
    { disposition: "not_ready" },
  );
  assert.equal(await f.count("plugin_credit_entries"), 2);
});

test("SQLite an actually expired original Work Item lease still preserves the paid hold and cannot finalize", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete({ completeWork: false });
  const scope = f.admission.reservation.scope;
  const reservationId = f.admission.reservation.reservationId;
  const beforeAccount = await f.credits.getAccount(scope);
  const beforeReservation = await f.credits.getReservation({
    scope,
    reservationId,
  });
  const expired = await f.expireLease();
  assert.equal(expired.epoch, f.lease.leaseEpoch);
  assert.deepEqual(
    (await f.parent.listPendingWorkItems(1)).map((item) => item.workItemId),
    [f.lease.workItemId],
  );
  await assert.rejects(f.parent.completeWorkItem(f.lease), /lease_expired/u);
  const evidence = await f.secondSettlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.run.status, "completed");
  assert.equal(evidence.workItems[0]?.status, "leased");
  assert.equal(evidence.workItems[0]?.leaseEpoch, expired.epoch);
  assert.equal(evidence.readyToFinalize, false);
  assert.deepEqual(
    await f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence, { kind: "release" }),
    }),
    { disposition: "not_ready" },
  );
  assert.deepEqual(await f.credits.getAccount(scope), beforeAccount);
  assert.deepEqual(
    await f.credits.getReservation({ scope, reservationId }),
    beforeReservation,
  );
  assert.equal(beforeAccount?.availableCredits, "70");
  assert.equal(beforeAccount?.reservedCredits, "30");
  assert.equal(beforeAccount?.spentCredits, "0");
  assert.equal(beforeReservation?.state, "reserved");
  assert.equal(await f.count("plugin_credit_entries"), 2);
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

for (const status of [
  "prepared",
  "dispatched",
  "unknownOutcome",
  "canceled",
] as const) {
  test(`SQLite ${status} mutation evidence cannot be finalized despite terminal Run and completed Work Item`, async (t) => {
    const f = await sqliteSettlementFixture(t);
    const receipt = await f.addMutation(status);
    await f.complete();
    const evidence = await f.settlement.loadEvidence(f.locator);
    assert.ok(evidence);
    assert.equal(evidence.mutationReceipts[0]?.status, status);
    if (status === "canceled") assert.ok(receipt.dispatchedAt);
    assert.equal(evidence.readyToFinalize, false);
    assert.deepEqual(
      await f.settlement.finalize({
        locator: f.locator,
        decision: settlementDecision(evidence, { kind: "release" }),
      }),
      { disposition: "not_ready" },
    );
    assert.equal(
      (await f.credits.getAccount(evidence.scope))?.reservedCredits,
      "30",
    );
    assert.equal(await f.count("plugin_credit_entries"), 2);
  });
}

test("SQLite a canceled mutation that was never dispatched remains explicit complete evidence", async (t) => {
  const f = await sqliteSettlementFixture(t);
  const receipt = await f.addMutation("canceled", { dispatch: false });
  assert.equal(receipt.dispatchedAt, null);
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence?.readyToFinalize);
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

test("SQLite a running original Attempt blocks financial finalization", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.addMutation("completed", { finishAttempt: false });
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.attempts[0]?.status, "running");
  assert.equal(evidence.readyToFinalize, false);
  assert.deepEqual(
    await f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence),
    }),
    { disposition: "not_ready" },
  );
});

test("SQLite original operation reconciliation changes the evidence and cannot reuse an earlier decision", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.addMutation("completed");
  const operation = await f.addOperation();
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.readyToFinalize, false);
  const decision = settlementDecision(evidence);
  assert.deepEqual(
    await f.settlement.finalize({ locator: f.locator, decision }),
    { disposition: "not_ready" },
  );
  await f.second.externalOperationStore().advanceExternalOperation({
    ...f.locator,
    bindingDigest: f.input.binding.bindingDigest,
    operationId: operation.operationId,
    expectedRevision: operation.revision,
    status: "succeeded",
    providerOperationId: "settlement-provider-operation-fixture",
    resultJson: '{"artifact":"reconciled-fixture-result"}',
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.deepEqual(
    await f.settlement.finalize({ locator: f.locator, decision }),
    { disposition: "evidence_changed" },
  );
  const current = await f.settlement.loadEvidence(f.locator);
  assert.ok(current?.readyToFinalize);
  assert.equal(
    (
      await f.settlement.finalize({
        locator: f.locator,
        decision: settlementDecision(current),
      })
    ).disposition,
    "committed",
  );
});

test("SQLite finalization insertion failure rolls account, hold and ledger entry back atomically", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence?.readyToFinalize);
  const before = await f.credits.getAccount(evidence.scope);
  await f.sql(
    "CREATE TRIGGER fixture_fail_finalization BEFORE INSERT ON plugin_credit_settlement_finalizations BEGIN SELECT RAISE(ABORT,'fixture_finalization_failure'); END",
  );
  const decision = settlementDecision(evidence);
  await assert.rejects(
    f.settlement.finalize({ locator: f.locator, decision }),
    /fixture_finalization_failure/u,
  );
  assert.deepEqual(await f.credits.getAccount(evidence.scope), before);
  assert.equal(
    (
      await f.credits.getReservation({
        scope: evidence.scope,
        reservationId: evidence.reservationId,
      })
    )?.state,
    "reserved",
  );
  assert.equal(await f.count("plugin_credit_entries"), 2);
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
  await f.sql("DROP TRIGGER fixture_fail_finalization");
  assert.equal(
    (await f.settlement.finalize({ locator: f.locator, decision })).disposition,
    "committed",
  );
});

test("SQLite a paid original receipt cannot become an absent unpriced admission", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  await f.sql(
    "DROP TRIGGER extension_credit_admissions_no_delete; DELETE FROM extension_credit_admissions",
  );
  await assert.rejects(
    f.settlement.loadEvidence(f.locator),
    /plugin_credit_settlement_admission_missing/u,
  );
  await assert.rejects(
    f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence),
    }),
    /plugin_credit_settlement_admission_missing/u,
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

test("SQLite loss of the v1 historical installation pin preserves the hold and refuses finalization", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete();
  await f.sql(
    "DROP TRIGGER plugin_task_admissions_no_delete; DELETE FROM plugin_task_admissions",
  );
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  assert.equal(evidence.installedAdmissionDigest, null);
  assert.equal(evidence.readyToFinalize, false);
  assert.deepEqual(
    await f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence),
    }),
    { disposition: "not_ready" },
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
});

test("SQLite same Run evidence rejects collection overflow instead of settling a truncated prefix", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.transition(
    "run.cancel.requested",
    { actorId: f.input.binding.actorId },
    Array.from({ length: 64 }, (_, index) => ({
      ...f.locator,
      workItemId: `settlement-overflow-work-fixture-${index}`,
      kind: "run.execute" as const,
      payload: { throughSequence: 3 },
      createdAt: timestamp,
    })),
  );
  assert.equal(await f.count("work_items"), 65);
  await assert.rejects(
    f.settlement.loadEvidence(f.locator),
    /plugin_credit_settlement_collection_overflow/u,
  );
  assert.equal(await f.count("plugin_credit_entries"), 2);
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

test("SQLite a forged terminal supplier record under another binding is rejected, never excluded from evidence", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.addMutation("completed");
  await f.addOperation("succeeded");
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence?.readyToFinalize);
  await f.sql(`UPDATE extension_external_operations SET binding_digest='sha256:${"b".repeat(64)}',
    record_json=json_set(record_json,'$.bindingDigest','sha256:${"b".repeat(64)}')`);
  await assert.rejects(
    f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(evidence),
    }),
    /plugin_credit_settlement_operation_binding_mismatch/u,
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.count("plugin_credit_entries"), 2);
});

test("SQLite an original manual ledger finalization without the immutable decision cannot be adopted", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.complete();
  const evidence = await f.settlement.loadEvidence(f.locator);
  assert.ok(evidence);
  await f.credits.settle({
    scope: evidence.scope,
    reservationId: evidence.reservationId,
    actualCredits: "20",
  });
  const current = await f.settlement.loadEvidence(f.locator);
  assert.ok(current);
  await assert.rejects(
    f.settlement.finalize({
      locator: f.locator,
      decision: settlementDecision(current),
    }),
    /plugin_credit_settlement_unbound_terminal_reservation/u,
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.spentCredits,
    "20",
  );
  assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
});

test("SQLite legacy paid v0 admission remains observable without new financial behavior", async (t) => {
  const f = await paidExternalOperationFixture(t);
  const settlement = f.parent.pluginCreditSettlementStore();
  await settlement.migrate();
  const locator = { tenantId: f.binding.tenantId, runId: f.binding.runId };
  await f.transition("run.completed", { outputRef: null });
  const evidence = await settlement.loadEvidence(locator);
  assert.ok(evidence);
  assert.equal(evidence.installedAdmissionDigest, null);
  assert.equal(evidence.readyToFinalize, false);
  assert.deepEqual(
    await settlement.finalize({
      locator,
      decision: settlementDecision(evidence),
    }),
    { disposition: "not_ready" },
  );
  assert.equal(
    (await f.credits.getAccount(evidence.scope))?.reservedCredits,
    "30",
  );
  assert.equal(await f.count("plugin_credit_entries"), 2);
});

for (const marker of [
  "plugin_credit_settlement_schema_version",
  "extension_credit_schema_version",
  "plugin_credit_schema_version",
  "plugin_task_admission_schema_version",
] as const) {
  test(`SQLite settlement refuses the future ${marker} marker`, async (t) => {
    const f = await sqliteSettlementFixture(t);
    await f.complete();
    await f.sql(`UPDATE ${marker} SET version=2`);
    await assert.rejects(
      f.settlement.loadEvidence(f.locator),
      /schema_version_unsupported/u,
    );
    assert.equal(await f.count("plugin_credit_entries"), 2);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
  });
}

test("SQLite settlement does not execute accessors in a supplied commit input", async (t) => {
  const f = await sqliteSettlementFixture(t);
  let calls = 0;
  const input = {
    get locator() {
      calls += 1;
      return f.locator;
    },
    decision: {},
  } as Parameters<PluginCreditSettlementStore["finalize"]>[0];
  await assert.rejects(
    f.settlement.finalize(input),
    /plugin_credit_settlement_input_invalid/u,
  );
  assert.equal(calls, 0);
  assert.equal(await f.count("plugin_credit_entries"), 2);
});

test("SQLite original parent closure invalidates the borrowed settlement adapter", async (t) => {
  const f = await sqliteSettlementFixture(t);
  await f.parent.close();
  await assert.rejects(f.settlement.loadEvidence(f.locator), /store_closed/u);
});
