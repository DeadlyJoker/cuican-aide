import type { Pool, PoolClient } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  type CreativeProjectCommitAuthority,
  type ProjectTextMutationResult,
} from "@crewon/application";
import type { CreativeProjectScope } from "@crewon/domain";
import { assertPostgresProjectRunLease } from "./creative-project-run-commit-postgres.ts";
import type { ProjectRunQualification } from "./creative-project-run-commit-support.ts";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
  type PostgresCreativeProjectLegacyAccess,
} from "./creative-project-legacy-access.ts";
import { textLegacyResultScope } from "./project-text-legacy-access.ts";

/** Owns the original Text transaction, its original policy and lease fences. No new manager or grant. */
export async function commitPostgresLegacyText<
  T extends ProjectTextMutationResult | null | void,
>(
  input: Readonly<{
    pool: Pool;
    schema: string;
    assertOpen(): void;
    body(
      client: PoolClient,
      access: PostgresCreativeProjectLegacyAccess,
    ): Promise<T>;
    authority?: CreativeProjectCommitAuthority;
    runQualification?: ProjectRunQualification;
    scope?: CreativeProjectScope;
    checkDownstream?(client: PoolClient): Promise<void>;
  }>,
): Promise<T> {
  const active = () => {
    assertCreativeProjectCommitActive(input.authority);
    input.assertOpen();
  };
  input.assertOpen();
  if (input.authority !== undefined)
    await assertCreativeProjectCommitCurrent(input.authority);
  active();
  const client = await input.pool.connect();
  try {
    active();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await lockPostgresCreativeProjectLegacySchema(client, input.schema);
    const access = await capturePostgresCreativeProjectLegacyAccess(
      client,
      input.schema,
    );
    if (input.scope !== undefined) await access.assertProject(input.scope);
    const result = await input.body(client, access);
    // New negative SQL and downstream reads finish before original final authorization and lease.
    const current = await capturePostgresCreativeProjectLegacyAccess(
      client,
      input.schema,
    );
    if (input.scope !== undefined) await current.assertProject(input.scope);
    const resultScope = textLegacyResultScope(result);
    if (resultScope !== undefined) await current.assertProject(resultScope);
    await input.checkDownstream?.(client);
    const authority = input.authority;
    if (authority?.planTransaction !== undefined) {
      await authority.planTransaction.assertCurrent();
      await authority.planTransaction.authority.assertTransactionCurrent();
    } else if (authority?.textUiTransaction !== undefined)
      await authority.textUiTransaction.assertCurrent();
    else if (authority?.runTransaction !== undefined)
      await authority.runTransaction.assertCurrent();
    else if (authority !== undefined)
      await assertCreativeProjectCommitCurrent(authority);
    await assertPostgresProjectRunLease(
      client,
      input.schema,
      input.runQualification,
    );
    active();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    client.release();
  }
}
