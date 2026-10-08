import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { extensionCanonicalJson } from "@crewon/domain";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { seedDownstreamFoundation } from "./project-foundation-downstream-integration.test-support.ts";

export type FoundationRunBackend = "sqlite" | "postgres";
export const foundationRunTables = [
  "project_foundation_run_schema_version",
  "project_foundation_run_admissions",
  "project_foundation_run_requirements",
] as const;
export const foundationRunTestOptions = (backend: FoundationRunBackend) => ({
  skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  timeout: 30_000,
});
export const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Real original host stores; Foundation remains explicitly opt-in on their existing DB. */
export async function foundationRunSchemaFixture(
  t: TestContext,
  backend: FoundationRunBackend,
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-foundation-run-"));
  const path = join(directory, "control.sqlite");
  const schema = `foundation_run_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const database = backend === "sqlite" ? new DatabaseSync(path) : null;
  const pool =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const opened: (SqliteRunStore | PostgresDomainStore)[] = [];
  t.after(async () => {
    for (const parent of opened) await parent.close();
    database?.close();
    if (pool !== null) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await pool.end();
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const open = async () => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: 1,
          });
    opened.push(parent);
    return parent;
  };
  const parent = await open();
  const rows = async (sql: string): Promise<Record<string, unknown>[]> =>
    database === null
      ? (await pool!.query(sql)).rows
      : database.prepare(sql).all();
  const execute = async (sql: string) => {
    if (database !== null) database.exec(sql);
    else await pool!.query(sql);
  };
  const catalog = () =>
    rows(
      backend === "sqlite"
        ? "SELECT name,type,sql FROM main.sqlite_schema ORDER BY name"
        : `SELECT 'relation' AS type,c.relname AS name,c.relkind::text AS definition FROM pg_catalog.pg_class c WHERE c.relnamespace=${sqlText(schema)}::regnamespace
       UNION ALL SELECT 'function',p.proname,pg_catalog.pg_get_functiondef(p.oid) FROM pg_catalog.pg_proc p WHERE p.pronamespace=${sqlText(schema)}::regnamespace AND p.prokind IN ('f','p')
         UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,pg_catalog.pg_get_triggerdef(t.oid)||':'||t.tgenabled::text FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=${sqlText(schema)}::regnamespace AND NOT t.tgisinternal
       UNION ALL SELECT 'column',c.relname||'.'||a.attname,a.atttypid::regtype::text||':'||a.attnotnull::text FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=${sqlText(schema)}::regnamespace AND a.attnum>0 AND NOT a.attisdropped
       UNION ALL SELECT 'constraint',c.relname||'.'||k.conname,pg_catalog.pg_get_constraintdef(k.oid) FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid WHERE c.relnamespace=${sqlText(schema)}::regnamespace
       ORDER BY type,name,definition`,
    );
  const migrate = async () => {
    await parent.creativeProjectStore().migrate();
    await parent.projectFoundationStore().migrate();
  };
  return {
    parent,
    open,
    database,
    pool,
    prefix,
    schema,
    rows,
    execute,
    catalog,
    migrate,
  };
}

/** A genuine installed discussion Turn issues its own sidecar. Only historical Foundation data is seeded. */
export async function foundationRunIssuedFixture(
  t: TestContext,
  backend: FoundationRunBackend,
  origin: "creative" | "novel" = "novel",
) {
  const f = await conversationFixture(t, backend);
  const project = await f.metadata.loadProject({
    owner: {
      tenantId: f.actor.tenantId,
      spaceId: f.actor.spaceId,
      principalId: f.actor.principalId,
    },
    projectId: f.reference.projectId,
  });
  assert.ok(project);
  const foundation = await seedDownstreamFoundation({
    parent: f.parent,
    project,
    actor: f.actor,
    prefix: f.prefix,
    execute: f.sql,
    origin,
  });
  await foundation.confirm();
  const prepared = await f.prepare();
  await f.store.commitBinding(prepared, { authority: f.authority });
  const command = {
    pluginId: f.pin.pluginId,
    threadId: prepared.binding.threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "foundation-issued-discussion",
    intent: {
      kind: "generate" as const,
      input: { prompt: "讨论当前项目的真实改编方案" },
    },
  };
  const task = {
    binding: prepared.binding,
    stage: { kind: "discussion" as const },
    sources: { brief: null, outline: null },
    content: command.intent.input.prompt,
    authority: f.authority,
    conversations: f.store,
  };
  const { result } = await f.tasks.createProjectConversationTurnFromHost(
    f.actor,
    command,
    task,
  );
  const locator = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    runId: result.binding.runId,
  };
  const reader = f.parent.projectFoundationRunStore();
  const admission = await reader.loadFoundationRunAdmission(locator);
  assert.ok(admission);
  const database =
    backend === "sqlite" ? new DatabaseSync(f.databasePath) : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  t.after(async () => {
    database?.close();
    await pool?.end();
  });

  /** Deliberate native DB corruption for negative reads. Never grants UI/Run authority. */
  const corruptSidecar = async (sql: string) => {
    const tables = foundationRunTables.slice(1);
    if (database !== null) {
      const triggers = database
        .prepare(
          "SELECT name,sql FROM main.sqlite_schema WHERE type='trigger' AND tbl_name IN (?,?)",
        )
        .all(...tables);
      database.exec("PRAGMA foreign_keys=OFF");
      for (const row of triggers)
        database.exec(`DROP TRIGGER "${String(row.name)}"`);
      try {
        database.exec(sql);
      } finally {
        for (const row of triggers) database.exec(String(row.sql));
      }
      return;
    }
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      for (const table of tables)
        await client.query(
          `ALTER TABLE ${f.prefix}${table} DISABLE TRIGGER ALL`,
        );
      await client.query(sql);
      for (const table of tables)
        await client.query(
          `ALTER TABLE ${f.prefix}${table} ENABLE TRIGGER ALL`,
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const rewriteRecord = (record: unknown) => {
    const value = record as typeof admission;
    return corruptSidecar(
      `UPDATE ${f.prefix}project_foundation_run_admissions SET record_json=${sqlText(extensionCanonicalJson(value))},content_digest=${sqlText(value.contentDigest)}; UPDATE ${f.prefix}project_foundation_run_requirements SET content_digest=${sqlText(value.contentDigest)}`,
    );
  };
  return {
    ...f,
    foundation,
    prepared,
    command,
    task,
    result,
    locator,
    reader,
    admission,
    corruptSidecar,
    rewriteRecord,
  };
}
