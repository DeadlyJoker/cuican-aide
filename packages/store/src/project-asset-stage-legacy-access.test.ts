import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import {
  loadSqliteAssetStage,
  loadPostgresAssetStage,
} from "./project-asset-stage-markers.ts";
import {
  loadSqliteMediaInputStage,
  loadPostgresMediaInputStage,
} from "./project-media-input-stage-markers.ts";
import {
  SqliteProjectAssetStageStore,
  PostgresProjectAssetStageStore,
} from "./project-asset-stage-store.ts";
import {
  SqliteProjectMediaInputStageStore,
  PostgresProjectMediaInputStageStore,
} from "./project-media-input-stage-store.ts";
import { assetStageLegacyFixture } from "./project-asset-stage-legacy-access.test-support.ts";
import {
  assetTestOptions,
  hasAssetCause,
} from "./project-asset.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  for (const kind of ["asset", "media-input"] as const)
    test(
      `${backend} cold ${kind} stage admission and genuine Run/Turn receipts reject the actual saved protected project`,
      assetTestOptions(backend),
      async (t) => {
        const f = await assetStageLegacyFixture(t, backend, kind);
        const load = () =>
          kind === "asset"
            ? f.second.parent
                .projectAssetStageStore()
                .loadAssetStageAdmission(f.locator)
            : f.second.parent
                .projectMediaInputStageStore()
                .loadMediaInputStageAdmission(f.locator);
        const required = () =>
          kind === "asset"
            ? f.parent
                .projectAssetStageStore()
                .readRequiredAssetStageDigest(f.locator)
            : f.parent
                .projectMediaInputStageStore()
                .readRequiredMediaInputStageDigest(f.locator);
        assert.deepEqual(await load(), f.admission);
        assert.equal(await required(), f.admission.contentDigest);
        assert.ok(await f.second.store.loadExtensionRunReceipt(f.receipt));
        assert.ok(await f.second.store.loadExtensionTurnReceipt(f.receipt));
        await f.protect();
        const before = await f.snapshot();
        for (const read of [
          load,
          required,
          () => f.second.store.loadExtensionRunReceipt(f.receipt),
          () => f.second.store.loadExtensionTurnReceipt(f.receipt),
        ])
          await assert.rejects(
            read(),
            hasAssetCause("creative_project_not_found"),
          );
        assert.deepEqual(await f.snapshot(), before);
      },
    );

for (const backend of ["sqlite", "postgres"] as const)
  for (const kind of ["asset", "media-input"] as const)
    test(
      `${backend} ${kind} stage loader borrows the actual caller transaction and does not end it on rejection`,
      assetTestOptions(backend),
      async (t) => {
        const f = await assetStageLegacyFixture(t, backend, kind);
        if (f.database) {
          const load = () =>
            kind === "asset"
              ? loadSqliteAssetStage(f.database!, f.locator)
              : loadSqliteMediaInputStage(f.database!, f.locator);
          assert.throws(load, /creative_project_legacy_transaction_required/u);
          f.database.exec("BEGIN");
          try {
            assert.deepEqual(load(), f.admission);
            assert.equal(f.database.isTransaction, true);
          } finally {
            f.database.exec("ROLLBACK");
          }
          await f.protect();
          f.database.exec("BEGIN");
          try {
            assert.throws(load, hasAssetCause("creative_project_not_found"));
            assert.equal(f.database.isTransaction, true);
          } finally {
            f.database.exec("ROLLBACK");
          }
        } else {
          const c = await f.pool!.connect();
          const load = () =>
            kind === "asset"
              ? loadPostgresAssetStage(c, f.schema, f.locator)
              : loadPostgresMediaInputStage(c, f.schema, f.locator);
          try {
            await assert.rejects(
              load(),
              /creative_project_legacy_transaction_required/u,
            );
            await c.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
            assert.deepEqual(await load(), f.admission);
            assert.equal(
              (await c.query("SHOW transaction_isolation")).rows[0]
                .transaction_isolation,
              "read committed",
            );
            await c.query("ROLLBACK");
          } finally {
            await c.query("ROLLBACK");
            c.release();
          }
          await f.protect();
          const protectedClient = await f.pool!.connect();
          try {
            await protectedClient.query(
              "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
            );
            await assert.rejects(
              kind === "asset"
                ? loadPostgresAssetStage(protectedClient, f.schema, f.locator)
                : loadPostgresMediaInputStage(
                    protectedClient,
                    f.schema,
                    f.locator,
                  ),
              hasAssetCause("creative_project_not_found"),
            );
            assert.equal(
              (await protectedClient.query("SHOW transaction_isolation"))
                .rows[0].transaction_isolation,
              "read committed",
            );
          } finally {
            await protectedClient.query("ROLLBACK");
            protectedClient.release();
          }
        }
      },
    );

for (const kind of ["asset", "media-input"] as const) {
  test(`sqlite ${kind} public stage read keeps its original snapshot across an actual WAL owner-schema cutover`, async (t) => {
    const f = await assetStageLegacyFixture(t, "sqlite", kind);
    f.database!.exec("PRAGMA journal_mode=WAL");
    const reader = new DatabaseSync(f.databasePath);
    t.after(() => reader.close());
    const store =
      kind === "asset"
        ? new SqliteProjectAssetStageStore({
            database: reader,
            assertOpen() {},
          })
        : new SqliteProjectMediaInputStageStore({
            database: reader,
            assertOpen() {},
          });
    const load = () =>
      "loadAssetStageAdmission" in store
        ? store.loadAssetStageAdmission(f.locator)
        : store.loadMediaInputStageAdmission(f.locator);
    const prepare = reader.prepare.bind(reader);
    let cutover: Promise<void> | null = null;
    reader.prepare = ((sql: string) => {
      if (
        !cutover &&
        sql.startsWith("SELECT *,json_extract(record_json,'$.projectId')")
      ) {
        assert.equal(reader.isTransaction, true);
        cutover = f.protect();
      }
      return prepare(sql);
    }) as typeof reader.prepare;
    assert.deepEqual(await load(), f.admission);
    assert.ok(cutover);
    await cutover;
    assert.equal(reader.isTransaction, false);
    await assert.rejects(load(), hasAssetCause("creative_project_not_found"));
    assert.equal(reader.isTransaction, false);
  });
  test(
    `postgres ${kind} public stage reads use the original one-slot pool with a REPEATABLE READ session default`,
    assetTestOptions("postgres"),
    async (t) => {
      const f = await assetStageLegacyFixture(t, "postgres", kind);
      const pool = new Pool({
        connectionString: process.env.CREWON_TEST_POSTGRES_URL,
        max: 1,
      });
      t.after(() => pool.end());
      const store =
        kind === "asset"
          ? new PostgresProjectAssetStageStore({
              pool,
              schema: f.schema,
              assertOpen() {},
            })
          : new PostgresProjectMediaInputStageStore({
              pool,
              schema: f.schema,
              assertOpen() {},
            });
      const load = () =>
        "loadAssetStageAdmission" in store
          ? store.loadAssetStageAdmission(f.locator)
          : store.loadMediaInputStageAdmission(f.locator);
      await pool.query("SET default_transaction_isolation='repeatable read'");
      assert.equal(
        (await pool.query("SHOW default_transaction_isolation")).rows[0]
          .default_transaction_isolation,
        "repeatable read",
      );
      assert.deepEqual(await load(), f.admission);
      await f.protect();
      await assert.rejects(load(), hasAssetCause("creative_project_not_found"));
      assert.equal(
        (await pool.query("SHOW default_transaction_isolation")).rows[0]
          .default_transaction_isolation,
        "repeatable read",
      );
    },
  );
}
