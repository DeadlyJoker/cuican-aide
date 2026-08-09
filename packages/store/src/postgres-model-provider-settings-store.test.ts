import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";

import {
  RunStoreError,
  type AbortModelProviderSettingsInput,
  type ExpireModelProviderSettingsInput,
  type FinalizeModelProviderSettingsInput,
  type PrepareModelProviderSettingsInput,
} from "@crewon/application";
import { Pool } from "pg";

import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { PostgresThreadStore } from "./postgres-thread-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { turnStartCommit } from "./turn-start-store-conformance.test-support.ts";
import {
  goalActivation,
  goalFixture,
  goalMutationInput,
} from "./thread-goal-mutation-store-conformance.test-support.ts";

const connectionString = process.env.CREWON_TEST_POSTGRES_URL;

test(
  "Postgres Provider authority requires CREWON_TEST_POSTGRES_URL",
  { skip: connectionString !== undefined },
  () => {},
);

test(
  "PostgresDomainStore adds Provider v1 after an existing Thread v5 schema",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const threads = await PostgresThreadStore.open(fixture.options);
    await threads.close();
    const store = await PostgresDomainStore.open(fixture.options);
    try {
      const versions = await fixture.admin.query<{
        component: string;
        version: number;
      }>(
        `SELECT component, version FROM ${fixture.schemaSql}.schema_migrations
         WHERE component IN ('thread_authority', 'model_provider_settings_authority')
         ORDER BY component`,
      );
      assert.deepEqual(versions.rows, [
        { component: "model_provider_settings_authority", version: 1 },
        { component: "thread_authority", version: 5 },
      ]);
    } finally {
      await store.close();
    }
  },
);

test(
  "Postgres Provider v1 is two-phase and same-key safe across pools",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const first = await PostgresDomainStore.open(fixture.options);
    const second = await PostgresDomainStore.open(fixture.options);
    try {
      const prepared = await Promise.all([
        first.prepareModelProviderSettings(prepareInput()),
        second.prepareModelProviderSettings(prepareInput()),
      ]);
      assert.deepEqual(prepared.map(({ disposition }) => disposition).sort(), [
        "prepared",
        "replayed",
      ]);
      const finalized = await Promise.all([
        first.finalizeModelProviderSettings(finalizeInput()),
        second.finalizeModelProviderSettings(finalizeInput()),
      ]);
      assert.deepEqual(finalized.map(({ disposition }) => disposition).sort(), [
        "finalized",
        "replayed",
      ]);
      assert.deepEqual(finalized[0]?.catalog, finalized[1]?.catalog);

      const next = prepareInput({
        operationId: "operation-2",
        expectedRevision: 1,
        idempotencyKey: "prepare-key-2",
        fingerprint: digest("4"),
      });
      await first.prepareModelProviderSettings(next);
      const abort = abortInput({
        operationId: "operation-2",
        idempotencyKey: "abort-key-2",
        fingerprint: digest("5"),
      });
      const aborted = await Promise.all([
        first.abortModelProviderSettings(abort),
        second.abortModelProviderSettings(abort),
      ]);
      assert.deepEqual(aborted.map(({ disposition }) => disposition).sort(), [
        "aborted",
        "replayed",
      ]);
      assert.deepEqual(aborted[0]?.catalog, aborted[1]?.catalog);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
);

test(
  "Postgres Provider receipt replay never waits for the tenant switch fence",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const store = await PostgresDomainStore.open(fixture.options);
    try {
      const finalized = finalizeInput();
      await store.prepareModelProviderSettings(prepareInput());
      await store.finalizeModelProviderSettings(finalized);

      const abortedPrepare = prepareInput({
        operationId: "operation-aborted",
        expectedRevision: 1,
        idempotencyKey: "prepare-aborted",
        fingerprint: digest("4"),
      });
      const aborted = abortInput({
        operationId: "operation-aborted",
        idempotencyKey: "abort-aborted",
        fingerprint: digest("5"),
      });
      await store.prepareModelProviderSettings(abortedPrepare);
      await store.abortModelProviderSettings(aborted);

      const expiredPrepare = prepareInput({
        operationId: "operation-expired",
        expectedRevision: 1,
        idempotencyKey: "prepare-expired",
        fingerprint: digest("6"),
        ttlMs: 1,
      });
      const expired = expireInput({
        operationId: "operation-expired",
        idempotencyKey: "expire-expired",
        fingerprint: digest("7"),
      });
      await store.prepareModelProviderSettings(expiredPrepare);
      await expireEventually(store, expired);

      const pending = prepareInput({
        operationId: "operation-pending",
        expectedRevision: 1,
        idempotencyKey: "prepare-pending",
        fingerprint: digest("8"),
      });
      await store.prepareModelProviderSettings(pending);

      const release = await holdProviderFence(fixture, "tenant-1");
      const replays = [
        store.prepareModelProviderSettings(pending),
        store.finalizeModelProviderSettings(finalized),
        store.abortModelProviderSettings(aborted),
        store.expireModelProviderSettings(expired),
      ] as const;
      const results = await (async () => {
        try {
          return await Promise.all(replays);
        } finally {
          await release();
        }
      })();
      assert.deepEqual(
        results.map(({ disposition }) => disposition),
        ["replayed", "replayed", "replayed", "replayed"],
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "Postgres Provider pending fence rejects commitTurnStart admission",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const store = await PostgresDomainStore.open(fixture.options);
    try {
      await seedThread(store);
      await store.prepareModelProviderSettings(prepareInput());
      await assert.rejects(
        store.commitTurnStart(turnStartCommit()),
        hasStoreCode("model_provider_settings_switch_pending"),
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "Postgres Provider migration rejects a future component before DDL",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const created = await PostgresDomainStore.open(fixture.options);
    await created.close();
    await fixture.admin.query(
      `UPDATE ${fixture.schemaSql}.schema_migrations SET version=2
       WHERE component='model_provider_settings_authority'`,
    );
    const before = await providerTables(fixture);
    await assert.rejects(
      PostgresDomainStore.open(fixture.options),
      hasStoreCode("postgres_schema_too_new"),
    );
    assert.deepEqual(await providerTables(fixture), before);
    assert.equal(
      (
        await fixture.admin.query<{ version: number }>(
          `SELECT version FROM ${fixture.schemaSql}.schema_migrations
           WHERE component='model_provider_settings_authority'`,
        )
      ).rows[0]?.version,
      2,
    );
  },
);

test(
  "Postgres Provider fence serializes prepare against new Run admission",
  { skip: connectionString === undefined },
  async (t) => {
    const prepareWins = postgresFixture(t);
    const first = await PostgresDomainStore.open(prepareWins.options);
    const second = await PostgresDomainStore.open(prepareWins.options);
    try {
      await seedThread(first);
      const barrier = await holdProviderFence(prepareWins, "tenant-1");
      const baseline = await waitingAdvisoryLocks(prepareWins.admin);
      const prepare = first.prepareModelProviderSettings(prepareInput());
      await waitForAdvisoryLocks(prepareWins.admin, baseline + 1);
      const run = second.commitRun(createRunningCommitFixture());
      await waitForAdvisoryLocks(prepareWins.admin, baseline + 2);
      await barrier();
      assert.equal((await prepare).disposition, "prepared");
      await assert.rejects(
        run,
        hasStoreCode("model_provider_settings_switch_pending"),
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }

    const runWins = postgresFixture(t);
    const third = await PostgresDomainStore.open(runWins.options);
    const fourth = await PostgresDomainStore.open(runWins.options);
    try {
      await seedThread(third);
      const barrier = await holdProviderFence(runWins, "tenant-1");
      const baseline = await waitingAdvisoryLocks(runWins.admin);
      const run = third.commitRun(createRunningCommitFixture());
      await waitForAdvisoryLocks(runWins.admin, baseline + 1);
      const prepare = fourth.prepareModelProviderSettings(prepareInput());
      await waitForAdvisoryLocks(runWins.admin, baseline + 2);
      await barrier();
      assert.equal((await run).disposition, "committed");
      await assert.rejects(
        prepare,
        hasStoreCode("model_provider_settings_active_run"),
      );
    } finally {
      await Promise.all([third.close(), fourth.close()]);
    }
  },
);

test(
  "Postgres Provider fence covers idle Goal activation but allows paused Goal",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const first = await PostgresDomainStore.open(fixture.options);
    const second = await PostgresDomainStore.open(fixture.options);
    try {
      await seedThread(first);
      const barrier = await holdProviderFence(fixture, "tenant-1");
      const baseline = await waitingAdvisoryLocks(fixture.admin);
      const prepare = first.prepareModelProviderSettings(prepareInput());
      await waitForAdvisoryLocks(fixture.admin, baseline + 1);
      const goal = goalFixture();
      const activation = second.commitThreadGoalMutation(
        goalMutationInput({
          idempotencyKey: "provider-goal-race",
          goal: { kind: "set", expectedRevision: null, goal },
          expectedActiveRun: null,
          continuation: goalActivation(goal, 1),
        }),
      );
      await waitForAdvisoryLocks(fixture.admin, baseline + 2);
      await barrier();
      assert.equal((await prepare).disposition, "prepared");
      await assert.rejects(
        activation,
        hasStoreCode("model_provider_settings_switch_pending"),
      );
      const paused = { ...goal, status: "paused" as const };
      assert.equal(
        (
          await second.commitThreadGoalMutation(
            goalMutationInput({
              idempotencyKey: "provider-goal-paused",
              goal: { kind: "set", expectedRevision: null, goal: paused },
              expectedActiveRun: null,
            }),
          )
        ).goalState?.status,
        "paused",
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  },
);

test(
  "Postgres Provider historical replay is independent while head load validates authority",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const store = await PostgresDomainStore.open(fixture.options);
    try {
      await store.prepareModelProviderSettings(prepareInput());
      await store.finalizeModelProviderSettings(finalizeInput());
      await fixture.admin.query(
        `UPDATE ${fixture.schemaSql}.model_provider_settings
         SET active_provider_id='wrong'
         WHERE tenant_id='tenant-1'`,
      );
      await assert.rejects(
        store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
      await fixture.admin.query(
        `DELETE FROM ${fixture.schemaSql}.model_provider_settings
         WHERE tenant_id='tenant-1'`,
      );
      assert.equal(
        (await store.finalizeModelProviderSettings(finalizeInput()))
          .disposition,
        "replayed",
      );
      await assert.rejects(
        store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "Postgres Provider prepare and finalize reject a consistently substituted catalog head",
  { skip: connectionString === undefined },
  async (t) => {
    const prepareFixture = postgresFixture(t);
    const prepareStore = await PostgresDomainStore.open(prepareFixture.options);
    try {
      await prepareStore.prepareModelProviderSettings(prepareInput());
      await prepareStore.finalizeModelProviderSettings(finalizeInput());
      await substitutePostgresCatalogHead(prepareFixture);
      await assert.rejects(
        prepareStore.prepareModelProviderSettings(
          prepareInput({
            operationId: "operation-2",
            expectedRevision: 1,
            idempotencyKey: "prepare-key-2",
            fingerprint: digest("6"),
          }),
        ),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
    } finally {
      await prepareStore.close();
    }

    const finalizeFixture = postgresFixture(t);
    const finalizeStore = await PostgresDomainStore.open(
      finalizeFixture.options,
    );
    try {
      await finalizeStore.prepareModelProviderSettings(prepareInput());
      await finalizeStore.finalizeModelProviderSettings(finalizeInput());
      await finalizeStore.prepareModelProviderSettings(
        prepareInput({
          operationId: "operation-2",
          expectedRevision: 1,
          idempotencyKey: "prepare-key-2",
          fingerprint: digest("6"),
        }),
      );
      await substitutePostgresCatalogHead(finalizeFixture);
      await assert.rejects(
        finalizeStore.finalizeModelProviderSettings(
          finalizeInput({
            operationId: "operation-2",
            idempotencyKey: "finalize-key-2",
            fingerprint: digest("7"),
          }),
        ),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
    } finally {
      await finalizeStore.close();
    }
  },
);

test(
  "Postgres Provider prepare replay rejects a tampered terminal operation envelope",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const store = await PostgresDomainStore.open(fixture.options);
    try {
      await store.prepareModelProviderSettings(prepareInput());
      await store.finalizeModelProviderSettings(finalizeInput());
      await fixture.admin.query(
        `UPDATE ${fixture.schemaSql}.model_provider_settings_operations
         SET result_json = jsonb_set(
           result_json,
           '{completedAt}',
           to_jsonb('2099-01-01T00:00:00.000Z'::text)
         )
         WHERE tenant_id='tenant-1' AND operation_id='operation-1'`,
      );
      await assert.rejects(
        store.prepareModelProviderSettings(prepareInput()),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
    } finally {
      await store.close();
    }
  },
);

test(
  "Postgres Provider migration does not silently heal corrupt v1",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const created = await PostgresDomainStore.open(fixture.options);
    await created.close();
    await fixture.admin.query(
      `DROP TABLE ${fixture.schemaSql}.model_provider_settings_operations`,
    );
    await assert.rejects(
      PostgresDomainStore.open(fixture.options),
      hasStoreCode("postgres_schema_version_unsupported"),
    );
    assert.equal(
      (
        await fixture.admin.query<{ present: boolean }>(
          "SELECT to_regclass($1) IS NOT NULL AS present",
          [`${fixture.schema}.model_provider_settings_operations`],
        )
      ).rows[0]?.present,
      false,
    );
  },
);

test(
  "Postgres Provider v1 rejects a missing unique pending fence index",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const created = await PostgresDomainStore.open(fixture.options);
    await created.close();
    await fixture.admin.query(
      `DROP INDEX ${fixture.schemaSql}.model_provider_settings_pending_tenant_idx`,
    );
    await assert.rejects(
      PostgresDomainStore.open(fixture.options),
      hasStoreCode("postgres_schema_version_unsupported"),
    );
    assert.equal(
      (
        await fixture.admin.query<{ present: boolean }>(
          "SELECT to_regclass($1) IS NOT NULL AS present",
          [`${fixture.schema}.model_provider_settings_pending_tenant_idx`],
        )
      ).rows[0]?.present,
      false,
    );
  },
);

test(
  "Postgres Provider v1 rejects a missing finalized revision authority index",
  { skip: connectionString === undefined },
  async (t) => {
    const fixture = postgresFixture(t);
    const created = await PostgresDomainStore.open(fixture.options);
    await created.close();
    await fixture.admin.query(
      `DROP INDEX ${fixture.schemaSql}.model_provider_settings_finalized_revision_idx`,
    );
    await assert.rejects(
      PostgresDomainStore.open(fixture.options),
      hasStoreCode("postgres_schema_version_unsupported"),
    );
  },
);

function postgresFixture(t: TestContext) {
  const url = requiredConnectionString();
  const schema = `crewon_provider_${randomUUID().replaceAll("-", "")}`;
  const schemaSql = `"${schema}"`;
  const admin = new Pool({ connectionString: url, max: 2 });
  t.after(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaSql} CASCADE`);
    await admin.end();
  });
  return {
    admin,
    schema,
    schemaSql,
    options: {
      connectionString: url,
      schema,
      maxPoolSize: 2,
      statementTimeoutMs: 5_000,
    },
  };
}

async function providerTables(fixture: ReturnType<typeof postgresFixture>) {
  return (
    await fixture.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema=$1 AND table_name LIKE 'model_provider_settings%'
       ORDER BY table_name`,
      [fixture.schema],
    )
  ).rows;
}

async function substitutePostgresCatalogHead(
  fixture: ReturnType<typeof postgresFixture>,
): Promise<void> {
  const substituted = {
    tenantId: "tenant-1",
    revision: 1,
    activeProviderId: "other",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [
      {
        providerId: "other",
        displayName: "Gateway",
        endpoint: "https://other.example/v1",
        credentialKind: "keychain",
        environmentVariable: null,
      },
    ],
    updatedAt: (
      await fixture.admin.query<{ updated_at: Date }>(
        `SELECT updated_at FROM ${fixture.schemaSql}.model_provider_settings
         WHERE tenant_id='tenant-1'`,
      )
    ).rows[0]?.updated_at.toISOString(),
  };
  await fixture.admin.query(
    `UPDATE ${fixture.schemaSql}.model_provider_settings
     SET revision=$1, active_provider_id=$2, catalog_json=$3::jsonb,
         updated_at=$4::timestamptz
     WHERE tenant_id='tenant-1'`,
    [
      substituted.revision,
      substituted.activeProviderId,
      JSON.stringify(substituted),
      substituted.updatedAt,
    ],
  );
}

async function holdProviderFence(
  fixture: ReturnType<typeof postgresFixture>,
  tenantId: string,
): Promise<() => Promise<void>> {
  const client = await fixture.admin.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `provider-settings:${fixture.schemaSql}:${tenantId}`,
  ]);
  return async () => {
    await client.query("COMMIT");
    client.release();
  };
}

async function waitingAdvisoryLocks(pool: Pool): Promise<number> {
  return Number(
    (
      await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM pg_locks
         WHERE locktype='advisory' AND NOT granted`,
      )
    ).rows[0]?.count ?? 0,
  );
}

async function waitForAdvisoryLocks(
  pool: Pool,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if ((await waitingAdvisoryLocks(pool)) >= expected) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("provider_advisory_waiter_timeout");
}

function prepareInput(
  overrides: Partial<PrepareModelProviderSettingsInput> = {},
): PrepareModelProviderSettingsInput {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    expectedRevision: 0,
    activeProviderId: "gateway",
    bindings: [
      {
        providerId: "gateway",
        displayName: "Gateway",
        endpoint: "https://provider.example/v1",
        credentialKind: "keychain",
        environmentVariable: null,
      },
    ],
    idempotencyKey: "prepare-key",
    fingerprint: digest("1"),
    actor: mutationActor(),
    ttlMs: 300_000,
    ...overrides,
  };
}

function finalizeInput(
  overrides: Partial<FinalizeModelProviderSettingsInput> = {},
): FinalizeModelProviderSettingsInput {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    idempotencyKey: "finalize-key",
    fingerprint: digest("2"),
    actor: mutationActor(),
    ...overrides,
  };
}

function abortInput(
  overrides: Partial<AbortModelProviderSettingsInput> = {},
): AbortModelProviderSettingsInput {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    idempotencyKey: "abort-key",
    fingerprint: digest("3"),
    actor: mutationActor(),
    ...overrides,
  };
}

function expireInput(
  overrides: Partial<ExpireModelProviderSettingsInput> = {},
): ExpireModelProviderSettingsInput {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    recoveryBinding: "desktop-supervisor:recovery-1",
    idempotencyKey: "expire-key",
    fingerprint: digest("4"),
    actor: mutationActor(),
    ...overrides,
  };
}

function mutationActor() {
  return {
    principalId: "principal-1",
    actorId: "actor-1",
    spaceId: "space-1",
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function requiredConnectionString(): string {
  if (connectionString === undefined) throw new Error("postgres_url_missing");
  return connectionString;
}

function hasStoreCode(code: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === code;
}

async function expireEventually(
  store: PostgresDomainStore,
  input: ExpireModelProviderSettingsInput,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await store.expireModelProviderSettings(input);
      return;
    } catch (error) {
      if (
        !hasStoreCode("model_provider_settings_operation_not_expired")(error)
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  throw new Error("provider_expiry_deadline_not_reached");
}
