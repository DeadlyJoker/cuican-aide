import type { DatabaseSync } from "node:sqlite";
import type { Pool, PoolClient } from "pg";
import { rollbackPostgres } from "./postgres-store-support.ts";

/** Original explicit DDL only. The callback retains its original schema lock and validation. */
export async function commitOriginalProjectMigration<T>(
  input: Readonly<{
    pool: Pool;
    assertOpen(): void;
    migrate(client: PoolClient): Promise<T>;
  }>,
): Promise<T> {
  input.assertOpen();
  const client = await input.pool.connect();
  try {
    input.assertOpen();
    await client.query("BEGIN");
    input.assertOpen();
    const result = await input.migrate(client);
    input.assertOpen();
    // A confirmed original COMMIT remains successful if the owner closes while awaiting it.
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  } finally {
    client.release();
  }
}

/** No data reader, ownership inspection, repair or qualification is issued by this DDL path. */
export function commitOriginalSqliteProjectMigration(
  input: Readonly<{
    database: DatabaseSync;
    assertOpen(): void;
    migrate(): void;
  }>,
): void {
  input.assertOpen();
  input.database.exec("BEGIN IMMEDIATE");
  try {
    input.migrate();
    input.assertOpen();
    input.database.exec("COMMIT");
  } catch (error) {
    try {
      input.database.exec("ROLLBACK");
    } catch {
      // Preserve the original DDL failure.
    }
    throw error;
  }
}
