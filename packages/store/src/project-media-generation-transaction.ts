import {
  captureSqliteAssetLegacyExecution,
  capturePostgresAssetLegacyExecution,
} from "./project-asset-legacy-instruction.ts";
import { assertPostgresProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertPostgresProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertPostgresProjectAssetSchema } from "./project-asset-schema.ts";
import { assertSqliteProjectMediaResultSchema } from "./project-media-result-schema.ts";
import { assertSqliteProjectMediaOperationSchema } from "./project-media-operation-schema.ts";
import { assertSqliteProjectAssetSchema } from "./project-asset-schema.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";
import {
  assertProjectMediaGenerationActive,
  type ProjectMediaGenerationCommitAuthority,
} from "@crewon/application";
import type { MaterialPreparationPlan as ProjectMediaInputPlan } from "./project-material-preparation-plan.ts";
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
  const legacy = captureSqliteAssetLegacyExecution(db);
  let next = plan.next();
  while (!next.done) {
    active();
    let rows: readonly Record<string, unknown>[];
    if ("assetLegacyAccess" in next.value) {
      rows = legacy.execute(next.value);
    } else if ("mediaResultSchema" in next.value) {
      assertSqliteProjectMediaResultSchema(db);
      rows = [];
    } else if ("mediaOperationSchema" in next.value) {
      assertSqliteProjectMediaOperationSchema(db);
      rows = [];
    } else if ("assetSchema" in next.value) {
      assertSqliteProjectAssetSchema(db);
      rows = [];
    } else if ("installation" in next.value) {
      assertSqliteProjectTextUiCommit(db, next.value.installation);
      rows = [];
    } else rows = db.prepare(next.value.sql).all(...next.value.values);
    active();
    next = plan.next(rows);
  }
  legacy.assertCurrent();
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
  const legacy = capturePostgresAssetLegacyExecution(client, schema);
  let next = plan.next();
  while (!next.done) {
    active();
    let rows: readonly Record<string, unknown>[];
    if ("assetLegacyAccess" in next.value) {
      rows = await legacy.execute(next.value);
    } else if ("mediaResultSchema" in next.value) {
      await assertPostgresProjectMediaResultSchema(client, schema);
      rows = [];
    } else if ("mediaOperationSchema" in next.value) {
      await assertPostgresProjectMediaOperationSchema(client, schema);
      rows = [];
    } else if ("assetSchema" in next.value) {
      await assertPostgresProjectAssetSchema(client, schema);
      rows = [];
    } else if ("installation" in next.value) {
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
  await legacy.assertCurrent();
  active();
  return next.value;
}
