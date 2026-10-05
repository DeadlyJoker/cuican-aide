import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import { RunStoreError } from "@crewon/application";
import type { ThreadState } from "@crewon/domain";
import {
  sqliteThreadBindingMarker,
  postgresThreadBindingMarker,
} from "./project-conversation-markers.ts";
/** Recheck under the original Thread transaction/lock: an earlier HTTP read is insufficient. */
export function assertSqliteOrdinaryTurnProjectScope(
  db: DatabaseSync,
  thread: ThreadState,
): void {
  if (sqliteThreadBindingMarker(db, thread) !== null)
    throw new RunStoreError("project_conversation_scope_conflict");
}
export async function assertPostgresOrdinaryTurnProjectScope(
  client: PoolClient,
  schema: string,
  thread: ThreadState,
): Promise<void> {
  if ((await postgresThreadBindingMarker(client, schema, thread)) !== null)
    throw new RunStoreError("project_conversation_scope_conflict");
}
