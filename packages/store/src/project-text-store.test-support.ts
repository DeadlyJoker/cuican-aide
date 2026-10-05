import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  CreativeProjectApplicationService,
  type ActorContext,
  type CreativeProjectOwnerScope,
} from "@crewon/application";
import { SqliteRunStore } from "./sqlite-run-store.ts";
import { PostgresDomainStore } from "./postgres-domain-store.ts";

export const textActor: ActorContext = Object.freeze({
  tenantId: "tenant-text",
  spaceId: "space-text",
  principalId: "principal-text",
  actorId: "actor-text",
});
export const textAt = "2026-10-05T00:00:00.000Z";
export const textDigester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
export const textOwner = (actor = textActor): CreativeProjectOwnerScope => ({
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  principalId: actor.principalId,
});

/** Owns isolated real databases; every PostgreSQL parent uses exactly one physical pool connection. */
export async function projectTextFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  migrate = true,
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-project-text-"));
  const path = join(root, "text.sqlite");
  const schema = `text_${randomUUID().replaceAll("-", "")}`;
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL;
  if (backend === "postgres") assert.ok(connectionString);
  const admin =
    backend === "postgres" ? new Pool({ connectionString, max: 1 }) : null;
  const db = backend === "sqlite" ? new DatabaseSync(path) : null;
  const parents: (SqliteRunStore | PostgresDomainStore)[] = [];
  const prefix = backend === "postgres" ? `"${schema}".` : "";
  const sql = async (
    query: string,
    values: (string | number | null)[] = [],
  ): Promise<readonly Record<string, unknown>[]> =>
    db
      ? db
          .prepare(query)
          .all(...values)
          .map((row) => ({ ...row }))
      : (await admin!.query<Record<string, unknown>>(query, values)).rows;
  const execute = async (query: string) => {
    if (db) db.exec(query);
    else await admin!.query(query);
  };
  const open = async () => {
    const parent =
      backend === "sqlite"
        ? new SqliteRunStore(path)
        : await PostgresDomainStore.open({
            connectionString: connectionString!,
            schema,
            maxPoolSize: 1,
          });
    parents.push(parent);
    const projects = parent.creativeProjectStore();
    await projects.migrate();
    const text = parent.projectTextStore();
    if (migrate) await text.migrate();
    return { parent, projects, text };
  };
  t.after(async () => {
    try {
      for (const parent of parents) await parent.close();
    } finally {
      db?.close();
      try {
        await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin?.end();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  const first = await open(),
    second = await open();
  const projects = new CreativeProjectApplicationService({
    store: first.projects,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => textAt },
    ids: { nextId: () => randomUUID() },
    digester: textDigester,
  });
  const created = await projects.createProject(textActor, {
    title: "三集悬疑",
    briefText: "修复师在雨夜发现未完成的信。",
    idempotencyKey: "fixture-project",
  });
  const count = async (table: string) => {
    assert.match(table, /^[a-z_]+$/u);
    return Number(
      (await sql(`SELECT COUNT(*) AS n FROM ${prefix}${table}`))[0]?.n,
    );
  };
  return {
    root,
    path,
    schema,
    prefix,
    first,
    second,
    open,
    sql,
    execute,
    count,
    projects,
    created,
  };
}
