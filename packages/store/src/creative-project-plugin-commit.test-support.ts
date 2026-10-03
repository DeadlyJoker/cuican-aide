import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type { CreativeProjectCommitAuthority } from "@crewon/application";
import {
  extensionCanonicalJson,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { PostgresPluginInstallationStore } from "./postgres-plugin-installation-store.ts";
import { SqlitePluginInstallationStore } from "./sqlite-plugin-installation-store.ts";
import {
  actor,
  owner,
  projectTables,
} from "./creative-project-store.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
  deferred,
} from "./plugin-installation-store.test-support.ts";

export { actor, owner, deferred, selectionRecipe };
export type Backend = "sqlite" | "postgres";
export type GateLocation = "source" | "receipt" | "commit";
export const optionsFor = (backend: Backend) => ({
  skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 20000,
});

/** Real durable installation and metadata stores; the application pool has exactly one connection. */
export async function pluginCommitFixture(t: TestContext, backend: Backend) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-project-plugin-commit-"),
  );
  const path = join(directory, "projects.sqlite");
  const schema = `project_plugin_${randomUUID().replaceAll("-", "")}`;
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
          connectionTimeoutMillis: 1000,
        })
      : null;
  const observerPool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 2,
          connectionTimeoutMillis: 2000,
        })
      : null;
  const database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const resumes: ReturnType<typeof deferred>[] = [];
  const pending: Promise<unknown>[] = [];
  const commands: string[] = [];
  let closed = false,
    borrowed = 0,
    metadataPid: number | null = null;
  let barrier: {
    where: GateLocation;
    entered: ReturnType<typeof deferred>;
    resume: ReturnType<typeof deferred>;
    reached: boolean;
  } | null = null;
  const arm = (where: GateLocation) => {
    const entered = deferred(),
      resume = deferred();
    resumes.push(resume);
    barrier = { where, entered, resume, reached: false };
    return barrier;
  };
  const controlledClient = (client: PoolClient) =>
    new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            commands.push(sql);
            const result = await target.query(sql, values);
            const gate = barrier;
            const matches =
              gate?.where === "source"
                ? sql.includes("FOR SHARE OF s,p")
                : gate?.where === "receipt"
                  ? sql.startsWith(
                      `INSERT INTO "${schema}".creative_project_mutation_receipts`,
                    )
                  : gate?.where === "commit" && sql.trim() === "COMMIT";
            if (gate && !gate.reached && matches) {
              gate.reached = true;
              gate.entered.resolve();
              await gate.resume.promise;
            }
            return result;
          };
        if (key === "release")
          return () => {
            borrowed--;
            target.release();
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const controlledPool = pool
    ? new Proxy(pool, {
        get(target, key) {
          if (key === "connect")
            return async () => {
              const client = await target.connect();
              borrowed++;
              metadataPid = (
                await client.query<{ pid: number }>(
                  "SELECT pg_backend_pid() AS pid",
                )
              ).rows[0]!.pid;
              return controlledClient(client);
            };
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : null;
  const parent =
    backend === "sqlite"
      ? new SqliteRunStore(path)
      : await PostgresDomainStore.open({ pool: controlledPool!, schema });
  const projects = parent.creativeProjectStore();
  const installations = parent.pluginInstallationStore();
  await projects.migrate();
  await installations.migrate();
  const scope = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "profile-project-module",
  };
  const installed = await installations.recordInstalledPackage(
    installationRecipe("source-install", {
      scope,
      actor,
      pluginId: "example.metadata",
      version: "5.0.0",
    }),
  );
  const enabled = await installations.commitSelection(
    selectionRecipe(installed.selection, "source-enable", { actor }),
  );
  const source = { selection: enabled.selection, package: installed.package };
  const otherInstallations = database
    ? new SqlitePluginInstallationStore({ database, assertOpen() {} })
    : new PostgresPluginInstallationStore({
        pool: observerPool!,
        schema,
        assertOpen() {},
      });
  const query = async (sql: string, values: unknown[] = []) =>
    database
      ? database
          .prepare(sql)
          .all(...(values as (string | number | null)[]))
          .map((row) => ({ ...row }))
      : ((await observerPool!.query(sql, values)).rows as Record<
          string,
          unknown
        >[]);
  const execute = async (sql: string) => {
    if (database) database.exec(sql);
    else await observerPool!.query(sql);
  };
  const counts = async () => {
    const result: Record<string, number> = {};
    for (const table of projectTables)
      result[table] = Number(
        (await query(`SELECT COUNT(*) AS n FROM ${prefix}${table}`))[0]!.n,
      );
    return result;
  };
  const tableNames = async () =>
    (
      await query(
        database
          ? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          : `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`,
      )
    ).map((row) => String(row.name));
  function grant(action = "crewon.creative-projects.v1.createProject") {
    const state = {
      active: true,
      current: true,
      fullCalls: 0,
      transactionCalls: 0,
      preflightHook: null as null | (() => Promise<void>),
      transactionHook: null as null | (() => Promise<void>),
    };
    const pin = parsePluginTaskAdmissionPin({
      ...scope,
      pluginId: source.package.pluginId,
      publisherId: source.package.publisherId,
      version: source.package.version,
      packageDigest: source.package.packageDigest,
      selectionRevision: source.selection.revision,
      principalId: actor.principalId,
      actorId: actor.actorId,
      contributionId: "workbench",
      action,
      authorityEpoch: "epoch-source-1",
    });
    const authority: CreativeProjectCommitAuthority = {
      async assertCurrent() {
        state.fullCalls++;
        assert.equal(
          borrowed,
          0,
          "full UI current must not borrow its own transaction pool",
        );
        if (!state.active || closed || !state.current)
          throw new Error("metadata_invocation_withdrawn");
        const selection = await installations.loadSelection({
          scope,
          pluginId: pin.pluginId,
        });
        const pkg = await installations.loadPackage({
          scope,
          packageDigest: pin.packageDigest,
        });
        if (
          extensionCanonicalJson(selection) !==
            extensionCanonicalJson(source.selection) ||
          extensionCanonicalJson(pkg) !== extensionCanonicalJson(source.package)
        )
          throw new Error("metadata_source_changed");
        await state.preflightHook?.();
      },
      assertActive() {
        if (!state.active || closed)
          throw new Error("metadata_invocation_withdrawn");
      },
      transaction: {
        version: "crewon.creative-project-plugin-commit.v1",
        pin,
        selection: source.selection,
        package: source.package,
        async assertCurrent() {
          state.transactionCalls++;
          if (!state.active || closed || !state.current)
            throw new Error("metadata_invocation_withdrawn");
          await state.transactionHook?.();
          if (!state.active || closed || !state.current)
            throw new Error("metadata_invocation_withdrawn");
        },
      },
    };
    return { state, authority };
  }
  function afterReceipt(work: () => void) {
    assert.ok(database);
    database.function("withdraw_metadata_invocation", () => {
      work();
      return 0;
    });
    database.exec(
      "CREATE TRIGGER withdraw_metadata_invocation AFTER INSERT ON creative_project_mutation_receipts BEGIN SELECT withdraw_metadata_invocation(); END;",
    );
  }
  async function assertPidWaiting(pid: number) {
    assert.ok(observerPool);
    for (let i = 0; i < 100; i++) {
      const rows = await observerPool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock') AS waiting",
        [pid],
      );
      if (rows.rows[0]!.waiting) return;
      await new Promise<void>((done) => setTimeout(done, 10));
    }
    assert.fail("expected a real PostgreSQL row-lock wait");
  }
  t.after(async () => {
    closed = true;
    for (const resume of resumes) resume.resolve();
    await Promise.allSettled(pending);
    await parent.close();
    database?.close();
    try {
      await observerPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all([pool?.end(), observerPool?.end()]);
      await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    backend,
    parent,
    projects,
    installations,
    otherInstallations,
    source,
    scope,
    schema,
    prefix,
    pool,
    observerPool,
    database,
    commands,
    arm,
    query,
    execute,
    counts,
    tableNames,
    grant,
    afterReceipt,
    assertPidWaiting,
    get metadataPid() {
      return metadataPid;
    },
    closeOwner() {
      closed = true;
    },
    track<T>(work: Promise<T>): Promise<T> {
      pending.push(work);
      return work;
    },
  };
}
