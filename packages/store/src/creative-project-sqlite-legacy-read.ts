import type { DatabaseSync } from "node:sqlite";
import {
  captureSqliteCreativeProjectLegacyAccess,
  type CreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";

/** Schema inspection and the original read share one database snapshot, even across processes. */
export function readSqliteLegacyCreativeProject<T>(
  database: DatabaseSync,
  read: (access: CreativeProjectLegacyAccess) => T,
): T {
  if (database.isTransaction)
    return read(captureSqliteCreativeProjectLegacyAccess(database));
  database.exec("BEGIN DEFERRED");
  try {
    const result = read(captureSqliteCreativeProjectLegacyAccess(database));
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* Preserve the original read failure. */
    }
    throw error;
  }
}
