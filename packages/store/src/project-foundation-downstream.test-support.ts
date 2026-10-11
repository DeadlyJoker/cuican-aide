import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import {
  capturePostgresProjectFoundationDownstream,
  captureSqliteProjectFoundationDownstream,
  assertPostgresProjectFoundationDownstreamUnchanged,
  assertSqliteProjectFoundationDownstreamUnchanged,
  type ProjectFoundationDownstreamLocator,
  type ProjectFoundationDownstreamSnapshot,
} from "./project-foundation-downstream-guard.ts";
import {
  actor,
  fixture,
  type Backend,
} from "./project-foundation-store.test-support.ts";

/**
 * Real original SQL records; the existing Foundation fixture explicitly seeds an
 * internal ingestion recipe. This tests commit-connection reads, not public upload/Run grants.
 */
export async function downstreamFixture(
  t: TestContext,
  backend: Backend,
  options: { migrate?: boolean } = {},
) {
  const f = await fixture(t, backend, options);
  const database = backend === "sqlite" ? new DatabaseSync(f.path) : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: process.env.CREWON_TEST_POSTGRES_URL,
          max: 1,
        })
      : null;
  t.after(async () => {
    database?.close();
    await pool?.end();
  });
  async function capture(input: ProjectFoundationDownstreamLocator) {
    if (database !== null)
      return captureSqliteProjectFoundationDownstream(database, input);
    const client = await pool!.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      const result = await capturePostgresProjectFoundationDownstream(
        client,
        f.schema,
        input,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function assertUnchanged(
    input: ProjectFoundationDownstreamLocator,
    expected: ProjectFoundationDownstreamSnapshot,
  ) {
    if (database !== null) {
      assertSqliteProjectFoundationDownstreamUnchanged(
        database,
        input,
        expected,
      );
      return;
    }
    const client = await pool!.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
      await assertPostgresProjectFoundationDownstreamUnchanged(
        client,
        f.schema,
        input,
        expected,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const atProject = (
    projectId: string,
  ): ProjectFoundationDownstreamLocator => ({ actor, projectId });
  return { ...f, database, pool, capture, assertUnchanged, atProject };
}
