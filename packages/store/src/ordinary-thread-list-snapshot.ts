import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { ThreadListQuery } from "@crewon/application";
import { threadListSql } from "./thread-list-query.ts";
import {
  sqliteOrdinaryThreadCatalogTables,
  postgresOrdinaryThreadCatalogTables,
} from "./plugin-thread-catalog-scope.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
import type { PostgresThreadRow } from "./postgres-thread-codec.ts";

/** Schema discovery and rows must share one snapshot: first-time Workflow/plugin
 * activation can otherwise commit hidden Threads between these two reads.
 */
export function readSqliteOrdinaryThreadList(
  db: DatabaseSync,
  query: ThreadListQuery,
) {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec("BEGIN");
  try {
    const statement = threadListSql(
      query,
      "threads",
      "sqlite",
      sqliteOrdinaryThreadCatalogTables(db),
    );
    const rows = db.prepare(statement.sql).all(...statement.values);
    if (ownsTransaction) db.exec("COMMIT");
    return rows;
  } catch (error) {
    if (ownsTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw error;
  }
}

export async function readPostgresOrdinaryThreadList(
  client: PoolClient,
  schema: string,
  query: ThreadListQuery,
) {
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ownership = await postgresOrdinaryThreadCatalogTables(client, schema);
    const statement = threadListSql(
      query,
      `"${schema}"."threads"`,
      "postgres",
      ownership,
    );
    const result = await client.query<PostgresThreadRow>(
      statement.sql,
      statement.values,
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  }
}
