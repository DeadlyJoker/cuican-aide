import { DatabaseSync } from "node:sqlite";
import { BoundedPostgresPool } from "./bounded-postgres-pool.ts";
import {
  readModelAccountingReport,
  type ModelAccountingReportInput,
} from "./model-accounting-reader.ts";

/** Does not migrate, repair or create indexes in the user's database. */
export async function readSqliteModelAccountingReport(
  input: ModelAccountingReportInput & { databasePath: string },
) {
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    if (
      !database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='model_usage_call_identity'",
        )
        .get()
    )
      throw new Error("model_accounting_index_unavailable");
    return await readModelAccountingReport(
      {
        postgres: false,
        schema: "",
        query: async (sql, parameters) =>
          database.prepare(sql).all(...parameters),
        transaction: async (work) => {
          database.exec("BEGIN");
          try {
            const result = await work();
            database.exec("COMMIT");
            return result;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      },
      input,
    );
  } finally {
    database.close();
  }
}

/** A dedicated bounded connection, read-only short snapshots; never shares Worker write transactions. */
export async function readPostgresModelAccountingReport(
  input: ModelAccountingReportInput & {
    connectionString: string;
    schema: string;
  },
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(input.schema))
    throw new Error("model_accounting_schema_invalid");
  const pool = new BoundedPostgresPool(
    {
      connectionString: input.connectionString,
      max: 1,
      connectionTimeoutMillis: 3000,
      statement_timeout: 1000,
      idle_in_transaction_session_timeout: 5000,
      options: "-c default_transaction_read_only=on",
    },
    { queryTimeoutMs: 3000, closeTimeoutMs: 3000 },
  );
  try {
    const client = await pool.connect();
    try {
      const index = await client.query(
        "SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname='model_usage_call_identity'",
        [input.schema],
      );
      if (!index.rows.length)
        throw new Error("model_accounting_index_unavailable");
      return await readModelAccountingReport(
        {
          postgres: true,
          schema: `"${input.schema}".`,
          query: async (sql, parameters) =>
            (await client.query(sql, [...parameters])).rows,
          transaction: async (work) => {
            await client.query(
              "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
            );
            const result = await work();
            await client.query("COMMIT");
            return result;
          },
        },
        input,
      );
    } finally {
      // Closing the dedicated connection also rolls back a failed read-only snapshot;
      // do not queue another query on a socket whose read deadline may have expired.
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
