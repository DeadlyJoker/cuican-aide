import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Pool, Client } from "pg";
import { SqliteProjectFoundationStore } from "./project-foundation-sqlite-store.ts";
import { PostgresProjectFoundationStore } from "./project-foundation-postgres-store.ts";
import {
  fixture,
  foundationCreationRecipe,
  parameterChangeRecipe,
  owner,
} from "./project-foundation-store.test-support.ts";
import { foundationMetadataFixture } from "./project-foundation-legacy-access.test-support.ts";
import { metadataOwnerFixtureRecord } from "./plugin-project-metadata-owner-schema.test-support.ts";
import {
  foundationToolFixture,
  foundationHasCause,
} from "./project-foundation-run-commit.test-support.ts";

// A second real Node process commits the owner schema while the first reader holds a WAL snapshot.
const writer = `
import { DatabaseSync } from 'node:sqlite';
import { migrateSqlitePluginProjectMetadataOwners } from './packages/store/src/plugin-project-metadata-owner-schema.ts';
import { pluginProjectMetadataOwnerColumns } from './packages/store/src/plugin-project-metadata-owner-records.ts';
const database = new DatabaseSync(process.argv[1]);
const record = JSON.parse(process.argv[2]), o = record.owner;
database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
try {
  migrateSqlitePluginProjectMetadataOwners(database);
  const values=[o.tenantId,o.spaceId,o.principalId,o.actorId,o.profileId,o.pluginId,o.publisherId,o.projectId,record.createdAt,JSON.stringify(record)];
  database.prepare('INSERT INTO plugin_project_metadata_owners('+pluginProjectMetadataOwnerColumns.join(',')+') VALUES('+values.map(()=>'?').join(',')+')').run(...values);
  const original = JSON.parse(process.argv[3]), changed={...original,revision:original.revision+1};
  database.prepare('UPDATE project_foundations SET revision=?,record_json=? WHERE tenant_id=? AND space_id=? AND project_id=?').run(changed.revision,JSON.stringify(changed),o.tenantId,o.spaceId,o.projectId);
  database.exec('COMMIT');
} catch (error) {database.exec('ROLLBACK'); throw error;}
finally {database.close();}
`;

test(
  "sqlite: original Foundation read snapshots first owner migration from an independent process and borrows an existing transaction",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "sqlite");
    const created = await f.first.foundation.commitCreation(
      foundationCreationRecipe("snapshot-owned"),
    );
    await f.execute("PRAGMA journal_mode=WAL");
    let injected = false;
    f.first.hooks.afterStatement = (sql) => {
      if (injected || !sql.includes("sqlite_schema")) return;
      injected = true;
      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          writer,
          f.path,
          JSON.stringify(metadataOwnerFixtureRecord(created.project.projectId)),
          JSON.stringify(created.foundation),
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 0, result.stderr);
    };
    // It is valid to return the ordinary project from the snapshot established before migration.
    assert.deepEqual(
      await f.first.foundation.loadFoundation({
        owner: owner(),
        projectId: created.project.projectId,
      }),
      created.foundation,
    );
    assert.equal(injected, true);
    f.first.hooks.afterStatement = null;
    await assert.rejects(
      f.first.foundation.loadFoundation({
        owner: owner(),
        projectId: created.project.projectId,
      }),
      /creative_project_not_found/u,
    );

    const database = new DatabaseSync(f.path);
    t.after(() => database.close());
    const original = new SqliteProjectFoundationStore({
      database,
      assertOpen() {},
    });
    database.exec("BEGIN DEFERRED");
    try {
      await assert.rejects(
        original.loadFoundation({
          owner: owner(),
          projectId: created.project.projectId,
        }),
        /creative_project_not_found/u,
      );
      assert.equal(
        database.isTransaction,
        true,
        "borrowed read must not commit or roll back its caller",
      );
    } finally {
      database.exec("ROLLBACK");
    }
    // A normal legacy read uses the same existing transaction without starting another one.
    const ordinary = await f.first.foundation.commitCreation(
      foundationCreationRecipe("snapshot-ordinary"),
    );
    database.exec("BEGIN DEFERRED");
    try {
      assert.deepEqual(
        await original.loadFoundation({
          owner: owner(),
          projectId: ordinary.project.projectId,
        }),
        ordinary.foundation,
      );
      assert.equal(database.isTransaction, true);
    } finally {
      database.exec("ROLLBACK");
    }
  },
);

test(
  "postgres: explicit READ COMMITTED read sees first migrated owner despite a REPEATABLE READ session default",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    const created = await f.first.foundation.commitCreation(
      foundationCreationRecipe("default-isolation-owned"),
    );
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    t.after(() => pool.end());
    const session = await pool.connect();
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
    const original = new PostgresProjectFoundationStore({
      pool,
      schema: f.schema,
      assertOpen() {},
    });
    const metadata = await foundationMetadataFixture(t, f);
    await metadata.begin();
    await metadata.migrateDirect();
    await metadata.mark(created.project.projectId);
    const rejected = assert.rejects(
      original.loadFoundation({
        owner: owner(),
        projectId: created.project.projectId,
      }),
      /creative_project_not_found/u,
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if (await metadata.hasBlockedReader()) {
        blocked = true;
        break;
      }
      await delay(5);
    }
    assert.equal(blocked, true);
    await metadata.execute("COMMIT");
    await rejected;
  },
);

test(
  "postgres: physical original Tool lease expires during the added final async fence and rolls back the proposal and receipt",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30_000 },
  async (t) => {
    const f = await foundationToolFixture(t, "postgres", {
      leaseDurationMs: 3000,
    });
    const op = await f.prepare();
    const receiptCount = await f.count("project_foundation_mutation_receipts");
    const descriptor = Object.getOwnPropertyDescriptor(
      Client.prototype,
      "query",
    )!;
    let wrote = false,
      verifiedAfterWrite = false,
      expiredAtFinalFence = false;
    Object.defineProperty(Client.prototype, "query", {
      ...descriptor,
      value: function (this: Client, ...args: unknown[]) {
        const result = Reflect.apply(descriptor.value, this, args);
        return Promise.resolve(result).then((value) => {
          const sql = typeof args[0] === "string" ? args[0] : "";
          if (/INSERT INTO .*project_foundation_mutation_receipts/u.test(sql))
            wrote = true;
          if (
            wrote &&
            sql.includes("clock_timestamp() AS database_now") &&
            sql.includes("work_items")
          )
            verifiedAfterWrite = true;
          return value;
        });
      },
    });
    t.after(() => Object.defineProperty(Client.prototype, "query", descriptor));
    f.state.beforeTransaction = async () => {
      if (!verifiedAfterWrite || expiredAtFinalFence) return;
      expiredAtFinalFence = true;
      await delay(
        Math.max(1, Date.parse(f.claim.lease.expiresAt) - Date.now() + 40),
      );
    };
    await assert.rejects(
      f.application().saveProposal(f.actor, op.command, op.options),
      foundationHasCause("creative_project_run_commit_not_current"),
    );
    assert.equal(
      expiredAtFinalFence,
      true,
      "the genuine physical lease passed before the final asynchronous authority wait",
    );
    assert.equal(await f.count("project_proposals"), 1);
    assert.equal(
      await f.count("project_foundation_mutation_receipts"),
      receiptCount,
    );
  },
);

test(
  "postgres: explicit READ COMMITTED Foundation mutation rejects the owner published by a first migration under a REPEATABLE READ session default",
  { skip: !process.env.CREWON_TEST_POSTGRES_URL, timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "postgres");
    const created = await f.first.foundation.commitCreation(
      foundationCreationRecipe("default-mutation-owned"),
    );
    const counts = await f.counts();
    const pool = new Pool({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL,
      max: 1,
    });
    t.after(() => pool.end());
    const session = await pool.connect();
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
    const original = new PostgresProjectFoundationStore({
      pool,
      schema: f.schema,
      assertOpen() {},
    });
    const metadata = await foundationMetadataFixture(t, f);
    await metadata.begin();
    await metadata.migrateDirect();
    await metadata.mark(created.project.projectId);
    const rejected = assert.rejects(
      original.commitFoundationChange(
        parameterChangeRecipe(
          created.project,
          created.foundation,
          "default-owned-write",
        ),
      ),
      /creative_project_not_found/u,
    );
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if (await metadata.hasBlockedReader()) {
        blocked = true;
        break;
      }
      await delay(5);
    }
    assert.equal(blocked, true);
    await metadata.execute("COMMIT");
    await rejected;
    assert.deepEqual(await f.counts(), counts);
  },
);
