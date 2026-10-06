import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertProjectMediaGenerationActive,
  type ProjectMediaGenerationCommitAuthority,
} from "@crewon/application";
import type { ProjectMediaInputPlan } from "./project-media-input-plan.ts";
import {
  assertSqliteProjectTextUiCommit,
  assertPostgresProjectTextUiCommit,
} from "./project-text-ui-commit-support.ts";

/** Borrow the original Turn connection. No BEGIN, pool borrow, file read or HTTP. */
export function executeSqliteMediaGenerationPlan<T>(
  db: DatabaseSync,
  plan: ProjectMediaInputPlan<T>,
  assertOpen: () => void,
  authority?: ProjectMediaGenerationCommitAuthority,
): T {
  const active = () => {
    assertOpen();
    if (authority) assertProjectMediaGenerationActive(authority);
  };
  let next = plan.next();
  while (!next.done) {
    active();
    let rows: readonly Record<string, unknown>[];
    if ("installation" in next.value) {
      assertSqliteProjectTextUiCommit(db, next.value.installation);
      rows = [];
    } else rows = db.prepare(next.value.sql).all(...next.value.values);
    active();
    next = plan.next(rows);
  }
  active();
  return next.value;
}
export async function executePostgresMediaGenerationPlan<T>(
  client: PoolClient,
  schema: string,
  plan: ProjectMediaInputPlan<T>,
  assertOpen: () => void,
  authority?: ProjectMediaGenerationCommitAuthority,
): Promise<T> {
  const active = () => {
    assertOpen();
    if (authority) assertProjectMediaGenerationActive(authority);
  };
  let next = plan.next();
  while (!next.done) {
    active();
    let rows: readonly Record<string, unknown>[];
    if ("installation" in next.value) {
      await assertPostgresProjectTextUiCommit(
        client,
        schema,
        next.value.installation,
      );
      rows = [];
    } else
      rows = (await client.query(next.value.sql, [...next.value.values])).rows;
    active();
    next = plan.next(rows);
  }
  active();
  return next.value;
}
