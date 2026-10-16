import assert from "node:assert/strict";
import test from "node:test";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { postgresWorkflowChildWorker } from "./postgres-workflow-worker.test-support.ts";
import {
  claimParent,
  postgresParentWorker,
} from "./postgres-workflow-parent.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL one experimental Worker parks the parent, runs its child and verifier, and publishes the final reply exactly once",
  async (t) => {
    const f = await postgresCompositionFixture(t, { prepare: false });
    const prefix = await f.store.listModelHistoryItems(
      { tenantId: f.root.tenantId, threadId: f.root.threadId },
      0,
      100,
    );
    const runtime = await postgresParentWorker(f, t);
    assert.equal((await runtime.worker.wake()).kind, "workflowWaiting");
    assert.equal(runtime.requests.length, 0);
    assert.equal((await runtime.worker.wake()).kind, "completed");
    assert.equal((await runtime.worker.wake()).kind, "workflowWaiting");
    assert.equal((await runtime.worker.wake()).kind, "completed");
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "completed",
      runId: f.root.runId,
    });
    assert.equal((await runtime.worker.wake()).kind, "idle");
    const root = (await f.store.loadRun(f.root))!;
    assert.equal(root.status, "completed");
    assert.equal(runtime.requests.length, 2);
    assert.ok(
      runtime.requests.every((request) => request.runId !== root.runId),
    );
    assert.equal(
      (
        await f.store.listMessages(
          { tenantId: root.tenantId, threadId: root.threadId },
          0,
          100,
        )
      ).at(-1)!.content,
      '{"topic":"child-result"}',
    );
    assert.deepEqual(
      (
        await f.store.listModelHistoryItems(
          { tenantId: root.tenantId, threadId: root.threadId },
          0,
          100,
        )
      ).slice(0, prefix.length),
      prefix,
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
    assert.equal(
      await f.store.loadActiveRunInThread({
        tenantId: root.tenantId,
        spaceId: root.spaceId,
        threadId: root.threadId,
      }),
      null,
    );
    assert.deepEqual(
      await f.store.listModelUsage({
        tenantId: root.tenantId,
        runId: root.runId,
        afterOrder: 0,
        limit: 10,
      }),
      [],
    );
  },
);

pgTest(
  "PostgreSQL a parked parent resumes after closing its Worker and completes a larger DAG without occupying a model slot",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: parallelVersion(8),
      prepare: false,
    });
    const first = await postgresParentWorker(f, t);
    assert.equal((await first.worker.wake()).kind, "workflowWaiting");
    await first.worker.close();
    assert.equal(first.requests.length, 0);
    const resumed = await postgresParentWorker(f, t);
    let peak = 4;
    for (let n = 0; n < 60; n++) {
      const outcome = await resumed.worker.wake();
      const active = Number(
        (
          await f.admin.query(
            `SELECT count(*) AS n FROM ${f.sql}.workflow_node_children c JOIN ${f.sql}.run_snapshots r ON r.tenant_id=c.tenant_id AND r.run_id=c.child_run_id WHERE r.state_json->>'status' NOT IN ('completed','failed','canceled')`,
          )
        ).rows[0].n,
      );
      peak = Math.max(peak, active);
      assert.ok(active <= 4);
      if (outcome.kind === "idle") break;
    }
    assert.equal(peak, 4);
    assert.equal(resumed.requests.length, 9);
    assert.equal((await f.store.loadRun(f.root))!.status, "completed");
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);

pgTest(
  "PostgreSQL child completion between admission and parent acknowledgement creates a new operation without losing either wake",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const child = await postgresWorkflowChildWorker(f, t);
    let once = true;
    const parent = await postgresParentWorker(f, t, {
      afterAdmit: async () => {
        if (once) {
          once = false;
          assert.equal((await child.worker.wake()).kind, "completed");
        }
      },
    });
    assert.deepEqual(await parent.worker.wake(), {
      kind: "retried",
      runId: f.root.runId,
      code: "workflow_scheduler_ready",
    });
    for (let n = 0; n < 12; n++)
      if ((await parent.worker.wake()).kind === "idle") break;
    assert.equal(child.requests.length, 1);
    assert.equal(parent.requests.length, 1);
    assert.equal((await f.store.loadRun(f.root))!.status, "completed");
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);

for (const mutation of [
  "DELETE FROM idempotency_receipts WHERE scope LIKE 'workflow-child:%'",
  "UPDATE work_items SET status='completed',completed_at=clock_timestamp() WHERE run_id IN (SELECT child_run_id FROM workflow_node_children)",
  "UPDATE work_items SET work_item_json=jsonb_set(work_item_json,'{payload,throughSequence}','2') WHERE run_id IN (SELECT child_run_id FROM workflow_node_children)",
  "ALTER TABLE run_snapshots DISABLE TRIGGER workflow_child_terminal_wake",
])
  pgTest(
    `PostgreSQL parent parking refuses a missing or corrupt durable child wake source: ${mutation}`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      await f.composition.admitWorkflowNodes(f.input);
      await f.admin.query(`SET search_path TO ${f.sql}; ${mutation}`);
      const before = await f.snapshot();
      await assert.rejects(f.composition.finishWorkflowSchedulerPass(f.input));
      assert.deepEqual(await f.snapshot(), before);
    },
  );

for (const target of ["enqueue", "acknowledge"])
  pgTest(
    `PostgreSQL ${target} failure rolls back parent acknowledgement and successor together`,
    async (t) => {
      const f = await postgresCompositionFixture(t);
      const child = await postgresWorkflowChildWorker(f, t);
      await f.composition.admitWorkflowNodes(f.input);
      await child.worker.wake();
      const timing =
        target === "enqueue" ? "BEFORE INSERT" : "BEFORE UPDATE OF status";
      await f.admin.query(
        `CREATE FUNCTION ${f.sql}.reject_parent_pass() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.run_id='${f.root.runId}' THEN RAISE EXCEPTION 'fixture_parent_pass'; END IF; RETURN NEW; END$$;CREATE TRIGGER fixture_parent_pass ${timing} ON ${f.sql}.work_items FOR EACH ROW EXECUTE FUNCTION ${f.sql}.reject_parent_pass()`,
      );
      const before = await f.snapshot();
      await assert.rejects(f.composition.finishWorkflowSchedulerPass(f.input));
      assert.deepEqual(await f.snapshot(), before);
      await f.admin.query(
        `DROP TRIGGER fixture_parent_pass ON ${f.sql}.work_items`,
      );
      assert.equal(
        (await f.composition.finishWorkflowSchedulerPass(f.input)).kind,
        "ready",
      );
    },
  );
