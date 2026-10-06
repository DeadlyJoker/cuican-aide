import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import type { MediaOperationPlan } from "./project-media-operation-plan.ts";
import {
  assertSqliteProjectMediaOperationSchema,
  assertPostgresProjectMediaOperationSchema,
} from "./project-media-operation-schema.ts";
/** Borrow the original operation transaction, with activity checks at every SQL boundary. */
export function executeSqliteMediaOperationPlan<T>(
  db: DatabaseSync,
  plan: MediaOperationPlan<T>,
  assertOpen: () => void,
): T {
  let next = plan.next();
  while (!next.done) {
    assertOpen();
    let rows: readonly Record<string, unknown>[];
    if ("mediaOperationSchema" in next.value) {
      assertSqliteProjectMediaOperationSchema(db);
      rows = [];
    } else rows = db.prepare(next.value.sql).all(...next.value.values);
    assertOpen();
    next = plan.next(rows);
  }
  assertOpen();
  return next.value;
}
export async function executePostgresMediaOperationPlan<T>(
  client: PoolClient,
  schema: string,
  plan: MediaOperationPlan<T>,
  assertOpen: () => void,
): Promise<T> {
  let next = plan.next();
  while (!next.done) {
    assertOpen();
    let rows: readonly Record<string, unknown>[];
    if ("mediaOperationSchema" in next.value) {
      await assertPostgresProjectMediaOperationSchema(client, schema);
      rows = [];
    } else
      rows = (await client.query(next.value.sql, [...next.value.values])).rows;
    assertOpen();
    next = plan.next(rows);
  }
  assertOpen();
  return next.value;
}
