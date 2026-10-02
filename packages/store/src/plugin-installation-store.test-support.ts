import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool, type PoolClient } from "pg";
import type {
  ActorContext,
  PluginInstallationStore,
} from "@crewon/application";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
  type InstalledPluginPackage,
  type PluginProfileScope,
  type PluginSelection,
} from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";

export type Backend = "sqlite" | "postgres";
export type InstallationStore = PluginInstallationStore & {
  migrate(): Promise<void>;
};
export const actor: ActorContext = {
  tenantId: "tenant-插件",
  spaceId: "space-插件",
  principalId: "principal-本人",
  actorId: "actor-本人",
};
export const scope: PluginProfileScope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "profile-工作台",
};
export const timestamp = "2026-10-02T00:00:00.000Z";
export const digest = (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const receipt = (key: string, fingerprint = key) => ({
  idempotencyKey: key,
  requestDigest: digest(`fixture-request:${fingerprint}`),
});
export function packageRecord(
  options: {
    scope?: PluginProfileScope;
    actor?: ActorContext;
    pluginId?: string;
    version?: string;
    publisherId?: string;
    packageDigest?: string;
    at?: string;
  } = {},
): InstalledPluginPackage {
  const s = options.scope ?? scope;
  const who = options.actor ?? actor;
  const pluginId = options.pluginId ?? "example.story";
  const version = options.version ?? "1.0.0";
  return parseInstalledPluginPackage({
    schemaVersion: "crewon.installed-plugin-package.v1",
    ...s,
    pluginId,
    version,
    publisherId: options.publisherId ?? "example.publisher",
    packageDigest:
      options.packageDigest ?? digest(`fixture-package:${pluginId}:${version}`),
    installedAt: options.at ?? timestamp,
    installedByPrincipalId: who.principalId,
    installedByActorId: who.actorId,
  });
}
export function installationRecipe(
  key = "install-1",
  options: Parameters<typeof packageRecord>[0] & {
    expectedSelectionRevision?: number | null;
  } = {},
) {
  const pkg = packageRecord(options);
  return {
    scope: options.scope ?? scope,
    actor: { ...(options.actor ?? actor) },
    receipt: receipt(key),
    package: pkg,
    expectedSelectionRevision: options.expectedSelectionRevision ?? null,
  };
}
export function selectionRecipe(
  current: PluginSelection,
  key: string,
  options: {
    state?: PluginSelection["state"];
    packageDigest?: string;
    actor?: ActorContext;
    at?: string;
  } = {},
) {
  const who = options.actor ?? actor;
  const state = options.state ?? "enabled";
  return {
    scope: {
      tenantId: current.tenantId,
      spaceId: current.spaceId,
      profileId: current.profileId,
    },
    actor: who,
    receipt: receipt(key),
    expectedSelectionRevision: current.revision,
    selection: parsePluginSelection({
      ...current,
      revision: current.revision + 1,
      state,
      selectedPackageDigest:
        state === "uninstalled"
          ? null
          : (options.packageDigest ?? current.selectedPackageDigest),
      updatedAt: options.at ?? timestamp,
      updatedByPrincipalId: who.principalId,
      updatedByActorId: who.actorId,
    }),
  };
}
export const tables = [
  "installed_plugin_packages",
  "plugin_profile_selections",
  "plugin_installation_receipts",
] as const;

/** True SQLite file / isolated PostgreSQL schema and two independent host connections. */
export async function fixture(
  t: TestContext,
  backend: Backend,
  options: { migrate?: boolean } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-plugin-installation-"),
  );
  const path = join(directory, "installation.sqlite");
  const schema = `plugin_installation_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const opened: Array<SqliteRunStore | PostgresDomainStore> = [];
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const query = async (sql: string): Promise<Record<string, unknown>[]> =>
    database
      ? database
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }))
      : (await admin!.query(sql)).rows;
  const execute = async (sql: string) => {
    if (database) database.exec(sql);
    else await admin!.query(sql);
  };
  t.after(async () => {
    try {
      for (const parent of opened) await parent.close();
    } finally {
      database?.close();
      try {
        if (admin)
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const open = async (migrate = options.migrate !== false) => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: 3,
          });
    opened.push(parent);
    const store = parent.pluginInstallationStore();
    if (migrate) await store.migrate();
    return { parent, store: store as InstallationStore };
  };
  const first = await open();
  const second = await open();
  const tableNames = async () =>
    (
      await query(
        backend === "sqlite"
          ? "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
          : `SELECT table_name AS name FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`,
      )
    ).map((row) => String(row.name));
  const count = async (table: string) => {
    assert.match(table, /^[a-z_]+$/u);
    return Number(
      (await query(`SELECT COUNT(*) AS count FROM ${prefix}${table}`))[0]!
        .count,
    );
  };
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await count(table)]),
      ),
    );
  const versions = async () => {
    const names = await tableNames();
    const core = await query(
      backend === "sqlite"
        ? "PRAGMA user_version"
        : `SELECT component,version FROM ${prefix}schema_migrations ORDER BY component`,
    );
    const auxiliary: Record<string, unknown> = {};
    for (const table of [
      "extension_schema_version",
      "plugin_credit_schema_version",
      "extension_credit_schema_version",
      "creative_project_schema_version",
    ])
      auxiliary[table] = names.includes(table)
        ? await query(`SELECT id,version FROM ${prefix}${table} ORDER BY id`)
        : null;
    return { core, auxiliary };
  };
  const failReceipts = async (enabled: boolean) => {
    const trigger = "plugin_installation_fixture_failure";
    if (backend === "sqlite")
      await execute(
        enabled
          ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON plugin_installation_receipts BEGIN SELECT RAISE(ABORT,'plugin_installation_fixture_write_failed'); END;`
          : `DROP TRIGGER ${trigger};`,
      );
    else
      await execute(
        enabled
          ? `CREATE FUNCTION ${prefix}${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plugin_installation_fixture_write_failed'; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON ${prefix}plugin_installation_receipts FOR EACH ROW EXECUTE FUNCTION ${prefix}${trigger}();`
          : `DROP TRIGGER ${trigger} ON ${prefix}plugin_installation_receipts;DROP FUNCTION ${prefix}${trigger}();`,
      );
  };
  return {
    backend,
    first,
    second,
    open,
    query,
    execute,
    prefix,
    count,
    counts,
    tableNames,
    versions,
    failReceipts,
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Delays the response of a real SQL command; no database output or commit is fabricated. */
export async function postgresLifecycleFixture(t: TestContext) {
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const pool = new Pool({ connectionString, max: 2 });
  const observer = new Pool({ connectionString, max: 1 });
  const schema = `plugin_installation_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const gates: ReturnType<typeof deferred>[] = [];
  const pending: Promise<unknown>[] = [];
  let barrier: {
    where: "commit" | "receipt";
    entered: ReturnType<typeof deferred>;
    resume: ReturnType<typeof deferred>;
    reached: boolean;
  } | null = null;
  function arm(where: "commit" | "receipt") {
    const entered = deferred();
    const resume = deferred();
    gates.push(resume);
    barrier = { where, entered, resume, reached: false };
    return barrier;
  }
  const controlled = (client: PoolClient) =>
    new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            const result = await target.query(sql, values);
            const gate = barrier;
            const matches =
              gate?.where === "commit"
                ? sql.trim() === "COMMIT"
                : sql.startsWith(
                    `INSERT INTO "${schema}".plugin_installation_receipts`,
                  );
            if (gate && !gate.reached && matches) {
              gate.reached = true;
              gate.entered.resolve();
              await gate.resume.promise;
            }
            return result;
          };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const controlledPool = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => controlled(await target.connect());
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let parent: PostgresDomainStore | null = null;
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    try {
      await parent?.close();
      await observer.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await Promise.all([pool.end(), observer.end()]);
    }
  });
  parent = await PostgresDomainStore.open({ pool: controlledPool, schema });
  const store = parent.pluginInstallationStore();
  await store.migrate();
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          Number(
            (
              await observer.query(
                `SELECT COUNT(*) AS n FROM "${schema}".${table}`,
              )
            ).rows[0].n,
          ),
        ]),
      ),
    );
  return {
    parent,
    store,
    pool,
    arm,
    counts,
    track<T>(promise: Promise<T>): Promise<T> {
      pending.push(promise);
      return promise;
    },
  };
}
