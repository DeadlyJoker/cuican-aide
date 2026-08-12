import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

import { PostgresWorkflowRunCompositionStore } from "./postgres-workflow-run-composition-store.ts";
import { migratePostgresWorkflowExecutions } from "./workflow-execution-schema.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

if (postgresUrl === undefined) {
  test.skip("PostgreSQL Workflow execution migrations require CREWON_TEST_POSTGRES_URL", () => {});
} else {
  for (const legacyVersion of [1, 2, 3, 4, 5, 6] as const) {
    test(`PostgreSQL Workflow execution v${legacyVersion} migrates through v7`, async () => {
      const schema = `workflow_execution_v${legacyVersion}_${randomUUID().replaceAll("-", "")}`;
      const pool = new Pool({ connectionString: postgresUrl });
      const store = await PostgresWorkflowRunCompositionStore.open({
        pool,
        schema,
        digester,
      });
      await store.close();
      try {
        await prepareLegacyVersion(pool, schema, legacyVersion);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await migratePostgresWorkflowExecutions(client, schema);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
        const version = await pool.query<{ version: number }>(
          `SELECT version FROM ${schema}.workflow_execution_schema WHERE singleton=true`,
        );
        assert.equal(version.rows[0]?.version, 7);
        const columns = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema=$1 AND table_name='workflow_run_admission_receipts'
           ORDER BY ordinal_position`,
          [schema],
        );
        assert.deepEqual(
          columns.rows.map((row) => row.column_name),
          [
            "tenant_id",
            "scope",
            "idempotency_key",
            "fingerprint",
            "run_id",
            "result_json",
          ],
        );
      } finally {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
        await pool.end();
      }
    });
  }
}

async function prepareLegacyVersion(
  pool: Pool,
  schema: string,
  version: number,
) {
  if (version <= 3)
    await pool.query(`DROP TABLE ${schema}.workflow_execution_values`);
  if (version <= 2)
    await pool.query(`DROP TABLE ${schema}.workflow_gate_requests,
      ${schema}.workflow_composition_receipts`);
  if (version <= 5)
    await pool.query(`DROP TABLE ${schema}.workflow_run_admission_receipts`);
  if (version === 1)
    await pool.query(
      `ALTER TABLE ${schema}.workflow_execution_receipts DROP COLUMN result_json`,
    );
  if (version === 6) {
    await pool.query(`ALTER TABLE ${schema}.workflow_composition_receipts
      DROP CONSTRAINT workflow_composition_receipts_kind_check`);
    await pool.query(`ALTER TABLE ${schema}.workflow_composition_receipts
      ADD CONSTRAINT workflow_composition_receipts_kind_check CHECK
      (kind IN ('admit','scheduleNodes','admitNode','settleNode','recordGateDecision','settleGate','scheduleReconciliation','cancelExecution'))`);
  }
  await pool.query(
    `UPDATE ${schema}.workflow_execution_schema SET version=$1`,
    [version],
  );
}
