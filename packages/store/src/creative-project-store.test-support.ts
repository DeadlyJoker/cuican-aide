import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  appendProjectBriefRevision,
  createConceptAsset,
  createCreativeProject,
  extensionCanonicalJson,
  type CreativeProject,
  type ProjectBriefRevision,
} from "@crewon/domain";
import {
  CreativeProjectApplicationService,
  type ActorContext,
  type CreativeProjectOwnerScope,
  type CreativeProjectStore,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";

export type Backend = "sqlite" | "postgres";
export type ProjectStore = CreativeProjectStore & { migrate(): Promise<void> };
export const actor: ActorContext = {
  tenantId: "tenant-项目",
  spaceId: "space-项目",
  principalId: "principal-本人",
  actorId: "actor-本人",
};
export const timestamp = "2026-10-02T00:00:00.000Z";
export const digester = {
  sha256(value: string) {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
  },
};
export function owner(who: ActorContext = actor): CreativeProjectOwnerScope {
  return {
    tenantId: who.tenantId,
    spaceId: who.spaceId,
    principalId: who.principalId,
  };
}
export function command(idempotencyKey = "create-1") {
  return { title: "雨夜相逢", briefText: "两个人在雨夜重逢。", idempotencyKey };
}
export function receipt(idempotencyKey: string) {
  return {
    idempotencyKey,
    requestDigest: digester.sha256(`fixture-request:${idempotencyKey}`),
  };
}
export function creationRecipe(
  projectId: string,
  key = "create-recipe",
  who = actor,
  at = timestamp,
) {
  const project = createCreativeProject({
    scope: { tenantId: who.tenantId, spaceId: who.spaceId, projectId },
    actor: who,
    title: command().title,
    at,
  });
  const initial = appendProjectBriefRevision(
    {
      project,
      actor: who,
      expectedProjectRevision: project.revision,
      text: command().briefText,
      at,
    },
    digester,
  );
  return {
    actor: who,
    receipt: receipt(key),
    project: initial.project,
    initialBrief: initial.brief,
  };
}
export function conceptRecipe(
  project: CreativeProject,
  brief: ProjectBriefRevision,
  key: string,
  assetId = "asset-direct",
) {
  return {
    actor,
    receipt: receipt(key),
    kind: "create-concept" as const,
    expectedProjectRevision: project.revision,
    ...createConceptAsset(
      {
        project,
        actor,
        expectedProjectRevision: project.revision,
        brief,
        assetId,
        name: "雨夜概念图",
        prompt: "雨夜街道，写实质感",
        at: timestamp,
      },
      digester,
    ),
  };
}
export function withDigest<T extends { contentDigest: string }>(record: T): T {
  const { contentDigest: _previous, ...body } = record;
  return {
    ...record,
    contentDigest: digester.sha256(extensionCanonicalJson(body)),
  };
}
export function application(
  store: ProjectStore,
  prefix = "first",
  options: { ids?: readonly string[]; at?: string } = {},
) {
  const idCalls: string[] = [];
  let clockCalls = 0;
  const service = new CreativeProjectApplicationService({
    store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: {
      now: () => {
        clockCalls += 1;
        return options.at ?? timestamp;
      },
    },
    ids: {
      nextId: (kind) => {
        const sequence = idCalls.length;
        idCalls.push(kind);
        return options.ids?.[sequence] ?? `${prefix}-${kind}-${sequence + 1}`;
      },
    },
    digester,
  });
  return {
    service,
    idCalls,
    get clockCalls() {
      return clockCalls;
    },
  };
}

export const projectTables = [
  "creative_projects",
  "creative_project_briefs",
  "creative_concept_assets",
  "creative_concept_revisions",
  "creative_project_mutation_receipts",
] as const;

/** Real host connections, isolated SQLite file / PostgreSQL schema, no memory adapter. */
export async function fixture(
  t: TestContext,
  backend: Backend,
  options: { migrate?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-creative-project-"));
  const path = join(directory, "projects.sqlite");
  const schema = `creative_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const opened: Array<SqliteRunStore | PostgresDomainStore> = [];
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const query = async (
    sql: string,
  ): Promise<readonly Record<string, unknown>[]> => {
    const rows =
      database !== null
        ? (database.prepare(sql).all() as Record<string, unknown>[])
        : (await admin!.query(sql)).rows;
    return rows.map((row) => ({ ...row }));
  };
  const execute = async (sql: string) => {
    if (database !== null) database.exec(sql);
    else await admin!.query(sql);
  };
  t.after(async () => {
    try {
      for (const parent of opened) await parent.close();
    } finally {
      database?.close();
      try {
        if (admin !== null)
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
    const store = parent.creativeProjectStore();
    if (migrate) await store.migrate();
    return { parent, store: store as ProjectStore };
  };
  const first = await open();
  const second = await open();
  const tableNames = async () =>
    (
      await query(
        backend === "sqlite"
          ? "SELECT name AS name FROM sqlite_master WHERE type='table' ORDER BY name"
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
        projectTables.map(async (table) => [table, await count(table)]),
      ),
    );
  const versions = async () => {
    const names = await tableNames();
    const core =
      backend === "sqlite"
        ? await query("PRAGMA user_version")
        : await query(
            `SELECT component, version FROM ${prefix}schema_migrations ORDER BY component`,
          );
    const auxiliary: Record<string, unknown> = {};
    for (const table of [
      "extension_schema_version",
      "plugin_credit_schema_version",
      "extension_credit_schema_version",
    ]) {
      auxiliary[table] = names.includes(table)
        ? await query(`SELECT id, version FROM ${prefix}${table} ORDER BY id`)
        : null;
    }
    return { core, auxiliary };
  };
  const failInserts = async (
    table: (typeof projectTables)[number],
    enable: boolean,
  ) => {
    const trigger = `${table}_fixture_failure`;
    if (backend === "sqlite") {
      await execute(
        enable
          ? `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'creative_fixture_insert_failure'); END;`
          : `DROP TRIGGER ${trigger};`,
      );
    } else {
      await execute(
        enable
          ? `CREATE FUNCTION ${prefix}${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'creative_fixture_insert_failure'; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON ${prefix}${table} FOR EACH ROW EXECUTE FUNCTION ${prefix}${trigger}();`
          : `DROP TRIGGER ${trigger} ON ${prefix}${table}; DROP FUNCTION ${prefix}${trigger}();`,
      );
    }
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
    failInserts,
  };
}
