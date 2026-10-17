import assert from "node:assert/strict";
import test from "node:test";
import { schedulerFixture } from "../../../packages/store/src/workflow-scheduler.test-support.ts";
import { schedulerWorker } from "./workflow-scheduler.test-support.ts";
import { oversizedChildVersion } from "../../../packages/store/src/workflow-preparation-failure.test-support.ts";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { postgresParentWorker } from "./postgres-workflow-parent.test-support.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;
pgTest(
  "PostgreSQL oversized preparation converges through ordinary parent scheduling without a child execution queue or model sample",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      asset: oversizedChildVersion(),
      prepare: false,
    });
    const runtime = await postgresParentWorker(f, t),
      outcomes = [];
    for (let n = 0; n < 8; n++) {
      const outcome = await runtime.worker.wake();
      outcomes.push(outcome);
      if (outcome.kind === "idle") break;
    }
    const root = (await f.store.loadRun(f.root))!;
    assert.equal(root.status, "failed");
    assert.equal(runtime.requests.length, 0);
    assert.equal(
      outcomes.filter(
        (outcome) =>
          outcome.kind === "retried" &&
          outcome.code === "workflow_child_prompt_limit",
      ).length,
      0,
    );
    const rows = await f.children();
    assert.equal(rows.length, 1);
    const child = (await f.store.loadRun({
      tenantId: root.tenantId,
      runId: rows[0]!.child_run_id,
    }))!;
    assert.deepEqual(child.failure, {
      code: "workflow_child_prompt_limit",
      retryable: false,
    });
    assert.equal(
      (
        await f.admin.query(
          `SELECT count(*)::int AS n FROM ${f.sql}.run_attempts WHERE run_id=$1`,
          [child.runId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await f.admin.query(
          `SELECT count(*)::int AS n FROM ${f.sql}.work_items WHERE run_id=$1`,
          [child.runId],
        )
      ).rows[0]!.n,
      0,
    );
    assert.deepEqual(
      await f.store.listModelHistoryItems(
        { tenantId: root.tenantId, threadId: child.threadId },
        0,
        100,
      ),
      [],
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);

test("SQLite oversized child preparation reaches a durable failed root without model sampling or repeated budget retries", async (t) => {
  const f = await schedulerFixture(t, oversizedChildVersion());
  const runtime = schedulerWorker(f, t),
    outcomes = [];
  for (let pass = 0; pass < 8; pass++) {
    const outcome = await runtime.worker.wake();
    outcomes.push(outcome);
    if (outcome.kind === "idle") break;
    f.clock.advance(300001);
  }
  const root = (await f.store.loadRun(f.root))!;
  t.diagnostic(
    JSON.stringify({
      case: "oversized-child-preparation",
      rootStatus: root.status,
      sampledModels: runtime.requests.length,
      outcomes,
    }),
  );
  assert.equal(root.status, "failed");
  assert.equal(root.failure?.retryable, false);
  assert.equal(runtime.requests.length, 0);
  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.kind === "retried" &&
        outcome.code === "workflow_child_prompt_limit",
    ).length,
    0,
  );
  assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  const rows = f.database
    .prepare("SELECT child_thread_id,child_run_id FROM workflow_node_children")
    .all();
  assert.equal(rows.length, 1);
  const child = (await f.store.loadRun({
    tenantId: root.tenantId,
    runId: String(rows[0]!.child_run_id),
  }))!;
  assert.equal(child.status, "failed");
  assert.deepEqual(child.failure, {
    code: "workflow_child_prompt_limit",
    retryable: false,
  });
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM run_attempts WHERE run_id=?")
      .get(child.runId)!.n,
    0,
  );
  assert.equal(child.lastSequence, 2);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM work_items WHERE run_id=?")
      .get(child.runId)!.n,
    0,
  );
  assert.deepEqual(
    await f.store.listModelHistoryItems(
      { tenantId: root.tenantId, threadId: child.threadId },
      0,
      100,
    ),
    [],
  );
  assert.deepEqual(
    await f.store.listMessages(
      { tenantId: root.tenantId, threadId: root.threadId },
      0,
      100,
    ),
    [],
  );
  assert.equal(
    await f.store.loadActiveRunInThread({
      tenantId: root.tenantId,
      spaceId: root.spaceId,
      threadId: root.threadId,
    }),
    null,
  );
});
