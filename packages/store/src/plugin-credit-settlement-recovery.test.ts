import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  PluginCreditSettlementRecoveryPage,
  PluginCreditSettlementRecoveryScan,
} from "@crewon/application";
import { parseSettlementRecoveryScan } from "./plugin-credit-settlement-recovery-records.ts";
import {
  recoveryIndexName,
  recoveryMarkerName,
} from "./plugin-credit-settlement-recovery-schema.ts";
import { sqliteSettlementRecoveryQuery } from "./sqlite-plugin-credit-settlement-recovery.ts";
import { postgresSettlementRecoveryQuery } from "./postgres-plugin-credit-settlement-recovery.ts";
import { settlementRecoveryFixture } from "./plugin-credit-settlement-recovery.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  describe(
    `${backend} explicit installed-credit recovery`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 30_000,
    },
    () => {
      test("pages every original scoped metadata slot, including holds and settled reservations, with bounded byte-order cursors and no financial writes", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        assert.ok(f.input?.creditAdmission);
        await f.fundMore();
        const ids = [
          "recovery-00",
          "recovery-A",
          "recovery-z",
          "recovery-é",
          "recovery-😀",
        ];
        const settled = await f.add(ids[0]!);
        for (const id of ids.slice(1)) await f.add(id);
        await f.add("recovery-01", { otherProfile: true });
        assert.ok(settled.creditAdmission);
        // This is an explicit legacy fixture ledger fact, not a claim of completed execution.
        await f.first.parent.pluginCreditStore().settle({
          scope: settled.creditAdmission.reservation.scope,
          reservationId: settled.creditAdmission.reservation.reservationId,
          actualCredits: "12",
        });
        const before = await f.financialState();
        assert.equal(await f.objectCount(), 0);
        await f.store.migrateRecovery();
        await f.store.migrateRecovery();
        assert.equal(await f.objectCount(), 2);
        const expected = [...ids, f.input.binding.runId].sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        let afterRunId: string | null = null;
        const seen: string[] = [];
        for (let pass = 0; pass < 8; pass++) {
          const page: PluginCreditSettlementRecoveryPage =
            await f.store.scanRecovery({
              scope: f.scope,
              afterRunId,
              limit: 2,
            });
          assert.ok(page.items.length <= 2);
          assert.ok(
            page.items.every((item) => item.tenantId === f.scope.tenantId),
          );
          seen.push(...page.items.map((item) => item.runId));
          if (page.nextRunId === null) break;
          assert.equal(page.nextRunId, page.items.at(-1)!.runId);
          afterRunId = page.nextRunId;
        }
        assert.deepEqual(seen, expected);
        assert.deepEqual(
          await f.store.scanRecovery({
            scope: f.scope,
            afterRunId: expected.at(-1)!,
            limit: 16,
          }),
          { items: [], nextRunId: null },
        );
        assert.deepEqual(
          await f.store.scanRecovery({
            scope: { ...f.scope, profileId: "recovery-other-profile" },
            afterRunId: null,
            limit: 1,
          }),
          {
            items: [{ tenantId: f.scope.tenantId, runId: "recovery-01" }],
            nextRunId: null,
          },
        );
        const reopened = await f.open();
        assert.deepEqual(
          await reopened.parent.pluginCreditSettlementStore().scanRecovery({
            scope: f.scope,
            afterRunId: expected[1]!,
            limit: 16,
          }),
          {
            items: expected
              .slice(2)
              .map((runId) => ({ tenantId: f.scope.tenantId, runId })),
            nextRunId: null,
          },
        );
        const scan: PluginCreditSettlementRecoveryScan = {
          scope: f.scope,
          afterRunId: expected[0]!,
          limit: 2,
        };
        const query =
          backend === "sqlite"
            ? sqliteSettlementRecoveryQuery(scan)
            : postgresSettlementRecoveryQuery(f.schema, scan);
        assert.equal(query.values.at(-1), 3);
        assert.doesNotMatch(
          query.sql,
          /JOIN|NOT EXISTS|plugin_credit_accounts|plugin_credit_reservations|extension_credit_admissions|status|admission_json/iu,
        );
        if (f.database !== null) {
          const plan = f.database
            .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
            .all(...query.values);
          assert.match(
            JSON.stringify(plan),
            new RegExp(recoveryIndexName, "u"),
          );
          assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/iu);
        } else {
          const client = await f.pool!.connect();
          try {
            await client.query("BEGIN");
            // Force the indexed plan for this tiny fixture only; product planner settings remain unchanged.
            await client.query("SET LOCAL enable_seqscan=off");
            const plan = (
              await client.query(
                `EXPLAIN (FORMAT JSON) ${query.sql}`,
                query.values,
              )
            ).rows;
            assert.match(
              JSON.stringify(plan),
              new RegExp(recoveryIndexName, "u"),
            );
            assert.doesNotMatch(JSON.stringify(plan), /"Node Type":"Sort"/u);
            await client.query("COMMIT");
          } finally {
            client.release();
          }
        }
        const originalQueries = f.commands.filter((sql) =>
          sql.startsWith("SELECT tenant_id,space_id,profile_id,run_id FROM"),
        );
        assert.ok(originalQueries.length >= 5);
        assert.ok(
          originalQueries.every(
            (sql) =>
              /LIMIT/u.test(sql) &&
              !/JOIN|NOT EXISTS|plugin_credit_accounts|plugin_credit_reservations|extension_credit_admissions|status|admission_json/iu.test(
                sql,
              ),
          ),
        );
        assert.deepEqual(await f.financialState(), before);
      });

      test("requires original v1 installation metadata without creating a substitute schema", async (t) => {
        const f = await settlementRecoveryFixture(t, backend, { seed: false });
        await assert.rejects(
          f.store.migrateRecovery(),
          /recovery_schema_incomplete/u,
        );
        await assert.rejects(
          f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
          /recovery_schema_incomplete/u,
        );
        assert.equal(await f.objectCount(), 0);
      });

      test("does not migrate over an unsupported original admission version", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        const before = await f.financialState();
        await f.sql(
          `UPDATE ${f.prefix}plugin_task_admission_schema_version SET version=2`,
        );
        await assert.rejects(
          f.store.migrateRecovery(),
          /plugin_task_admission_schema_version_unsupported/u,
        );
        assert.equal(await f.objectCount(), 0);
        assert.deepEqual(await f.financialState(), before);
      });

      test("rejects recovery marker versions while original settlement migration remains independent", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        await f.store.migrateRecovery();
        await f.sql(`UPDATE ${f.prefix}${recoveryMarkerName} SET version=2`);
        await f.store.migrate();
        await assert.rejects(
          f.store.migrateRecovery(),
          /recovery_schema_version_unsupported/u,
        );
        await assert.rejects(
          f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
          /recovery_schema_version_unsupported/u,
        );
      });

      for (const broken of [
        "missing",
        "wrong-columns",
        "wrong-collation",
        "partial",
        "unique",
        "marker-view",
        "admissions-view",
        "original-marker-view",
        "index-table",
        "original-column",
      ] as const) {
        test(`fails closed on ${broken} without scanning substituted metadata or healing partial recovery state`, async (t) => {
          const f = await settlementRecoveryFixture(t, backend);
          await f.store.migrateRecovery();
          const before = await f.financialState();
          const prefix = f.prefix;
          if (broken === "marker-view")
            await f.sql(
              `DROP TABLE ${prefix}${recoveryMarkerName}; CREATE VIEW ${prefix}${recoveryMarkerName} AS SELECT 1 AS id,1 AS version`,
            );
          else if (broken === "admissions-view")
            await f.sql(
              `ALTER TABLE ${prefix}plugin_task_admissions RENAME TO recovery_saved_admissions; CREATE VIEW ${prefix}plugin_task_admissions AS SELECT * FROM ${prefix}recovery_saved_admissions`,
            );
          else if (broken === "original-marker-view")
            await f.sql(
              `ALTER TABLE ${prefix}plugin_task_admission_schema_version RENAME TO recovery_saved_version; CREATE VIEW ${prefix}plugin_task_admission_schema_version AS SELECT 1 AS id,1 AS version`,
            );
          else if (broken === "original-column")
            await f.sql(
              `ALTER TABLE ${prefix}plugin_task_admissions RENAME COLUMN profile_id TO recovery_wrong_profile`,
            );
          else {
            await f.sql(`DROP INDEX ${prefix}${recoveryIndexName}`);
            if (broken === "index-table")
              await f.sql(
                `CREATE TABLE ${prefix}${recoveryIndexName}(id INTEGER)`,
              );
            else if (broken !== "missing") {
              const collation =
                backend === "sqlite"
                  ? broken === "wrong-collation"
                    ? "NOCASE"
                    : "BINARY"
                  : broken === "wrong-collation"
                    ? '"POSIX"'
                    : '"C"';
              const columns =
                broken === "wrong-columns"
                  ? ["run_id", "tenant_id", "space_id", "profile_id"]
                  : ["tenant_id", "space_id", "profile_id", "run_id"];
              const name =
                backend === "sqlite"
                  ? `main.${recoveryIndexName}`
                  : recoveryIndexName;
              await f.sql(
                `CREATE ${broken === "unique" ? "UNIQUE " : ""}INDEX ${name} ON ${prefix}plugin_task_admissions(${columns.map((column) => `${column} COLLATE ${collation}`).join(",")})${broken === "partial" ? " WHERE 1=1" : ""}`,
              );
            }
          }
          const offset = f.commands.length;
          await assert.rejects(
            f.store.scanRecovery({
              scope: f.scope,
              afterRunId: null,
              limit: 1,
            }),
            /recovery_schema_incomplete/u,
          );
          await assert.rejects(
            f.store.migrateRecovery(),
            /recovery_schema_incomplete/u,
          );
          assert.equal(
            f.commands
              .slice(offset)
              .some((sql) =>
                sql.startsWith(
                  "SELECT tenant_id,space_id,profile_id,run_id FROM",
                ),
              ),
            false,
          );
          assert.deepEqual(await f.financialState(), before);
        });
      }

      test("captures the original parent owner fence without executing accessors or allowing function replacement", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        let getterCalls = 0;
        const accessor = Object.defineProperty({}, "assertCurrent", {
          enumerable: true,
          get() {
            getterCalls++;
            return () => {};
          },
        });
        assert.throws(
          () =>
            f.first.parent.pluginCreditSettlementStore(
              accessor as { assertCurrent(): void },
            ),
          /settlement_owner_invalid/u,
        );
        assert.equal(getterCalls, 0);
        let current = true;
        let calls = 0;
        const owner = {
          assertCurrent() {
            calls++;
            if (!current) throw new Error("captured_recovery_owner_retired");
          },
        };
        const store = f.first.parent.pluginCreditSettlementStore(owner);
        assert.equal(calls, 0);
        owner.assertCurrent = () =>
          assert.fail("mutable replacement fence executed");
        await store.migrateRecovery();
        assert.ok(calls > 0);
        current = false;
        const before = await f.financialState();
        await assert.rejects(
          store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
          /captured_recovery_owner_retired/u,
        );
        assert.deepEqual(await f.financialState(), before);
      });

      test("withdrawal after physical migration writes but before COMMIT rolls back marker and index", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        const before = await f.financialState();
        f.withdrawAfterPhysical("migration");
        await assert.rejects(
          f.store.migrateRecovery(),
          /recovery_fixture_owner_retired/u,
        );
        assert.ok(
          f.commands.some(
            (sql) =>
              sql.includes("CREATE INDEX") && sql.includes(recoveryIndexName),
          ),
        );
        assert.ok(f.commands.includes("ROLLBACK"));
        assert.equal(f.commands.includes("COMMIT"), false);
        assert.equal(await f.objectCount(), 0);
        assert.deepEqual(await f.financialState(), before);
        f.resetOwner();
        await f.store.migrateRecovery();
      });

      test("withdrawal after the physical bounded scan rejects before COMMIT and leaves original accounts/events unchanged", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        await f.store.migrateRecovery();
        const before = await f.financialState();
        f.withdrawAfterPhysical("scan");
        await assert.rejects(
          f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
          /recovery_fixture_owner_retired/u,
        );
        assert.ok(
          f.commands.some((sql) =>
            sql.startsWith("SELECT tenant_id,space_id,profile_id,run_id FROM"),
          ),
        );
        assert.ok(f.commands.includes("ROLLBACK"));
        assert.equal(f.commands.includes("COMMIT"), false);
        assert.deepEqual(await f.financialState(), before);
      });

      test("confirmed physical COMMIT remains successful when owner withdrawal races its response", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        assert.ok(f.input);
        const before = await f.financialState();
        f.withdrawAfterPhysical("commit");
        await f.store.migrateRecovery();
        assert.equal(await f.objectCount(), 2);
        assert.ok(f.commands.includes("COMMIT"));
        assert.equal(f.commands.includes("ROLLBACK"), false);
        f.resetOwner();
        f.withdrawAfterPhysical("commit");
        assert.deepEqual(
          await f.store.scanRecovery({
            scope: f.scope,
            afterRunId: null,
            limit: 1,
          }),
          {
            items: [
              { tenantId: f.scope.tenantId, runId: f.input.binding.runId },
            ],
            nextRunId: null,
          },
        );
        assert.ok(f.commands.includes("COMMIT"));
        assert.equal(f.commands.includes("ROLLBACK"), false);
        await assert.rejects(
          f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
          /recovery_fixture_owner_retired/u,
        );
        assert.deepEqual(await f.financialState(), before);
      });

      test("rejects accessor scan commands before SQL and snapshots the valid mutable caller scope", async (t) => {
        const f = await settlementRecoveryFixture(t, backend);
        await f.store.migrateRecovery();
        const offset = f.commands.length;
        let getterCalls = 0;
        const bad = Object.defineProperty(
          { scope: f.scope, limit: 1 },
          "afterRunId",
          {
            enumerable: true,
            get() {
              getterCalls++;
              return null;
            },
          },
        );
        await assert.rejects(
          f.store.scanRecovery(bad as PluginCreditSettlementRecoveryScan),
          /recovery_scan_invalid/u,
        );
        assert.equal(getterCalls, 0);
        assert.equal(f.commands.length, offset);
        for (const limit of [0, 17, 1.5, Number.NaN])
          await assert.rejects(
            f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit }),
            /recovery_scan_invalid/u,
          );
        const source = { scope: { ...f.scope }, afterRunId: null, limit: 1 };
        const parsed = parseSettlementRecoveryScan(source);
        source.scope.profileId = "another-profile";
        assert.equal(parsed.scope.profileId, f.scope.profileId);
        assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.scope));
      });
    },
  );
}

test("SQLite recovery rejects temp shadows of the original admission metadata", async (t) => {
  const f = await settlementRecoveryFixture(t, "sqlite");
  await f.store.migrateRecovery();
  assert.ok(f.database);
  f.database.exec(
    "CREATE TEMP VIEW plugin_task_admissions AS SELECT 'forged' AS tenant_id,'forged' AS space_id,'forged' AS profile_id,'forged' AS run_id",
  );
  await assert.rejects(
    f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
    /recovery_schema_incomplete/u,
  );
  await assert.rejects(
    f.store.migrateRecovery(),
    /recovery_schema_incomplete/u,
  );
});

test(
  "PostgreSQL recovery rejects a physically invalid index left by a failed concurrent build",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await settlementRecoveryFixture(t, "postgres");
    await f.add("recovery-invalid-index-duplicate-scope");
    await f.store.migrateRecovery();
    const before = await f.financialState();
    await f.sql(`DROP INDEX ${f.prefix}${recoveryIndexName}`);
    // The duplicate scope is a real original admission; the failed DDL leaves an invalid physical index.
    await assert.rejects(
      f.pool!.query(
        `CREATE UNIQUE INDEX CONCURRENTLY ${recoveryIndexName} ON ${f.prefix}plugin_task_admissions(tenant_id COLLATE "C",space_id COLLATE "C",profile_id COLLATE "C")`,
      ),
      /duplicate|unique/iu,
    );
    const physical = (
      await f.pool!.query<{ valid: boolean }>(
        "SELECT i.indisvalid AS valid FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2",
        [f.schema, recoveryIndexName],
      )
    ).rows;
    assert.equal(physical.length, 1);
    assert.equal(physical[0]!.valid, false);
    await assert.rejects(
      f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
      /recovery_schema_incomplete/u,
    );
    await assert.rejects(
      f.store.migrateRecovery(),
      /recovery_schema_incomplete/u,
    );
    assert.deepEqual(await f.financialState(), before);
  },
);

test(
  "PostgreSQL recovery rejects a four-column C index with a different comparison opclass",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await settlementRecoveryFixture(t, "postgres");
    await f.store.migrateRecovery();
    const before = await f.financialState();
    await f.sql(
      `DROP INDEX ${f.prefix}${recoveryIndexName}; CREATE INDEX ${recoveryIndexName} ON ${f.prefix}plugin_task_admissions(tenant_id COLLATE "C" pg_catalog.text_pattern_ops,space_id COLLATE "C" pg_catalog.text_pattern_ops,profile_id COLLATE "C" pg_catalog.text_pattern_ops,run_id COLLATE "C" pg_catalog.text_pattern_ops)`,
    );
    const offset = f.commands.length;
    await assert.rejects(
      f.store.scanRecovery({ scope: f.scope, afterRunId: null, limit: 1 }),
      /recovery_schema_incomplete/u,
    );
    await assert.rejects(
      f.store.migrateRecovery(),
      /recovery_schema_incomplete/u,
    );
    assert.equal(
      f.commands
        .slice(offset)
        .some((sql) =>
          sql.startsWith("SELECT tenant_id,space_id,profile_id,run_id FROM"),
        ),
      false,
    );
    assert.deepEqual(await f.financialState(), before);
  },
);
