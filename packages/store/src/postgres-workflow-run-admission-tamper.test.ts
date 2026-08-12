import assert from "node:assert/strict";
import test from "node:test";

import {
  actor,
  command,
  postgresFixture,
  service,
} from "./postgres-workflow-run-admission.test.ts";
import { createRunningCommitFixture } from "./run-store-conformance.test-support.ts";

const postgresUrl = process.env.CREWON_TEST_POSTGRES_URL;

if (postgresUrl === undefined) {
  test.skip("PostgreSQL Workflow admission tamper suite requires CREWON_TEST_POSTGRES_URL", () => {});
} else {
  test("deep replay rejects every durable authority tamper", async () => {
    const fixture = await postgresFixture();
    try {
      const first = await service(fixture.admission).startWorkflowRun(
        actor(),
        command(),
      );
      const runId = first.run.state.runId;
      const ordinary = await fixture.domain.commitRun(
        createRunningCommitFixture(),
      );
      const cases = [
        {
          name: "Run snapshot",
          mutate: `UPDATE ${fixture.schema}.run_snapshots SET state_json=jsonb_set(state_json,'{spaceId}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.run_snapshots SET state_json=$2 WHERE run_id=$1`,
          original: first.run.state,
        },
        {
          name: "Run event",
          mutate: `UPDATE ${fixture.schema}.run_events SET event_json=jsonb_set(event_json,'{data,spaceId}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.run_events SET event_json=$2 WHERE run_id=$1`,
          original: first.run.events[0],
        },
        {
          name: "Outbox",
          mutate: `UPDATE ${fixture.schema}.outbox SET message_json=jsonb_set(message_json,'{topic}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.outbox SET message_json=$2 WHERE run_id=$1`,
          original: first.run.outbox[0],
        },
        {
          name: "WorkItem",
          mutate: `UPDATE ${fixture.schema}.work_items SET work_item_json=jsonb_set(work_item_json,'{payload,trigger}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.work_items SET work_item_json=$2 WHERE run_id=$1`,
          original: first.run.workItems[0],
        },
        {
          name: "root value",
          mutate: `UPDATE ${fixture.schema}.workflow_execution_values SET value_json='{"topic":"tampered"}'::jsonb WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.workflow_execution_values SET value_json=$2 WHERE run_id=$1`,
          original: command().input,
        },
        {
          name: "specialized receipt",
          mutate: `UPDATE ${fixture.schema}.workflow_run_admission_receipts SET result_json=jsonb_set(result_json,'{result,run,state,spaceId}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.workflow_run_admission_receipts SET result_json=$2 WHERE run_id=$1`,
          original: await receiptJson(
            fixture.pool,
            fixture.schema,
            "workflow_run_admission_receipts",
            runId,
          ),
        },
        {
          name: "general receipt",
          mutate: `UPDATE ${fixture.schema}.idempotency_receipts SET result_json=jsonb_set(result_json,'{state,spaceId}','"tampered"') WHERE run_id=$1`,
          restore: `UPDATE ${fixture.schema}.idempotency_receipts SET result_json=$2 WHERE run_id=$1`,
          original: first.run,
        },
      ];
      for (const tamper of cases) {
        await fixture.pool.query(tamper.mutate, [runId]);
        await assert.rejects(
          service(fixture.admission).startWorkflowRun(actor(), command()),
          /workflow_run_admission_receipt_corrupt/u,
          tamper.name,
        );
        await fixture.pool.query(tamper.restore, [runId, tamper.original]);
      }

      await fixture.pool.query(
        `UPDATE ${fixture.schema}.workflow_run_admission_receipts
         SET run_id=$2 WHERE run_id=$1`,
        [runId, ordinary.state.runId],
      );
      await assert.rejects(
        service(fixture.admission).startWorkflowRun(actor(), command()),
        /workflow_run_admission_receipt_corrupt/u,
        "specialized receipt run_id",
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.workflow_run_admission_receipts
         SET run_id=$2 WHERE run_id=$1`,
        [ordinary.state.runId, runId],
      );

      const descriptor = await receiptJson(
        fixture.pool,
        fixture.schema,
        "workflow_run_admission_receipts",
        runId,
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.workflow_run_admission_receipts
         SET result_json=jsonb_set(result_json,'{generalIdempotency,requestFingerprint}','"tampered"')
         WHERE run_id=$1`,
        [runId],
      );
      await assert.rejects(
        service(fixture.admission).startWorkflowRun(actor(), command()),
        /workflow_run_admission_receipt_corrupt/u,
        "general receipt descriptor",
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.workflow_run_admission_receipts
         SET result_json=$2 WHERE run_id=$1`,
        [runId, descriptor],
      );

      const specialized = await receiptJson(
        fixture.pool,
        fixture.schema,
        "workflow_run_admission_receipts",
        runId,
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.outbox
           SET message_json=jsonb_set(message_json,'{payload,throughSequence}','2')
         WHERE run_id=$1;
         UPDATE ${fixture.schema}.idempotency_receipts
           SET result_json=jsonb_set(result_json,'{outbox,0,payload,throughSequence}','2')
         WHERE run_id=$1;
         UPDATE ${fixture.schema}.workflow_run_admission_receipts
           SET result_json=jsonb_set(result_json,'{result,run,outbox,0,payload,throughSequence}','2')
         WHERE run_id=$1`,
        [runId],
      );
      await assert.rejects(
        service(fixture.admission).startWorkflowRun(actor(), command()),
        /workflow_run_admission_receipt_corrupt/u,
        "correlated receipt and durable JSON tamper",
      );
      await fixture.pool.query(
        `UPDATE ${fixture.schema}.workflow_run_admission_receipts
         SET result_json=$2 WHERE run_id=$1`,
        [runId, specialized],
      );
    } finally {
      await fixture.close();
    }
  });
}

async function receiptJson(
  pool: import("pg").Pool,
  schema: string,
  table: string,
  runId: string,
) {
  const result = await pool.query<{ result_json: unknown }>(
    `SELECT result_json FROM ${schema}.${table} WHERE run_id=$1`,
    [runId],
  );
  return result.rows[0]!.result_json;
}
