import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type {
  ProjectSourceUploadAction,
  ProjectSourceUploadCommitAuthority,
  ProjectSourceUploadInitial,
  ProjectSourceUploadStore,
} from "@crewon/application";
import { SqliteCreativeProjectStore } from "./sqlite-creative-project-store.ts";
import { PostgresCreativeProjectStore } from "./postgres-creative-project-store.ts";
import { SqliteProjectSourceUploadStore } from "./project-source-upload-sqlite-store.ts";
import { PostgresProjectSourceUploadStore } from "./project-source-upload-postgres-store.ts";
import {
  assertSqliteProjectSourceUploadSchema,
  assertPostgresProjectSourceUploadSchema,
} from "./project-source-upload-schema.ts";
import {
  actor,
  owner,
  projectTables,
  timestamp,
} from "./creative-project-store.test-support.ts";

export type UploadSchemaBackend = "sqlite" | "postgres";
export type UploadSchemaStore = ProjectSourceUploadStore & {
  migrate(): Promise<void>;
};
export const uploadSchemaHash = (value: string | Uint8Array) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
export function uploadSchemaGrant(
  action: ProjectSourceUploadAction,
  uploadId: string | null,
): ProjectSourceUploadCommitAuthority {
  return {
    version: "crewon.project-source-upload-commit.v1",
    permission: {
      actor,
      action,
      resource: {
        kind: "projectSourceUpload",
        owner: owner(),
        uploadId,
        projectId: null,
      },
    },
    async assertCurrent() {},
    assertActive() {},
  };
}

/** Original project Stores, real file / isolated PG schema, explicit upload migration only. */
export async function uploadSchemaFixture(
  t: TestContext,
  backend: UploadSchemaBackend,
  options: { migrateParent?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "crewon-upload-schema-"));
  const path = join(directory, "original.sqlite");
  const schema = "upload_schema_" + randomUUID().replaceAll("-", "");
  const prefix = backend === "postgres" ? '"' + schema + '".' : "";
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  let database: DatabaseSync | null = null;
  let pool: Pool | null = null;
  let closed = true;
  async function close() {
    if (closed) return;
    closed = true;
    database?.close();
    database = null;
    await pool?.end();
    pool = null;
  }
  t.after(async () => {
    try {
      await close();
    } finally {
      try {
        await admin?.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      } finally {
        await admin?.end();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  if (admin) await admin.query('CREATE SCHEMA "' + schema + '"');
  async function open() {
    assert.equal(closed, true);
    closed = false;
    database = backend === "sqlite" ? new DatabaseSync(path) : null;
    pool =
      backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
    database?.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000");
    const assertOpen = () => assert.equal(closed, false);
    const projects = database
      ? new SqliteCreativeProjectStore({ database, assertOpen })
      : new PostgresCreativeProjectStore({ pool: pool!, schema, assertOpen });
    const uploads: UploadSchemaStore = database
      ? new SqliteProjectSourceUploadStore({
          database,
          assertOpen,
          installationAdmission: "trusted-internal-authority",
        })
      : new PostgresProjectSourceUploadStore({
          pool: pool!,
          schema,
          assertOpen,
          installationAdmission: "trusted-internal-authority",
        });
    return { projects, uploads };
  }
  async function query(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    const statement = sql.replaceAll("$schema.", prefix);
    if (database)
      return database
        .prepare(statement.replace(/\$([0-9]+)/gu, "?"))
        .all(...(parameters as SQLInputValue[]))
        .map((row) => ({ ...row }));
    assert.ok(admin);
    return (await admin.query(statement, [...parameters])).rows;
  }
  async function execute(sql: string, parameters: readonly unknown[] = []) {
    const statement = sql.replaceAll("$schema.", prefix);
    if (database) {
      if (parameters.length === 0) database.exec(statement);
      else
        database
          .prepare(statement.replace(/\$([0-9]+)/gu, "?"))
          .run(...(parameters as SQLInputValue[]));
    } else {
      assert.ok(admin);
      await admin.query(statement, [...parameters]);
    }
  }
  async function assertSchema() {
    if (database) return assertSqliteProjectSourceUploadSchema(database);
    assert.ok(admin);
    const client = await admin.connect();
    try {
      return await assertPostgresProjectSourceUploadSchema(client, schema);
    } finally {
      client.release();
    }
  }
  async function catalog(legacyOnly = false) {
    if (database)
      return query(
        "SELECT name,type,tbl_name,sql FROM sqlite_master" +
          (legacyOnly ? " WHERE name LIKE 'creative_%'" : "") +
          " ORDER BY name",
      );
    assert.ok(admin);
    const filter = legacyOnly ? " AND c.relname LIKE 'creative_%'" : "";
    const relations = (
      await admin.query(
        "SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1" +
          filter +
          " ORDER BY c.relname",
        [schema],
      )
    ).rows;
    const columns = (
      await admin.query(
        "SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1" +
          (legacyOnly ? " AND table_name LIKE 'creative_%'" : "") +
          " ORDER BY table_name,ordinal_position",
        [schema],
      )
    ).rows;
    const constraints = (
      await admin.query(
        "SELECT c.relname AS table_name,k.conname AS name,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1" +
          filter +
          " ORDER BY c.relname,k.conname",
        [schema],
      )
    ).rows;
    const triggers = (
      await admin.query(
        "SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal" +
          filter +
          " ORDER BY c.relname,t.tgname",
        [schema],
      )
    ).rows;
    const functions = (
      await admin.query(
        "SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1" +
          (legacyOnly ? " AND p.proname LIKE 'creative_%'" : "") +
          " ORDER BY p.proname",
        [schema],
      )
    ).rows;
    return { relations, columns, constraints, triggers, functions };
  }
  async function legacyRecords() {
    const entries = await Promise.all(
      ["creative_project_schema_version", ...projectTables].map(
        async (table) =>
          [table, await query("SELECT * FROM $schema." + table)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }
  async function ledgerRecords() {
    const names = [
      "schema_version",
      "uploads",
      "heads",
      "parts",
      "part_payloads",
      "events",
    ];
    const result: Record<string, unknown> = {};
    for (const suffix of names) {
      const table =
        suffix === "uploads"
          ? "project_source_uploads"
          : "project_source_upload_" + suffix;
      const rows = await query("SELECT * FROM $schema." + table);
      result[table] = rows.map((row) => ({
        ...row,
        ...(row.payload instanceof Uint8Array
          ? { payload: Array.from(row.payload) }
          : {}),
      }));
    }
    return result;
  }
  async function replaceMarker(
    field: "version" | "storage_realm_id",
    value: unknown,
  ) {
    const table = "project_source_upload_schema_version";
    const trigger = table + "_no_update";
    if (database) {
      const ddl = String(
        database
          .prepare("SELECT sql FROM sqlite_master WHERE name=?")
          .get(trigger)?.sql,
      );
      database.exec("PRAGMA ignore_check_constraints=ON");
      database.exec("DROP TRIGGER " + trigger);
      try {
        database
          .prepare("UPDATE " + table + " SET " + field + "=?")
          .run(value as SQLInputValue);
      } finally {
        database.exec(ddl);
        database.exec("PRAGMA ignore_check_constraints=OFF");
      }
    } else {
      assert.ok(admin);
      await execute(
        "ALTER TABLE $schema." + table + " DISABLE TRIGGER " + trigger,
      );
      if (field === "version")
        await execute(
          "ALTER TABLE $schema." +
            table +
            " DROP CONSTRAINT project_source_upload_schema_version_version_check",
        );
      try {
        await execute("UPDATE $schema." + table + " SET " + field + "=$1", [
          value,
        ]);
      } finally {
        await execute(
          "ALTER TABLE $schema." + table + " ENABLE TRIGGER " + trigger,
        );
      }
    }
  }
  const first = await open();
  if (options.migrateParent !== false) await first.projects.migrate();
  return {
    backend,
    schema,
    first,
    open,
    close,
    query,
    execute,
    catalog,
    legacyRecords,
    ledgerRecords,
    replaceMarker,
    assertSchema,
  };
}

export async function uploadSchemaJournal(store: UploadSchemaStore) {
  const bytes = new TextEncoder().encode("原文");
  const requestDigest = uploadSchemaHash("schema-journal-request");
  const initial: ProjectSourceUploadInitial = {
    schemaVersion: "crewon.project-source-upload.v1",
    storageRealmId: store.storageRealmId,
    uploadId: "schema-journal",
    owner: owner(),
    fileName: "original.txt",
    format: "txt",
    byteLength: bytes.byteLength,
    fileDigest: uploadSchemaHash(bytes),
    partBytes: 65_536,
    partCount: 1,
    requestDigest,
    createdByActorId: actor.actorId,
    createdAt: timestamp,
  };
  const begun = await store.begin(
    {
      actor,
      receipt: { idempotencyKey: "schema-journal", requestDigest },
      initial,
    },
    uploadSchemaGrant("projectSourceUpload:begin", null),
  );
  return store.writePart(
    {
      actor,
      uploadId: initial.uploadId,
      expectedRevision: begun.state.revision,
      at: timestamp,
      part: {
        index: 0,
        byteOffset: 0,
        byteLength: bytes.byteLength,
        rawDigest: uploadSchemaHash(bytes),
      },
      bytes,
    },
    uploadSchemaGrant("projectSourceUpload:write", initial.uploadId),
  );
}
