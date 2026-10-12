import type { Pool } from "pg";
import {
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitCurrent,
  assertCreativeProjectCommitTransactionCurrent,
  type CreativeProjectCommitAuthority,
} from "@crewon/application";
import { assertPostgresProjectRunLease } from "./creative-project-run-commit-postgres.ts";
import type { ProjectRunQualification } from "./creative-project-run-commit-support.ts";
import {
  capturePostgresCreativeProjectLegacyAccess,
  lockPostgresCreativeProjectLegacySchema,
} from "./creative-project-legacy-access.ts";
import {
  finishPostgresCreativeProjectLegacyMutation,
  type PostgresCreativeProjectLegacyMutationFence,
} from "./creative-project-legacy-mutation-access.ts";
import type { PostgresCreativeProjectLegacyRead } from "./creative-project-postgres-legacy-read.ts";
import { rollbackPostgres } from "./postgres-store-support.ts";
/** Original Store pool, transaction, fences and COMMIT semantics; no new runtime. */
export async function transactPostgresCreativeProject<T>(
  input: Readonly<{ pool: Pool; schema: string; assertOpen(): void }>,
  body: PostgresCreativeProjectLegacyRead<T>,
  authority?: CreativeProjectCommitAuthority,
  runQualification?: ProjectRunQualification,
  assertLegacy?: PostgresCreativeProjectLegacyMutationFence,
): Promise<T> {
  input.assertOpen();
  if (authority !== undefined) {
    await assertCreativeProjectCommitCurrent(authority);
    assertCreativeProjectCommitActive(authority);
    input.assertOpen();
  }
  const client = await input.pool.connect();
  try {
    input.assertOpen();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    input.assertOpen();
    await lockPostgresCreativeProjectLegacySchema(client, input.schema);
    const access = await capturePostgresCreativeProjectLegacyAccess(
      client,
      input.schema,
    );
    const result = await body(client, access);
    // Revalidate after all SQL awaits, including lock waits and the final receipt INSERT.
    if (authority !== undefined)
      await assertCreativeProjectCommitTransactionCurrent(authority);
    await assertPostgresProjectRunLease(client, input.schema, runQualification);
    await finishPostgresCreativeProjectLegacyMutation({
      client,
      schema: input.schema,
      assertLegacy,
      authority,
      runQualification,
    });
    assertCreativeProjectCommitActive(authority);
    // A confirmed COMMIT remains successful even if the host closes while awaiting it.
    input.assertOpen();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await rollbackPostgres(client);
    throw error;
  } finally {
    client.release();
  }
}
