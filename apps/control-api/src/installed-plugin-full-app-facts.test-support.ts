import assert from "node:assert/strict";
import type { PostgresDomainStore } from "@crewon/store";
import type { Pool } from "pg";
import { installedProcessActor as actor } from "../../runtime-worker/src/installed-plugin-worker-process.test-support.ts";
import { taskProcessCreditScope } from "./installed-plugin-tasks-process-authorities.test-support.ts";

/** Read-only facts from the same actual PostgreSQL authority used by the product processes. */
export async function fullAppStoreFacts(
  input: Readonly<{
    database: Pool;
    store: PostgresDomainStore;
    schema: string;
    runId?: string;
    threadId?: string;
  }>,
) {
  assert.match(input.schema, /^full_app_[a-f0-9]{32}$/u);
  const prefix = `"${input.schema}"`;
  const threadsResult = await input.database.query<{ thread_id: string }>(
    `SELECT thread_id FROM ${prefix}.threads WHERE tenant_id=$1 AND space_id=$2 ORDER BY thread_id LIMIT 17`,
    [actor.tenantId, actor.spaceId],
  );
  const runsResult = await input.database.query<{ run_id: string }>(
    `SELECT run_id FROM ${prefix}.run_snapshots WHERE tenant_id=$1 AND space_id=$2 ORDER BY run_id LIMIT 17`,
    [actor.tenantId, actor.spaceId],
  );
  assert.ok(threadsResult.rows.length <= 16 && runsResult.rows.length <= 16);
  const threads = await Promise.all(
    threadsResult.rows.map(async (row) => {
      const thread = await input.store.loadThreadInSpace({
        ...actor,
        threadId: row.thread_id,
      });
      assert.ok(thread);
      return thread;
    }),
  );
  const runs = await Promise.all(
    runsResult.rows.map(async (row) => {
      const run = await input.store.loadRunInSpace({
        ...actor,
        runId: row.run_id,
      });
      assert.ok(run);
      return run;
    }),
  );
  const extensions = input.store.extensionStore();
  const selected = runs.filter(
    (run) => input.runId === undefined || run.runId === input.runId,
  );
  const bindings = [],
    admissions = [],
    creditAdmissions = [],
    operations = [],
    events = [];
  for (const run of selected) {
    const locator = { ...actor, runId: run.runId };
    const binding = await extensions.loadExtensionRunBinding(locator);
    const admission = await extensions.loadPluginTaskAdmission!(locator);
    if (binding) {
      bindings.push(binding);
      const credit = await extensions.loadExtensionCreditAdmission(binding);
      if (credit) creditAdmissions.push(credit);
      const operationPage = await input.store
        .externalOperationStore()
        .listExternalOperations({
          tenantId: actor.tenantId,
          runId: run.runId,
          bindingDigest: binding.bindingDigest,
          limit: 16,
        });
      assert.equal(operationPage.truncated, false);
      operations.push(...operationPage.operations);
    }
    if (admission) admissions.push(admission);
    const page = await input.store.listRunEvents(locator, 0, 256);
    assert.ok(
      page.length < 256,
      "the fixture must not truncate the observed Run events",
    );
    events.push(...page);
  }
  const holdsResult = await input.database.query<{ record_json: unknown }>(
    `SELECT record_json FROM ${prefix}.plugin_credit_reservations WHERE tenant_id=$1 AND principal_id=$2 AND pool_id=$3 ORDER BY reservation_id LIMIT 17`,
    [
      taskProcessCreditScope.tenantId,
      taskProcessCreditScope.principalId,
      taskProcessCreditScope.poolId,
    ],
  );
  assert.ok(holdsResult.rows.length <= 16);
  const transcriptResult = await input.database.query<{
    message_json: unknown;
  }>(
    `SELECT m.message_json FROM ${prefix}.messages m JOIN ${prefix}.threads t ON t.tenant_id=m.tenant_id AND t.thread_id=m.thread_id WHERE t.tenant_id=$1 AND t.space_id=$2 AND ($3::text IS NULL OR t.thread_id=$3) ORDER BY m.thread_id,m.sequence LIMIT 129`,
    [actor.tenantId, actor.spaceId, input.threadId ?? null],
  );
  assert.ok(transcriptResult.rows.length <= 128);
  const receiptsResult = await input.database.query<{ state_json: unknown }>(
    `SELECT state_json FROM ${prefix}.tool_execution_receipts WHERE tenant_id=$1 AND ($2::text IS NULL OR run_id=$2) ORDER BY receipt_id LIMIT 33`,
    [actor.tenantId, input.runId ?? null],
  );
  assert.ok(receiptsResult.rows.length <= 32);
  return {
    threads,
    runs,
    bindings,
    admissions,
    creditAdmissions,
    operations,
    events,
    creditHolds: holdsResult.rows.map((row) => row.record_json),
    creditAccount: await input.store
      .pluginCreditStore()
      .getAccount(taskProcessCreditScope),
    toolReceipts: receiptsResult.rows.map((row) => row.state_json),
    transcript: transcriptResult.rows.map((row) => row.message_json),
    counts: {
      threads: threads.length,
      runs: runs.length,
      admissions: admissions.length,
      holds: holdsResult.rows.length,
    },
    settlementExecuted: false,
  };
}
