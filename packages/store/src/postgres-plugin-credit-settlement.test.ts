import assert from "node:assert/strict";
import test from "node:test";
import {
  namedSettlementDecision,
  postgresSettlementFixture,
  waitForSettlementRowWaiter,
} from "./postgres-plugin-credit-settlement.test-support.ts";
import {
  postgresWriteBarrier,
  retirePostgresBarrier,
  waitForPostgresBlocker,
} from "./postgres-paid-operation-dispatch.test-support.ts";

const options = {
  skip: !process.env.CREWON_TEST_POSTGRES_URL
    ? "requires real CREWON_TEST_POSTGRES_URL"
    : false,
  timeout: 25_000,
};

test(
  "PostgreSQL settlement has no default charge and refuses an active Run or lease",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const before = await f.financialState();
    const pending = await f.first.loadEvidence(f.locator);
    assert.ok(pending);
    assert.equal(pending.readyToFinalize, false);
    assert.deepEqual(
      await f.first.finalize({
        locator: f.locator,
        decision: namedSettlementDecision(pending, { kind: "release" }),
      }),
      { disposition: "not_ready" },
    );
    const current = await f.startWithLease();
    await f.commitEvent({ type: "run.completed", data: { outputRef: null } });
    const leased = await f.first.loadEvidence(f.locator);
    assert.ok(leased);
    assert.equal(leased.readyToFinalize, false);
    assert.deepEqual(
      await f.first.finalize({
        locator: f.locator,
        decision: namedSettlementDecision(leased),
      }),
      { disposition: "not_ready" },
    );
    assert.deepEqual(await f.financialState(), before);
    await f.parent.completeWorkItem(current.lease);
    assert.equal(
      (await f.first.loadEvidence(f.locator))?.readyToFinalize,
      true,
    );
  },
);

test(
  "PostgreSQL settlement atomically finalizes original mutation evidence once across independent one-connection pools",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const current = await f.mutation();
    const active = await f.first.loadEvidence(f.locator);
    assert.ok(active);
    assert.equal(active.readyToFinalize, false);
    await f.finishMutation(current);
    const evidence = await f.first.loadEvidence(f.locator);
    assert.ok(evidence?.readyToFinalize);
    assert.equal(evidence.installedAdmissionDigest === null, false);
    assert.equal(evidence.operations.length, 1);
    assert.equal(evidence.mutationReceipts.length, 1);
    assert.equal(evidence.attempts.length, 1);
    const decision = namedSettlementDecision(evidence);
    const results = await Promise.all([
      f.first.finalize({ locator: f.locator, decision }),
      f.second.finalize({ locator: f.locator, decision }),
    ]);
    assert.deepEqual(results.map((result) => result.disposition).sort(), [
      "committed",
      "replayed",
    ]);
    assert.ok(
      results[0]!.disposition === "committed" ||
        results[0]!.disposition === "replayed",
    );
    assert.ok(
      results[1]!.disposition === "committed" ||
        results[1]!.disposition === "replayed",
    );
    assert.deepEqual(results[0].finalization, results[1].finalization);
    const finalization = results[0].finalization;
    assert.equal(finalization.account.availableCredits, "88");
    assert.equal(finalization.account.reservedCredits, "0");
    assert.equal(finalization.account.spentCredits, "12");
    assert.equal(finalization.reservation.state, "settled");
    assert.deepEqual(await f.second.getFinalization(f.locator), finalization);
    assert.equal(await f.count("plugin_credit_entries"), 3);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 1);
    await assert.rejects(
      f.first.finalize({
        locator: f.locator,
        decision: { ...decision, outcome: { kind: "release" } },
      }),
      /plugin_credit_settlement_decision_conflict/u,
    );
    await assert.rejects(
      f.admin.query(
        `UPDATE ${f.prefix}plugin_credit_settlement_finalizations SET record_json=record_json WHERE tenant_id=$1 AND run_id=$2`,
        [f.locator.tenantId, f.locator.runId],
      ),
      /plugin_credit_settlement_immutable/u,
    );
    await assert.rejects(
      f.admin.query(
        `DELETE FROM ${f.prefix}plugin_credit_settlement_finalizations WHERE tenant_id=$1 AND run_id=$2`,
        [f.locator.tenantId, f.locator.runId],
      ),
      /plugin_credit_settlement_immutable/u,
    );
    await assert.rejects(
      f.operations.reserveExternalOperation(f.operation("after-finalization")),
      /external_operation_credit_dispatch_denied/u,
    );
    assert.equal(await f.count("extension_external_operations"), 1);
  },
);

test(
  "PostgreSQL explicit release preserves shared personal grants and does not alter original Run or supplier facts",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const run = await f.parent.loadRun(f.locator);
    await f.credits.grant({
      scope: f.admission.reservation.scope,
      grantId: "named-extra-test-funding",
      credits: "10",
    });
    const result = await f.first.finalize({
      locator: f.locator,
      decision: namedSettlementDecision(evidence, { kind: "release" }),
    });
    assert.equal(result.disposition, "committed");
    assert.ok(result.disposition === "committed");
    assert.equal(result.finalization.account.availableCredits, "110");
    assert.equal(result.finalization.account.grantedCredits, "110");
    assert.equal(result.finalization.account.reservedCredits, "0");
    assert.equal(result.finalization.account.spentCredits, "0");
    assert.equal(result.finalization.reservation.state, "released");
    assert.deepEqual(await f.parent.loadRun(f.locator), run);
    assert.equal(await f.count("extension_external_operations"), 0);
    assert.equal(await f.count("plugin_credit_entries"), 4);
  },
);

test(
  "PostgreSQL rejects repricing above the original quote and rolls back all financial rows when finalization insertion fails",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const before = await f.financialState();
    await assert.rejects(
      f.first.finalize({
        locator: f.locator,
        decision: namedSettlementDecision(evidence, {
          kind: "settle",
          actualCredits: "31",
        }),
      }),
      /plugin_credit_quote_exceeded/u,
    );
    assert.deepEqual(await f.financialState(), before);
    const decision = namedSettlementDecision(evidence);
    await f.admin
      .query(`CREATE FUNCTION ${f.prefix}reject_test_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'named_test_finalization_failure'; END $$;
    CREATE TRIGGER reject_test_finalization BEFORE INSERT ON ${f.prefix}plugin_credit_settlement_finalizations FOR EACH ROW EXECUTE FUNCTION ${f.prefix}reject_test_finalization();`);
    try {
      await assert.rejects(
        f.first.finalize({ locator: f.locator, decision }),
        /named_test_finalization_failure/u,
      );
      assert.deepEqual(await f.financialState(), before);
    } finally {
      await f.admin.query(
        `DROP TRIGGER reject_test_finalization ON ${f.prefix}plugin_credit_settlement_finalizations; DROP FUNCTION ${f.prefix}reject_test_finalization();`,
      );
    }
    assert.equal(
      (await f.second.finalize({ locator: f.locator, decision })).disposition,
      "committed",
    );
    assert.equal(await f.count("plugin_credit_entries"), 3);
  },
);

test(
  "PostgreSQL evidence locks the original operation row against its non-advisory CAS writer and rejects stale decisions",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const current = await f.mutation();
    const gate = f.arm("operations");
    const reading = f.first.loadEvidence(f.locator);
    await gate.entered.promise;
    assert.ok(gate.pid);
    const advancing = f.operations.advanceExternalOperation({
      ...current.operation,
      expectedRevision: current.operation.revision,
      status: "running",
      providerOperationId: "named-row-lock-provider",
      resultJson: null,
      updatedAt: new Date().toISOString(),
    });
    try {
      await waitForSettlementRowWaiter(f.admin, gate.pid);
    } finally {
      gate.resume.resolve();
    }
    const evidence = await reading;
    await advancing;
    assert.ok(evidence);
    assert.equal(evidence.operations[0]?.status, "submitting");
    assert.deepEqual(
      await f.second.finalize({
        locator: f.locator,
        decision: namedSettlementDecision(evidence),
      }),
      { disposition: "evidence_changed" },
    );
    assert.equal(await f.count("plugin_credit_entries"), 2);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
  },
);

test(
  "PostgreSQL evidence locks original queue rows against lease renewal before reading Attempt evidence",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const current = await f.startWithLease();
    const gate = f.arm("workItems");
    const reading = f.first.loadEvidence(f.locator);
    await gate.entered.promise;
    assert.ok(gate.pid);
    const renewal = f.parent.renewWorkItemLease({
      ...current.lease,
      leaseDurationMs: 60_000,
    });
    try {
      await waitForSettlementRowWaiter(f.admin, gate.pid);
    } finally {
      gate.resume.resolve();
    }
    const evidence = await reading;
    await renewal;
    assert.ok(evidence);
    assert.equal(evidence.readyToFinalize, false);
    assert.equal(await f.count("plugin_credit_entries"), 2);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
  },
);

test(
  "PostgreSQL confirmed settlement commit is retained if the host closes while its response is pending",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const decision = namedSettlementDecision(evidence);
    const gate = f.arm("commit");
    const finalizing = f.first.finalize({ locator: f.locator, decision });
    await gate.entered.promise;
    f.closeHost();
    gate.resume.resolve();
    const committed = await finalizing;
    assert.equal(committed.disposition, "committed");
    assert.ok(committed.disposition === "committed");
    assert.deepEqual(
      await f.second.getFinalization(f.locator),
      committed.finalization,
    );
    assert.equal(f.commands.includes("ROLLBACK"), false);
    assert.equal(await f.count("plugin_credit_entries"), 3);
    assert.equal(
      (await f.second.finalize({ locator: f.locator, decision })).disposition,
      "replayed",
    );
    await assert.rejects(
      f.first.loadEvidence(f.locator),
      /settlement_test_host_closed/u,
    );
  },
);

test(
  "PostgreSQL host closure before commit rolls back settlement, hold, ledger entry and immutable decision together",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const before = await f.financialState();
    const decision = namedSettlementDecision(evidence);
    const gate = f.arm("ledger");
    const finalizing = f.first.finalize({ locator: f.locator, decision });
    const rejected = assert.rejects(finalizing, /settlement_test_host_closed/u);
    await gate.entered.promise;
    f.closeHost();
    gate.resume.resolve();
    await rejected;
    assert.equal(f.commands.includes("COMMIT"), false);
    assert.equal(f.commands.includes("ROLLBACK"), true);
    assert.deepEqual(await f.financialState(), before);
    assert.equal(
      (await f.second.finalize({ locator: f.locator, decision })).disposition,
      "committed",
    );
    assert.equal(await f.count("plugin_credit_entries"), 3);
  },
);

test(
  "PostgreSQL settlement requires real complete tables and enabled immutable guards in its exact schema",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const before = await f.financialState();
    await f.admin.query(
      `ALTER TABLE ${f.prefix}plugin_credit_settlement_finalizations DISABLE TRIGGER plugin_credit_settlement_no_update_or_delete`,
    );
    try {
      await assert.rejects(
        f.first.loadEvidence(f.locator),
        /plugin_credit_settlement_schema_incomplete/u,
      );
      await assert.rejects(
        f.first.migrate(),
        /plugin_credit_settlement_schema_incomplete/u,
      );
    } finally {
      await f.admin.query(
        `ALTER TABLE ${f.prefix}plugin_credit_settlement_finalizations ENABLE TRIGGER plugin_credit_settlement_no_update_or_delete`,
      );
    }
    await f.admin
      .query(`ALTER TABLE ${f.prefix}plugin_credit_settlement_finalizations RENAME TO named_test_finalization_table;
    CREATE VIEW ${f.prefix}plugin_credit_settlement_finalizations AS SELECT * FROM ${f.prefix}named_test_finalization_table;`);
    try {
      await assert.rejects(
        f.first.getFinalization(f.locator),
        /plugin_credit_settlement_schema_incomplete/u,
      );
      await assert.rejects(
        f.first.migrate(),
        /plugin_credit_settlement_schema_incomplete/u,
      );
    } finally {
      await f.admin
        .query(`DROP VIEW ${f.prefix}plugin_credit_settlement_finalizations;
      ALTER TABLE ${f.prefix}named_test_finalization_table RENAME TO plugin_credit_settlement_finalizations;`);
    }
    await f.admin.query(
      `UPDATE ${f.prefix}plugin_credit_settlement_schema_version SET version=2 WHERE id=1`,
    );
    try {
      await assert.rejects(
        f.first.migrate(),
        /plugin_credit_settlement_schema_version_unsupported/u,
      );
      assert.equal(
        (
          await f.admin.query(
            `SELECT version FROM ${f.prefix}plugin_credit_settlement_schema_version WHERE id=1`,
          )
        ).rows[0]?.version,
        2,
      );
    } finally {
      await f.admin.query(
        `UPDATE ${f.prefix}plugin_credit_settlement_schema_version SET version=1 WHERE id=1`,
      );
    }
    assert.deepEqual(await f.financialState(), before);
  },
);

test(
  "PostgreSQL settlement rejects outer accessors without executing them and preserves the captured host lifetime",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    let called = false;
    const request = {
      locator: f.locator,
      get decision() {
        called = true;
        return namedSettlementDecision(evidence);
      },
    };
    await assert.rejects(
      f.first.finalize(request),
      /plugin_credit_settlement_record_invalid/u,
    );
    assert.equal(called, false);
    assert.equal(await f.count("plugin_credit_entries"), 2);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
    f.replaceOwnerChecker();
    f.closeHost();
    await assert.rejects(
      f.first.loadEvidence(f.locator),
      /settlement_test_host_closed/u,
    );
  },
);

test(
  "PostgreSQL settlement refuses full matching installed-pin views and partial v1 admission catalogs",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const decision = namedSettlementDecision(evidence);
    const before = await f.financialState();
    for (const name of [
      "plugin_task_admission_schema_version",
      "plugin_task_admissions",
      "installed_plugin_packages",
    ] as const) {
      await f.admin
        .query(`ALTER TABLE ${f.prefix}${name} RENAME TO named_test_real_pin_table;
      CREATE VIEW ${f.prefix}${name} AS SELECT * FROM ${f.prefix}named_test_real_pin_table;`);
      try {
        await assert.rejects(
          f.first.loadEvidence(f.locator),
          /plugin_task_admission_schema_incomplete/u,
        );
        await assert.rejects(
          f.first.finalize({ locator: f.locator, decision }),
          /plugin_task_admission_schema_incomplete/u,
        );
      } finally {
        await f.admin.query(
          `DROP VIEW ${f.prefix}${name}; ALTER TABLE ${f.prefix}named_test_real_pin_table RENAME TO ${name};`,
        );
      }
    }
    await f.admin.query(
      `ALTER TABLE ${f.prefix}plugin_task_admission_schema_version RENAME TO named_test_missing_pin_marker`,
    );
    try {
      await assert.rejects(
        f.first.loadEvidence(f.locator),
        /plugin_task_admission_schema_incomplete/u,
      );
      await assert.rejects(
        f.first.finalize({ locator: f.locator, decision }),
        /plugin_task_admission_schema_incomplete/u,
      );
    } finally {
      await f.admin.query(
        `ALTER TABLE ${f.prefix}named_test_missing_pin_marker RENAME TO plugin_task_admission_schema_version`,
      );
    }
    assert.deepEqual(await f.financialState(), before);
    assert.equal(
      (await f.first.loadEvidence(f.locator))?.readyToFinalize,
      true,
    );
  },
);

test(
  "PostgreSQL settlement refuses every same-schema evidence view before reading projected terminal or financial facts",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const decision = namedSettlementDecision(evidence);
    const before = await f.financialState();
    for (const name of [
      "extension_credit_schema_version",
      "extension_credit_admissions",
      "plugin_credit_schema_version",
      "plugin_credit_accounts",
      "plugin_credit_reservations",
      "plugin_credit_entries",
      "extension_run_bindings",
      "extension_mutation_receipts",
      "run_snapshots",
      "run_thread_bindings",
      "extension_external_operations",
      "tool_execution_receipts",
      "run_steps",
      "run_attempts",
      "work_items",
    ] as const) {
      await f.admin
        .query(`ALTER TABLE ${f.prefix}${name} RENAME TO named_test_real_evidence;
      CREATE VIEW ${f.prefix}${name} AS SELECT * FROM ${f.prefix}named_test_real_evidence;`);
      f.trackQueries();
      try {
        await assert.rejects(
          f.first.loadEvidence(f.locator),
          /plugin_credit_settlement_schema_incomplete/u,
        );
        await assert.rejects(
          f.first.finalize({ locator: f.locator, decision }),
          /plugin_credit_settlement_schema_incomplete/u,
        );
        assert.equal(
          f.commands.some((sql) => sql.includes(`FROM ${f.prefix}${name} `)),
          false,
          `must not SELECT projected ${name} facts`,
        );
      } finally {
        await f.admin.query(
          `DROP VIEW ${f.prefix}${name}; ALTER TABLE ${f.prefix}named_test_real_evidence RENAME TO ${name};`,
        );
      }
    }
    assert.deepEqual(await f.financialState(), before);
    assert.equal(
      (await f.first.loadEvidence(f.locator))?.readyToFinalize,
      true,
    );
  },
);

test(
  "PostgreSQL settlement holds the original account-before-Run fence against a concurrent new supplier reserve",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const { evidence } = await f.ready();
    const gate = f.arm("ledger");
    const settling = f.first.finalize({
      locator: f.locator,
      decision: namedSettlementDecision(evidence),
    });
    await gate.entered.promise;
    assert.ok(gate.pid);
    const denied = assert.rejects(
      f.operations.reserveExternalOperation(f.operation("racing-settlement")),
      /external_operation_credit_dispatch_denied/u,
    );
    try {
      await waitForPostgresBlocker(f.admin, gate.pid);
    } finally {
      gate.resume.resolve();
    }
    assert.equal((await settling).disposition, "committed");
    await denied;
    assert.equal(await f.count("extension_external_operations"), 0);
    assert.equal(await f.count("plugin_credit_entries"), 3);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 1);
    assert.equal(
      (await f.credits.getAccount(f.admission.reservation.scope))?.spentCredits,
      "12",
    );
  },
);

test(
  "PostgreSQL original supplier reserve wins the same fence and stale settlement rechecks its complete new execution evidence",
  options,
  async (t) => {
    const f = await postgresSettlementFixture(t);
    const current = await f.prepareMutation();
    const evidence = await f.first.loadEvidence(f.locator);
    assert.ok(evidence);
    assert.equal(evidence.readyToFinalize, false);
    const before = await f.financialState();
    const barrier = await postgresWriteBarrier(
      f.admin,
      f.prefix,
      "extension_external_operations",
      "INSERT",
    );
    const reserving = f.operations.reserveExternalOperation(
      f.mutationInput(current),
    );
    let settling: ReturnType<typeof f.first.finalize> | undefined;
    try {
      const reservePid = await waitForPostgresBlocker(f.admin, barrier.pid);
      settling = f.first.finalize({
        locator: f.locator,
        decision: namedSettlementDecision(evidence),
      });
      await waitForPostgresBlocker(f.admin, reservePid);
    } finally {
      await retirePostgresBarrier(barrier.client);
    }
    assert.equal((await reserving).disposition, "created");
    assert.ok(settling);
    assert.deepEqual(await settling, { disposition: "evidence_changed" });
    assert.deepEqual(await f.financialState(), before);
    assert.equal(await f.count("extension_external_operations"), 1);
    assert.equal(await f.count("plugin_credit_entries"), 2);
    assert.equal(await f.count("plugin_credit_settlement_finalizations"), 0);
    assert.equal(
      (await f.credits.getAccount(f.admission.reservation.scope))?.spentCredits,
      "0",
    );
  },
);
