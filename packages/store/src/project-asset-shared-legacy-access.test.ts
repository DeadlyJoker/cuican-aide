import assert from "node:assert/strict";
import test from "node:test";
import { sharedAssetFixture } from "./project-asset-shared-legacy-access.test-support.ts";
import {
  assetAt,
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";
import {
  assetHead,
  assetBrief,
  assetProject,
  assetOwner,
  type AssetPlan,
} from "./project-asset-store-support.ts";
import {
  executeSqliteMediaOperationPlan,
  executePostgresMediaOperationPlan,
} from "./project-media-operation-transaction.ts";
import { PROJECT_ASSET_V2_ACTIONS } from "@crewon/contracts/project-assets-v2";
import { PROJECT_ASSET_RECOVERY_V2_ACTIONS } from "@crewon/contracts/project-asset-recovery-v2";
import {
  captureAssetIntentStage,
  intentColumns,
  intentValues,
} from "./project-asset-ui-intent-support.ts";
import {
  executeSqliteAssetLegacyInstruction,
  executePostgresAssetLegacyInstruction,
} from "./project-asset-legacy-instruction.ts";
import { SqliteProjectAssetUiIntentJournalStore } from "./project-asset-ui-intent-sqlite-store.ts";
import { PostgresProjectAssetUiIntentJournalStore } from "./project-asset-ui-intent-postgres-store.ts";
import {
  SqliteProjectAssetV2RecoveryStore,
  PostgresProjectAssetV2RecoveryStore,
} from "./project-asset-vtwo-recovery-store.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend} shared asset generators fence the original borrowed media executor and preserve its transaction`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend),
        projectId = f.project.project.projectId;
      const g = f.creation("shared-generated"),
        saved = await f.assets.saveCandidate(
          f.actor,
          g.actual.command as never,
        );
      async function borrowed<T>(plan: AssetPlan<T>) {
        if (f.database) {
          f.database.exec("BEGIN");
          try {
            return executeSqliteMediaOperationPlan(f.database, plan, () => {});
          } finally {
            assert.equal(f.database.isTransaction, true);
            f.database.exec("ROLLBACK");
          }
        }
        const client = await f.observerPool!.connect();
        try {
          await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
          try {
            return await executePostgresMediaOperationPlan(
              client,
              f.schema,
              plan,
              () => {},
            );
          } finally {
            assert.equal(
              (
                await client.query(
                  "SELECT current_setting('transaction_isolation') AS level",
                )
              ).rows[0].level,
              "read committed",
            );
          }
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
      const d = {
          postgres: backend === "postgres",
          schema: f.schema,
          prefix: f.prefix,
        },
        owner = assetOwner(f.actor);
      assert.equal(
        (await borrowed(assetHead(d, owner, projectId, saved.asset.assetId)))
          ?.assetId,
        saved.asset.assetId,
      );
      await f.protectProject(projectId, "fixture.shared-media");
      const before = await f.snapshot();
      for (const plan of [
        assetProject(d, owner, projectId),
        assetBrief(d, owner, projectId, 1),
        assetHead(d, owner, projectId, saved.asset.assetId),
      ])
        await assert.rejects(
          borrowed<unknown>(plan),
          hasAssetCause("creative_project_not_found"),
        );
      assert.deepEqual(await f.snapshot(), before);
    },
  );
  test(
    `${backend} actual saved V1 journal project fences reads and changed-target stage retry before conflict decoding`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend),
        original = f.creation("journal-original");
      const saved = await f.stage(original);
      assert.equal((await f.pending())?.intentId, saved.intentId);
      const ordinary = await f.projects.createProject(f.actor, {
        title: "普通项目",
        briefText: "普通项目保留",
        idempotencyKey: "journal-other-project",
      });
      const changed = f.creation(
        "journal-original",
        ordinary.project.projectId,
      );
      await f.protectProject(saved.projectId, "fixture.v1-journal");
      const before = await f.snapshot();
      const load = () =>
        f.journal.loadIntent(
          { scope: f.scope, intentId: saved.intentId },
          f.recovery("acknowledge", {
            intentId: saved.intentId,
            expectedRevision: 1,
          }).options,
        );
      for (const run of [
        () => f.pending(),
        load,
        () => f.stage(original),
        () => f.stage(changed),
        () => f.ack(saved),
      ])
        await assert.rejects(
          run(),
          hasAssetCause("creative_project_not_found"),
        );
      assert.deepEqual(await f.snapshot(), before);
    },
  );
  test(
    `${backend} saved V2 recovery project fences load cancel pending and retry with no journal mutation`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend);
      await f.migrateRecovery();
      const g = f.creation("v2-original"),
        request = {
          action: PROJECT_ASSET_V2_ACTIONS.saveCandidate,
          input: g.input as never,
        };
      const saved = await f.v2Recovery.stage(
        { at: assetAt },
        f.v2Authority(request),
      );
      const pending = f.v2Authority({
        action: PROJECT_ASSET_RECOVERY_V2_ACTIONS.getPending,
        input: {},
      });
      assert.equal(
        (await f.v2Recovery.getPending(pending))?.intent.intentId,
        saved.intent.intentId,
      );
      await f.protectProject(
        saved.intent.request.input.projectId,
        "fixture.v2-journal",
      );
      const before = await f.journalSnapshot();
      const cancel = f.v2Authority({
        action: PROJECT_ASSET_RECOVERY_V2_ACTIONS.cancelPending,
        input: { intentId: saved.intent.intentId, expectedRevision: 1 },
      });
      for (const run of [
        () => f.v2Recovery.getPending(pending),
        () => f.v2Recovery.loadIntent(cancel),
        () => f.v2Recovery.cancelPending({ at: assetAt }, cancel),
        () => f.v2Recovery.stage({ at: assetAt }, f.v2Authority(request)),
      ])
        await assert.rejects(
          run(),
          hasAssetCause("creative_project_not_found"),
        );
      assert.deepEqual(await f.journalSnapshot(), before);
    },
  );
  test(
    `${backend} empty journal cannot hide a partial metadata namespace and pure journal DDL leaves it untouched`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend);
      await f.execute(
        `CREATE TABLE ${f.prefix}plugin_project_metadata_owners(broken INTEGER)`,
      );
      await f.journal.migrate();
      await assert.rejects(
        f.pending(),
        /plugin_project_metadata_owner_schema_invalid/u,
      );
      assert.deepEqual(
        await f.query(
          `SELECT * FROM ${f.prefix}plugin_project_metadata_owners`,
        ),
        [],
      );
    },
  );
  test(
    `${backend} protected raw journal identity rejects before decoding a corrupt saved envelope`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend),
        g = f.creation("corrupt-journal");
      const { record } = captureAssetIntentStage(
        {
          scope: g.scope,
          actionId: g.actionId,
          input: g.input,
          intentId: g.intentId,
          at: assetAt,
        },
        g.options,
      );
      // Deliberately corrupt persisted JSON without altering the real schema or inventing a Host grant.
      const values = [...intentValues(record)];
      values[values.length - 1] = "{}";
      await f.query(
        `INSERT INTO ${f.prefix}project_asset_ui_intents(${intentColumns}) VALUES(${values.map((_, i) => (backend === "sqlite" ? "?" : `$${i + 1}`)).join(",")})`,
        values,
      );
      await f.protectProject(record.projectId, "fixture.corrupt-journal");
      await assert.rejects(
        f.journal.loadIntent(
          { scope: f.scope, intentId: record.intentId },
          f.recovery("acknowledge", {
            intentId: record.intentId,
            expectedRevision: 1,
          }).options,
        ),
        hasAssetCause("creative_project_not_found"),
      );
    },
  );
  test(
    `${backend} private asset instruction requires the actual caller transaction`,
    assetTestOptions(backend),
    async (t) => {
      const f = await sharedAssetFixture(t, backend),
        instruction = { assetLegacyAccess: { kind: "schema" as const } };
      if (f.database) {
        assert.throws(
          () => executeSqliteAssetLegacyInstruction(f.database!, instruction),
          /creative_project_legacy_transaction_required/u,
        );
      } else {
        const client = await f.observerPool!.connect();
        try {
          await assert.rejects(
            executePostgresAssetLegacyInstruction(
              client,
              f.schema,
              instruction,
            ),
            /creative_project_legacy_transaction_required/u,
          );
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          await assert.rejects(
            executePostgresAssetLegacyInstruction(
              client,
              f.schema,
              instruction,
            ),
            /creative_project_legacy_isolation_invalid/u,
          );
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      }
    },
  );
  for (const kind of ["v1", "v2"] as const)
    test(
      `${backend} ${kind} journal final stored scope check rolls back protection inserted after real journal SQL`,
      assetTestOptions(backend),
      async (t) => {
        const f = await sharedAssetFixture(t, backend);
        if (kind === "v2") await f.migrateRecovery();
        const other = await f.projects.createProject(f.actor, {
          title: "其他项目",
          briefText: "只用于提前建立真实完整 owner namespace",
          idempotencyKey: "journal-metadata-schema",
        });
        await f.protectProject(
          other.project.projectId,
          "fixture.other-journal",
        );
        const g = f.creation("final-journal-scope"),
          hook = f.insertOwnerAfterJournalSql(
            g.actual.command.projectId,
            kind === "v1"
              ? "project_asset_ui_intents"
              : "project_asset_versioned_intents",
          );
        const before =
          kind === "v1" ? await f.snapshot() : await f.journalSnapshot();
        const operation =
          kind === "v1"
            ? f.stage(
                g,
                hook.database
                  ? new SqliteProjectAssetUiIntentJournalStore({
                      database: hook.database,
                      assertOpen() {},
                    })
                  : new PostgresProjectAssetUiIntentJournalStore({
                      pool: hook.pool!,
                      schema: f.schema,
                      assertOpen() {},
                    }),
              )
            : (hook.database
                ? new SqliteProjectAssetV2RecoveryStore({
                    database: hook.database,
                    assertOpen() {},
                  })
                : new PostgresProjectAssetV2RecoveryStore({
                    pool: hook.pool!,
                    schema: f.schema,
                    assertOpen() {},
                  })
              ).stage(
                { at: assetAt },
                f.v2Authority({
                  action: PROJECT_ASSET_V2_ACTIONS.saveCandidate,
                  input: g.input as never,
                }),
              );
        await assert.rejects(
          operation,
          hasAssetCause("creative_project_not_found"),
        );
        assert.equal(
          hook.inserted(),
          true,
          "the real journal INSERT completed before protection became visible",
        );
        assert.deepEqual(
          kind === "v1" ? await f.snapshot() : await f.journalSnapshot(),
          before,
        );
        assert.equal(
          (
            await f.query(
              `SELECT project_id FROM ${f.prefix}plugin_project_metadata_owners`,
            )
          ).length,
          1,
          "the same original transaction rolled back the newly inserted owner too",
        );
      },
    );
}

test(
  "postgres original V1/V2 journal operations use RC under a REPEATABLE READ session default",
  assetTestOptions("postgres"),
  async (t) => {
    const f = await sharedAssetFixture(t, "postgres");
    await f.migrateRecovery();
    const session = await f.pool!.connect();
    try {
      await session.query(
        "SET default_transaction_isolation TO 'repeatable read'",
      );
      assert.equal(
        (await session.query("SHOW default_transaction_isolation")).rows[0]
          .default_transaction_isolation,
        "repeatable read",
      );
    } finally {
      session.release();
    }
    const original = f.creation("v1-default-rr"),
      staged = await f.stage(original);
    assert.equal((await f.pending())?.intentId, staged.intentId);
    const v2 = f.creation("v2-default-rr"),
      request = {
        action: PROJECT_ASSET_V2_ACTIONS.saveCandidate,
        input: v2.input as never,
      };
    const saved = await f.v2Recovery.stage(
      { at: assetAt },
      f.v2Authority(request),
    );
    assert.equal(
      (
        await f.v2Recovery.getPending(
          f.v2Authority({
            action: PROJECT_ASSET_RECOVERY_V2_ACTIONS.getPending,
            input: {},
          }),
        )
      )?.intent.intentId,
      saved.intent.intentId,
    );
    await f.protectProject(staged.projectId, "fixture.journal-default-rr");
    await assert.rejects(
      f.pending(),
      hasAssetCause("creative_project_not_found"),
    );
  },
);
