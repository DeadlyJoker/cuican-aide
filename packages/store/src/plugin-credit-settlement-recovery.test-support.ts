import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import { extensionFixture } from "./extension-store.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { seedProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";
import { SqlitePluginCreditSettlementStore } from "./sqlite-plugin-credit-settlement-store.ts";
import { PostgresPluginCreditSettlementStore } from "./postgres-plugin-credit-settlement-store.ts";
import {
  recoveryIndexName,
  recoveryMarkerName,
} from "./plugin-credit-settlement-recovery-schema.ts";

export type RecoveryBackend = "sqlite" | "postgres";
type Row = Record<string, unknown>;
type Withdrawal = "migration" | "scan" | "commit";

/** Original installed admissions and explicitly named test funding; no synthetic terminal execution. */
export async function settlementRecoveryFixture(
  t: TestContext,
  backend: RecoveryBackend,
  options: Readonly<{ seed?: boolean }> = {},
) {
  const f = await extensionFixture(t, backend, { maxPoolSize: 1 });
  const input = options.seed === false ? null : await seedProbeAdmission(f);
  const schema = backend === "postgres" ? f.prefix.slice(1, -2) : "";
  const database =
    backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
          max: 1,
        })
      : null;
  t.after(async () => {
    database?.close();
    if (pool !== null) await pool.end();
  });
  let current = true;
  let withdraw: Withdrawal | null = null;
  const commands: string[] = [];
  const assertCurrent = () => {
    if (!current) throw new Error("recovery_fixture_owner_retired");
  };
  const afterPhysical = (sql: string) => {
    commands.push(sql.trim());
    if (
      withdraw !== null &&
      (withdraw === "commit"
        ? sql.trim() === "COMMIT"
        : withdraw === "migration"
          ? sql.includes(`CREATE INDEX`) && sql.includes(recoveryIndexName)
          : sql.startsWith("SELECT tenant_id,space_id,profile_id,run_id FROM"))
    ) {
      current = false;
      withdraw = null;
    }
  };
  const controlledDatabase =
    database === null
      ? null
      : new Proxy(database, {
          get(target, property) {
            if (property === "exec")
              return (sql: string) => {
                const result = target.exec(sql);
                afterPhysical(sql);
                return result;
              };
            if (property === "prepare")
              return (sql: string) => {
                const statement = target.prepare(sql);
                return new Proxy(statement, {
                  get(prepared, key) {
                    const value: unknown = Reflect.get(prepared, key, prepared);
                    if (key === "all")
                      return (...values: (string | number | null)[]) => {
                        const rows = prepared.all(...values);
                        afterPhysical(sql);
                        return rows;
                      };
                    return typeof value === "function"
                      ? value.bind(prepared)
                      : value;
                  },
                });
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
  const controlledPool =
    pool === null
      ? null
      : new Proxy(pool, {
          get(target, property) {
            if (property === "connect")
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, key) {
                    if (key === "query")
                      return async (sql: string, values?: unknown[]) => {
                        const result = await connection.query(sql, values);
                        afterPhysical(sql);
                        return result;
                      };
                    const value: unknown = Reflect.get(
                      connection,
                      key,
                      connection,
                    );
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
  const store =
    controlledDatabase !== null
      ? new SqlitePluginCreditSettlementStore({
          database: controlledDatabase,
          assertOpen: assertCurrent,
        })
      : new PostgresPluginCreditSettlementStore({
          pool: controlledPool!,
          schema,
          assertOpen: assertCurrent,
        });
  const rows = async (
    sql: string,
    values: (string | number)[] = [],
  ): Promise<Row[]> =>
    database !== null
      ? (database.prepare(sql).all(...values) as Row[])
      : ((await pool!.query(sql, values)).rows as Row[]);
  const objectCount = async () =>
    database !== null
      ? (
          await rows(
            "SELECT name,type FROM main.sqlite_master WHERE name IN(?,?) ORDER BY name",
            [recoveryMarkerName, recoveryIndexName],
          )
        ).length
      : Number(
          (
            await pool!.query<{ count: string }>(
              "SELECT count(*) AS count FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])",
              [schema, [recoveryMarkerName, recoveryIndexName]],
            )
          ).rows[0]!.count,
        );
  const financialState = async () => {
    const state: Record<string, Row[]> = {};
    const order = {
      plugin_credit_accounts: "tenant_id,principal_id,pool_id",
      plugin_credit_reservations:
        "tenant_id,principal_id,pool_id,reservation_id",
      plugin_credit_entries: "tenant_id,principal_id,pool_id,revision",
      run_events: "tenant_id,run_id,sequence",
      run_snapshots: "tenant_id,run_id",
      outbox: "tenant_id,message_id",
      work_items: "tenant_id,work_item_id",
    };
    for (const [table, keys] of Object.entries(order))
      state[table] = await rows(
        `SELECT * FROM ${f.prefix}${table} ORDER BY ${keys} LIMIT 128`,
      );
    return state;
  };
  const add = async (
    runId: string,
    options: Readonly<{ otherProfile?: boolean }> = {},
  ) => {
    assert.ok(input?.pluginAdmission);
    assert.ok(input.creditAdmission);
    let pin = input.pluginAdmission;
    if (options.otherProfile === true) {
      const actor = {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        actorId: pin.actorId,
        principalId: pin.principalId,
      };
      const profile = {
        tenantId: pin.tenantId,
        spaceId: pin.spaceId,
        profileId: "recovery-other-profile",
      };
      const installs = f.first.parent.pluginInstallationStore();
      const recipe = installationRecipe(`recovery-install-${runId}`, {
        scope: profile,
        actor,
        pluginId: pin.pluginId,
      });
      const installed = await installs.recordInstalledPackage(recipe);
      const enabled = await installs.commitSelection(
        selectionRecipe(installed.selection, `recovery-enable-${runId}`, {
          actor,
        }),
      );
      pin = parsePluginTaskAdmission({
        ...pin,
        ...profile,
        packageDigest: recipe.package.packageDigest,
        publisherId: recipe.package.publisherId,
        version: recipe.package.version,
        selectionRevision: enabled.selection.revision,
      });
    }
    const base = extensionTurnInput(runId);
    await f.prepare({
      ...base,
      commit: {
        ...base.turn.run,
        tenantId: base.turn.tenantId,
        idempotency: base.turn.idempotency,
      },
    });
    const next: CommitExtensionTurnInput = {
      ...base,
      pluginAdmission: parsePluginTaskAdmission({
        ...pin,
        runId: base.binding.runId,
        threadId: base.binding.threadId,
        extensionBindingDigest: base.binding.bindingDigest,
        requestDigest: base.receipt.requestDigest,
        idempotencyKey: base.receipt.idempotencyKey,
      }),
      creditAdmission: createExtensionCreditAdmission(
        {
          binding: base.binding,
          receipt: base.receipt,
          principalId: pin.principalId,
          poolId: input.creditAdmission.reservation.scope.poolId,
          priceRevision: 1,
          quotedCredits: "30",
        },
        extensionStoreDigester,
      ),
    };
    await f.first.store.commitExtensionTurn(next);
    return next;
  };
  const fundMore = async () => {
    assert.ok(input?.creditAdmission);
    await f.first.parent.pluginCreditStore().grant({
      scope: input.creditAdmission.reservation.scope,
      grantId: "recovery-only-named-fixture-funding",
      credits: "900",
    });
  };
  const scope =
    input?.pluginAdmission === undefined
      ? { tenantId: "tenant-1", spaceId: "space-1", profileId: "probe-profile" }
      : {
          tenantId: input.pluginAdmission.tenantId,
          spaceId: input.pluginAdmission.spaceId,
          profileId: input.pluginAdmission.profileId,
        };
  return {
    ...f,
    input,
    schema,
    database,
    pool,
    store,
    rows,
    scope,
    financialState,
    objectCount,
    add,
    fundMore,
    resetOwner() {
      current = true;
    },
    retireOwner() {
      current = false;
    },
    withdrawAfterPhysical(point: Withdrawal) {
      withdraw = point;
      commands.length = 0;
    },
    commands,
  };
}
