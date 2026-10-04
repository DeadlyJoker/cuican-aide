import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import { SqlitePluginCreditStore } from "./sqlite-plugin-credit-store.ts";
import { PostgresPluginCreditStore } from "./postgres-plugin-credit-store.ts";

export type CreditReadBackend = "sqlite" | "postgres";

/** Only owned databases/schemas and named test funds. No migration is implicit in fixture construction. */
export async function creditReadFixture(
  t: TestContext,
  backend: CreditReadBackend,
) {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("credit_read_host_closed");
  };
  if (backend === "sqlite") {
    const directory = await mkdtemp(join(tmpdir(), "crewon-credit-read-"));
    const path = join(directory, "ledger.sqlite");
    const database = new DatabaseSync(path),
      second = new DatabaseSync(path);
    for (const db of [database, second])
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON",
      );
    const first = new SqlitePluginCreditStore({ database, assertOpen }),
      writer = new SqlitePluginCreditStore({ database: second, assertOpen });
    t.after(async () => {
      closed = true;
      second.close();
      database.close();
      await rm(directory, { recursive: true, force: true });
    });
    return {
      first,
      writer,
      prefix: "main.",
      schema: null,
      database,
      pool: null,
      closeHost() {
        closed = true;
      },
      async execute(sql: string, values: unknown[] = []) {
        if (values.length)
          database.prepare(sql).run(...(values as (string | number | null)[]));
        else database.exec(sql);
      },
      async rows(
        sql: string,
        values: unknown[] = [],
      ): Promise<Record<string, unknown>[]> {
        return database
          .prepare(sql)
          .all(...(values as (string | number | null)[])) as Record<
          string,
          unknown
        >[];
      },
      async catalog() {
        return database
          .prepare(
            "SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
          )
          .all();
      },
      async changes() {
        return database.prepare("SELECT total_changes() AS changes").get()!
          .changes;
      },
      async interceptAccountRead(write: () => Promise<unknown>) {
        const prepare = database.prepare.bind(database);
        let intercepted = false;
        let completion: Promise<unknown> | undefined;
        database.prepare = ((sql: string) => {
          const statement = prepare(sql);
          if (
            sql.startsWith(
              "SELECT revision,account_json FROM main.plugin_credit_accounts",
            )
          ) {
            const all = statement.all.bind(statement);
            statement.all = ((...values: (string | number | null)[]) => {
              const rows = all(...values);
              if (!intercepted) {
                intercepted = true;
                completion = write();
              }
              return rows;
            }) as typeof statement.all;
          }
          return statement;
        }) as typeof database.prepare;
        return {
          async finish() {
            database.prepare = prepare;
            if (completion) await completion;
            return intercepted;
          },
        };
      },
    };
  }
  const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
  const schema = `credit_read_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 1 }),
    pool = new Pool({ connectionString, max: 2 }),
    writerPool = new Pool({ connectionString, max: 2 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const first = new PostgresPluginCreditStore({ pool, schema, assertOpen }),
    writer = new PostgresPluginCreditStore({
      pool: writerPool,
      schema,
      assertOpen,
    });
  t.after(async () => {
    closed = true;
    await Promise.all([pool.end(), writerPool.end()]);
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  return {
    first,
    writer,
    prefix: `"${schema}".`,
    schema,
    database: null,
    pool,
    closeHost() {
      closed = true;
    },
    async execute(sql: string, values: unknown[] = []) {
      await admin.query(sql, values);
    },
    async rows(
      sql: string,
      values: unknown[] = [],
    ): Promise<Record<string, unknown>[]> {
      return (await admin.query(sql, values)).rows as Record<string, unknown>[];
    },
    async catalog() {
      return (
        await admin.query(
          "SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 ORDER BY c.relname",
          [schema],
        )
      ).rows;
    },
    async changes() {
      return (
        await admin.query(
          "SELECT xact_commit,xact_rollback FROM pg_stat_database WHERE datname=current_database()",
        )
      ).rows;
    },
    async interceptAccountRead(write: () => Promise<unknown>) {
      const connect = pool.connect.bind(pool);
      let intercepted = false;
      const restores: (() => void)[] = [];
      pool.connect = (async () => {
        const client = await connect(),
          query = client.query.bind(client);
        client.query = (async (...args: unknown[]) => {
          const result = await Reflect.apply(query, client, args);
          if (
            !intercepted &&
            typeof args[0] === "string" &&
            args[0].startsWith("SELECT revision,account_json FROM")
          ) {
            intercepted = true;
            await write();
          }
          return result;
        }) as typeof client.query;
        restores.push(() => {
          client.query = query;
        });
        return client;
      }) as typeof pool.connect;
      return {
        async finish() {
          pool.connect = connect;
          for (const restore of restores) restore();
          return intercepted;
        },
      };
    },
  };
}

export async function creditReadAllRows(
  f: Awaited<ReturnType<typeof creditReadFixture>>,
) {
  const tables = [
    "plugin_credit_accounts",
    "plugin_credit_entries",
    "plugin_credit_reservations",
    "plugin_credit_grant_receipts",
    "plugin_credit_schema_version",
  ];
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (name) => [
        name,
        (await f.rows(`SELECT * FROM ${f.prefix}${name}`))
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
  );
}
