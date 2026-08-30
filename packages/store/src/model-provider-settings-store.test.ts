import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";

import {
  RunStoreError,
  type AbortModelProviderSettingsInput,
  type ExpireModelProviderSettingsInput,
  type FinalizeModelProviderSettingsInput,
  type ModelProviderSettingsStore,
  type PrepareModelProviderSettingsInput,
} from "@crewon/application";

import { InMemoryRunStore } from "./in-memory-run-store.ts";
import type { LeaseClock } from "./lease-clock.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  goalActivation,
  goalFixture,
  goalMutationInput,
} from "./thread-goal-mutation-store-conformance.test-support.ts";
import { commitThreadRollbackFixture } from "./thread-rollback-store-conformance.test-support.ts";
import {
  configureAndMigrateSqlite,
  readUserVersion,
  SQLITE_SCHEMA_VERSION,
} from "./sqlite-schema.ts";

for (const adapter of [
  {
    name: "InMemoryRunStore",
    create: async () => inMemoryProviderTestStore(),
  },
  {
    name: "SqliteRunStore",
    create: async () => sqliteProviderTestStore(":memory:"),
  },
] as const) {
  test(`${adapter.name} commits and replays the two-phase Provider authority`, async () => {
    const store = await adapter.create();
    try {
      const prepared = await store.prepareModelProviderSettings(prepareInput());
      assert.deepEqual(prepared, {
        disposition: "prepared",
        pending: pendingFixture(),
      });
      assert.deepEqual(
        await store.prepareModelProviderSettings(prepareInput()),
        { disposition: "replayed", pending: pendingFixture() },
      );
      assert.deepEqual(
        await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        {
          catalog: null,
          pending: pendingFixture(),
        },
      );

      testClock(store).set("2026-08-09T01:04:00.000Z");
      const finalized =
        await store.finalizeModelProviderSettings(finalizeInput());
      assert.deepEqual(finalized, {
        disposition: "finalized",
        catalog: catalogFixture(),
      });
      assert.deepEqual(
        await store.finalizeModelProviderSettings(finalizeInput()),
        { disposition: "replayed", catalog: catalogFixture() },
      );
      assert.deepEqual(
        await store.prepareModelProviderSettings(prepareInput()),
        { disposition: "replayed", pending: pendingFixture() },
      );
      assert.deepEqual(
        await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        {
          catalog: catalogFixture(),
          pending: null,
        },
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} keeps expired operations fenced until explicit recovery`, async () => {
    const store = await adapter.create();
    try {
      await store.prepareModelProviderSettings(prepareInput());
      testClock(store).set("2026-08-09T00:59:59.999Z");
      await assert.rejects(
        store.finalizeModelProviderSettings(finalizeInput()),
        hasStoreCode("model_provider_settings_operation_time_invalid"),
      );
      testClock(store).set("2026-08-09T01:05:00.001Z");
      await assert.rejects(
        store.finalizeModelProviderSettings(finalizeInput()),
        hasStoreCode("model_provider_settings_operation_expired"),
      );
      assert.deepEqual(
        (await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }))
          .pending,
        pendingFixture(),
      );
      await assert.rejects(
        store.abortModelProviderSettings(
          abortInput({ coordinatorBinding: "wrong-coordinator" }),
        ),
        hasStoreCode("model_provider_settings_operation_mismatch"),
      );
      assert.deepEqual(await store.expireModelProviderSettings(expireInput()), {
        disposition: "expired",
        catalog: null,
      });
      assert.deepEqual(
        await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        {
          catalog: null,
          pending: null,
        },
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} rejects reusing an active runtime binding for a later revision`, async () => {
    const store = await adapter.create();
    try {
      await store.prepareModelProviderSettings(prepareInput());
      testClock(store).set("2026-08-09T01:04:00.000Z");
      await store.finalizeModelProviderSettings(finalizeInput());
      await assert.rejects(
        store.prepareModelProviderSettings(
          prepareInput({
            operationId: "operation-2",
            expectedRevision: 1,
            idempotencyKey: "prepare-key-2",
            fingerprint: digest("5"),
          }),
        ),
        hasStoreCode("model_provider_settings_operation_mismatch"),
      );
      assert.deepEqual(
        await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        { catalog: catalogFixture(), pending: null },
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} rejects forged direct Store input before any write`, async () => {
    const store = await adapter.create();
    try {
      const forged = prepareInput() as PrepareModelProviderSettingsInput & {
        authority: string;
      };
      await assert.rejects(
        store.prepareModelProviderSettings({
          ...forged,
          authority: "browser",
        } as never),
        hasStoreCode("model_provider_settings_input_invalid"),
      );
      const secretBinding = {
        ...prepareInput(),
        bindings: [{ ...bindingFixture(), apiKey: "secret" }],
      } as never;
      await assert.rejects(
        store.prepareModelProviderSettings(secretBinding),
        hasStoreCode("model_provider_settings_input_invalid"),
      );
      for (const environmentVariable of [
        "SECRET_TOKEN",
        "x".repeat(129),
        "SECRET\nTOKEN",
      ]) {
        await assert.rejects(
          store.prepareModelProviderSettings({
            ...prepareInput(),
            bindings: [{ ...bindingFixture(), environmentVariable }],
          }),
          hasStoreCode("model_provider_settings_input_invalid"),
        );
      }
      assert.deepEqual(
        await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        {
          catalog: null,
          pending: null,
        },
      );
      assert.equal(
        (await store.prepareModelProviderSettings(prepareInput())).disposition,
        "prepared",
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} fails closed on same-fingerprint candidate substitution`, async () => {
    const store = await adapter.create();
    try {
      await store.prepareModelProviderSettings(prepareInput());
      await assert.rejects(
        store.prepareModelProviderSettings(
          prepareInput({
            bindings: [
              { ...bindingFixture(), endpoint: "https://other.example/v1" },
            ],
          }),
        ),
        hasStoreCode("model_provider_settings_stored_state_invalid"),
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} fences new Run and idle Goal activation in both race orders`, async () => {
    const prepareFirst = await adapter.create();
    try {
      await seedThread(prepareFirst);
      await prepareFirst.prepareModelProviderSettings(prepareInput());
      await assert.rejects(
        prepareFirst.commitRun(createRunningCommitFixture()),
        hasStoreCode("model_provider_settings_switch_pending"),
      );
      const goal = goalFixture();
      await assert.rejects(
        prepareFirst.commitThreadGoalMutation(
          goalMutationInput({
            idempotencyKey: "goal-provider-fence",
            goal: { kind: "set", expectedRevision: null, goal },
            expectedActiveRun: null,
            continuation: goalActivation(goal, 1),
          }),
        ),
        hasStoreCode("model_provider_settings_switch_pending"),
      );
      const paused = { ...goal, status: "paused" as const };
      assert.equal(
        (
          await prepareFirst.commitThreadGoalMutation(
            goalMutationInput({
              idempotencyKey: "goal-provider-fence-paused",
              goal: { kind: "set", expectedRevision: null, goal: paused },
              expectedActiveRun: null,
            }),
          )
        ).goalState?.status,
        "paused",
      );
    } finally {
      await prepareFirst.close();
    }

    const runFirst = await adapter.create();
    try {
      await seedThread(runFirst);
      await runFirst.commitRun(createRunningCommitFixture());
      await assert.rejects(
        runFirst.prepareModelProviderSettings(prepareInput()),
        hasStoreCode("model_provider_settings_active_run"),
      );
      assert.deepEqual(
        await runFirst.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
        { catalog: null, pending: null },
      );
    } finally {
      await runFirst.close();
    }
  });

  test(`${adapter.name} gives finalize and abort exactly one terminal winner`, async () => {
    const store = await adapter.create();
    try {
      await store.prepareModelProviderSettings(prepareInput());
      const outcomes = await Promise.allSettled([
        store.finalizeModelProviderSettings(finalizeInput()),
        store.abortModelProviderSettings(abortInput()),
      ]);
      assert.equal(
        outcomes.filter(({ status }) => status === "fulfilled").length,
        1,
      );
      assert.equal(
        outcomes.filter(({ status }) => status === "rejected").length,
        1,
      );
      assert.equal(
        (await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }))
          .pending,
        null,
      );
    } finally {
      await store.close();
    }
  });

  test(`${adapter.name} replays historical terminal receipts after a later switch`, async () => {
    const store = await adapter.create();
    try {
      const firstFinalize = finalizeInput();
      await store.prepareModelProviderSettings(prepareInput());
      testClock(store).set("2026-08-09T01:01:00.000Z");
      await store.finalizeModelProviderSettings(firstFinalize);

      const abortedPrepare = prepareInput({
        operationId: "operation-aborted",
        coordinatorBinding: "desktop-supervisor:generation-8",
        expectedRevision: 1,
        idempotencyKey: "prepare-aborted",
        fingerprint: digest("5"),
      });
      const aborted = abortInput({
        operationId: "operation-aborted",
        coordinatorBinding: "desktop-supervisor:generation-8",
        idempotencyKey: "abort-aborted",
        fingerprint: digest("6"),
      });
      await store.prepareModelProviderSettings(abortedPrepare);
      await store.abortModelProviderSettings(aborted);

      const expiredPrepare = prepareInput({
        operationId: "operation-expired",
        coordinatorBinding: "desktop-supervisor:generation-9",
        expectedRevision: 1,
        idempotencyKey: "prepare-expired",
        fingerprint: digest("7"),
      });
      const expired = expireInput({
        operationId: "operation-expired",
        idempotencyKey: "expire-expired",
        fingerprint: digest("8"),
      });
      await store.prepareModelProviderSettings(expiredPrepare);
      testClock(store).set("2026-08-09T01:06:00.001Z");
      await store.expireModelProviderSettings(expired);

      const finalPrepare = prepareInput({
        operationId: "operation-final",
        coordinatorBinding: "desktop-supervisor:generation-10",
        expectedRevision: 1,
        idempotencyKey: "prepare-final",
        fingerprint: digest("9"),
      });
      const finalFinalize = finalizeInput({
        operationId: "operation-final",
        coordinatorBinding: "desktop-supervisor:generation-10",
        idempotencyKey: "finalize-final",
        fingerprint: digest("a"),
      });
      await store.prepareModelProviderSettings(finalPrepare);
      testClock(store).set("2026-08-09T01:07:00.000Z");
      const latest = await store.finalizeModelProviderSettings(finalFinalize);
      assert.equal(latest.catalog.revision, 2);

      assert.equal(
        (await store.finalizeModelProviderSettings(firstFinalize)).disposition,
        "replayed",
      );
      assert.equal(
        (await store.abortModelProviderSettings(aborted)).disposition,
        "replayed",
      );
      assert.equal(
        (await store.expireModelProviderSettings(expired)).disposition,
        "replayed",
      );
      assert.deepEqual(
        (await store.loadModelProviderSettingsState({ tenantId: "tenant-1" }))
          .catalog,
        latest.catalog,
      );
    } finally {
      await store.close();
    }
  });
}

test("SQLite v19 upgrades to Provider authority v20 without losing Thread tables", (t) => {
  const path = sqlitePath(t);
  const database = new DatabaseSync(path);
  configureAndMigrateSqlite(database);
  database.exec(`
    DROP TABLE model_provider_settings_receipts;
    DROP TABLE model_provider_settings_operations;
    DROP TABLE model_provider_settings;
    PRAGMA user_version = 19;
  `);
  database.close();

  const reopened = new DatabaseSync(path);
  configureAndMigrateSqlite(reopened);
  assert.equal(readUserVersion(reopened), SQLITE_SCHEMA_VERSION);
  assert.deepEqual(
    reopened
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type='table'
           AND name IN (
             'threads', 'message_invalidations',
             'model_provider_settings',
             'model_provider_settings_operations',
             'model_provider_settings_receipts'
           )
         ORDER BY name`,
      )
      .all()
      .map((row) => ({ name: String(row.name) })),
    [
      { name: "message_invalidations" },
      { name: "model_provider_settings" },
      { name: "model_provider_settings_operations" },
      { name: "model_provider_settings_receipts" },
      { name: "threads" },
    ],
  );
  reopened.close();
});

test("SQLite v19 to v20 preserves rollback invalidations and receipt views", async (t) => {
  const path = sqlitePath(t);
  const store = sqliteProviderTestStore(path);
  const { input, result } = await commitThreadRollbackFixture(store);
  const beforeStandard = await store.listMessages(
    { tenantId: "tenant-1", threadId: "thread-1" },
    0,
    100,
  );
  const beforeAudit = await store.listMessages(
    { tenantId: "tenant-1", threadId: "thread-1" },
    0,
    100,
    "audit",
  );
  await store.close();

  const database = new DatabaseSync(path);
  database.exec(`
    DROP TABLE model_provider_settings_receipts;
    DROP TABLE model_provider_settings_operations;
    DROP TABLE model_provider_settings;
    PRAGMA user_version = 19;
  `);
  database.close();

  const migrated = sqliteProviderTestStore(path);
  try {
    assert.deepEqual(
      await migrated.listMessages(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
      ),
      beforeStandard,
    );
    assert.deepEqual(
      await migrated.listMessages(
        { tenantId: "tenant-1", threadId: "thread-1" },
        0,
        100,
        "audit",
      ),
      beforeAudit,
    );
    assert.deepEqual(
      await migrated.loadThreadRollbackReceipt({
        tenantId: input.tenantId,
        threadId: input.event.identity.threadId,
        idempotency: input.idempotency,
      }),
      { ...result, disposition: "replayed" },
    );
  } finally {
    await migrated.close();
  }
});

test("SQLite v18 chains rollback, Provider, and Automation migrations once", (t) => {
  const path = sqlitePath(t);
  const database = new DatabaseSync(path);
  configureAndMigrateSqlite(database);
  database.exec(`
    DROP TABLE model_provider_settings_receipts;
    DROP TABLE model_provider_settings_operations;
    DROP TABLE model_provider_settings;
    PRAGMA user_version = 18;
  `);
  configureAndMigrateSqlite(database);
  assert.equal(readUserVersion(database), SQLITE_SCHEMA_VERSION);
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type='table'
         AND name IN ('model_provider_settings_operations', 'automations')
       ORDER BY name`,
    )
    .all() as unknown as { name: string }[];
  assert.deepEqual(
    rows.map(({ name }) => name),
    ["automations", "model_provider_settings_operations"],
  );
  database.close();
});

test("SQLite terminal replay rejects a substituted receipt and operation result", async (t) => {
  const path = sqlitePath(t);
  const store = sqliteProviderTestStore(path);
  await store.prepareModelProviderSettings(prepareInput());
  await store.finalizeModelProviderSettings(finalizeInput());
  await store.close();

  const database = new DatabaseSync(path);
  const substituted = {
    ...catalogFixture(),
    updatedAt: "2026-08-09T01:00:00.000Z",
    activeProviderId: "other",
    bindings: [
      {
        ...bindingFixture(),
        providerId: "other",
        endpoint: "https://other.example/v1",
      },
    ],
  };
  const envelope = JSON.stringify({
    phase: "finalize",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    completedAt: "2026-08-09T01:00:00.000Z",
    actor: mutationActor(),
    value: substituted,
  });
  database
    .prepare(
      `UPDATE model_provider_settings_receipts SET result_json = ?
       WHERE tenant_id='tenant-1' AND phase='finalize'`,
    )
    .run(envelope);
  database
    .prepare(
      `UPDATE model_provider_settings_operations SET result_json = ?
       WHERE tenant_id='tenant-1' AND operation_id='operation-1'`,
    )
    .run(envelope);
  database.close();

  const corrupted = sqliteProviderTestStore(path);
  try {
    await assert.rejects(
      corrupted.finalizeModelProviderSettings(finalizeInput()),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
    await assert.rejects(
      corrupted.prepareModelProviderSettings(prepareInput()),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite prepare replay requires its immutable operation authority", async (t) => {
  const path = sqlitePath(t);
  const store = sqliteProviderTestStore(path);
  await store.prepareModelProviderSettings(prepareInput());
  await store.close();
  const database = new DatabaseSync(path);
  database.exec(
    "DELETE FROM model_provider_settings_operations WHERE tenant_id='tenant-1'",
  );
  database.close();

  const corrupted = sqliteProviderTestStore(path);
  try {
    await assert.rejects(
      corrupted.prepareModelProviderSettings(prepareInput()),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite pending snapshot rejects active catalog drift", async (t) => {
  const path = sqlitePath(t);
  const store = sqliteProviderTestStore(path);
  await store.prepareModelProviderSettings(prepareInput());
  await store.finalizeModelProviderSettings(finalizeInput());
  await store.prepareModelProviderSettings(
    prepareInput({
      operationId: "operation-2",
      coordinatorBinding: "desktop-supervisor:generation-8",
      expectedRevision: 1,
      idempotencyKey: "prepare-key-2",
      fingerprint: digest("4"),
    }),
  );
  await store.close();

  const database = new DatabaseSync(path);
  database
    .prepare(
      `UPDATE model_provider_settings SET catalog_json = ?
       WHERE tenant_id = 'tenant-1'`,
    )
    .run(
      JSON.stringify({
        ...catalogFixture(),
        bindings: [
          { ...bindingFixture(), endpoint: "https://drift.example/v1" },
        ],
      }),
    );
  database.close();

  const corrupted = sqliteProviderTestStore(path);
  try {
    await assert.rejects(
      corrupted.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite historical replay is independent while head load requires catalog authority", async (t) => {
  const path = sqlitePath(t);
  const store = sqliteProviderTestStore(path);
  await store.prepareModelProviderSettings(prepareInput());
  await store.finalizeModelProviderSettings(finalizeInput());
  await store.close();
  const database = new DatabaseSync(path);
  database.exec(
    "DELETE FROM model_provider_settings WHERE tenant_id='tenant-1'",
  );
  database.close();

  const corrupted = sqliteProviderTestStore(path);
  try {
    assert.equal(
      (await corrupted.finalizeModelProviderSettings(finalizeInput()))
        .disposition,
      "replayed",
    );
    await assert.rejects(
      corrupted.loadModelProviderSettingsState({ tenantId: "tenant-1" }),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await corrupted.close();
  }
});

test("SQLite prepare and finalize reject a consistently substituted catalog head", async (t) => {
  const preparePath = sqlitePath(t);
  const preparedHead = sqliteProviderTestStore(preparePath);
  await preparedHead.prepareModelProviderSettings(prepareInput());
  await preparedHead.finalizeModelProviderSettings(finalizeInput());
  await preparedHead.close();
  substituteSqliteCatalogHead(preparePath);
  const prepareCorrupted = sqliteProviderTestStore(preparePath);
  try {
    await assert.rejects(
      prepareCorrupted.prepareModelProviderSettings(
        prepareInput({
          operationId: "operation-2",
          coordinatorBinding: "desktop-supervisor:generation-8",
          expectedRevision: 1,
          idempotencyKey: "prepare-key-2",
          fingerprint: digest("5"),
        }),
      ),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await prepareCorrupted.close();
  }

  const finalizePath = sqlitePath(t);
  const pendingHead = sqliteProviderTestStore(finalizePath);
  await pendingHead.prepareModelProviderSettings(prepareInput());
  await pendingHead.finalizeModelProviderSettings(finalizeInput());
  await pendingHead.prepareModelProviderSettings(
    prepareInput({
      operationId: "operation-2",
      coordinatorBinding: "desktop-supervisor:generation-8",
      expectedRevision: 1,
      idempotencyKey: "prepare-key-2",
      fingerprint: digest("5"),
    }),
  );
  await pendingHead.close();
  substituteSqliteCatalogHead(finalizePath);
  const finalizeCorrupted = sqliteProviderTestStore(finalizePath);
  try {
    await assert.rejects(
      finalizeCorrupted.finalizeModelProviderSettings(
        finalizeInput({
          operationId: "operation-2",
          coordinatorBinding: "desktop-supervisor:generation-8",
          idempotencyKey: "finalize-key-2",
          fingerprint: digest("6"),
        }),
      ),
      hasStoreCode("model_provider_settings_stored_state_invalid"),
    );
  } finally {
    await finalizeCorrupted.close();
  }
});

function prepareInput(
  overrides: Partial<PrepareModelProviderSettingsInput> = {},
): PrepareModelProviderSettingsInput {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    expectedRevision: 0,
    activeProviderId: "gateway",
    bindings: [bindingFixture()],
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

function pendingFixture() {
  return {
    tenantId: "tenant-1",
    operationId: "operation-1",
    coordinatorBinding: "desktop-supervisor:generation-7",
    baseRevision: 0,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [bindingFixture()],
    preparedAt: "2026-08-09T01:00:00.000Z",
    expiresAt: "2026-08-09T01:05:00.000Z",
  };
}

function catalogFixture() {
  return {
    tenantId: "tenant-1",
    revision: 1,
    activeProviderId: "gateway",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [bindingFixture()],
    updatedAt: "2026-08-09T01:04:00.000Z",
  };
}

function bindingFixture() {
  return {
    providerId: "gateway",
    displayName: "Gateway",
    endpoint: "https://provider.example/v1",
    credentialKind: "keychain" as const,
    environmentVariable: null,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function hasStoreCode(code: string) {
  return (error: unknown) =>
    error instanceof RunStoreError && error.code === code;
}

const providerTestClocks = new WeakMap<object, TestClock>();

class TestClock implements LeaseClock {
  #now = Date.parse("2026-08-09T01:00:00.000Z");

  nowEpochMilliseconds(): number {
    return this.#now;
  }

  set(value: string): void {
    this.#now = Date.parse(value);
  }
}

function inMemoryProviderTestStore(): InMemoryRunStore {
  const clock = new TestClock();
  const store = new InMemoryRunStore({ clock });
  providerTestClocks.set(store, clock);
  return store;
}

function sqliteProviderTestStore(path: string): SqliteRunStore {
  const clock = new TestClock();
  const store = new SqliteRunStore(path, { clock });
  providerTestClocks.set(store, clock);
  return store;
}

function testClock(store: object): TestClock {
  const clock = providerTestClocks.get(store);
  if (clock === undefined) throw new Error("provider_test_clock_missing");
  return clock;
}

function sqlitePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "crewon-provider-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite");
}

function substituteSqliteCatalogHead(path: string): void {
  const database = new DatabaseSync(path);
  const substituted = {
    tenantId: "tenant-1",
    revision: 1,
    activeProviderId: "other",
    runtimeBindingId: "desktop-supervisor:generation-7",
    bindings: [
      {
        ...bindingFixture(),
        providerId: "other",
        endpoint: "https://other.example/v1",
      },
    ],
    updatedAt: "2026-08-09T01:00:00.000Z",
  };
  database
    .prepare(
      `UPDATE model_provider_settings
       SET revision=?, active_provider_id=?, catalog_json=?, updated_at=?
       WHERE tenant_id='tenant-1'`,
    )
    .run(
      substituted.revision,
      substituted.activeProviderId,
      JSON.stringify(substituted),
      substituted.updatedAt,
    );
  database.close();
}
