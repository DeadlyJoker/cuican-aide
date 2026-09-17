import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
  parallelVersion,
  compositionNow,
} from "./workflow-run-composition.test-support.ts";
import {
  cancellationChildDispatch,
  cancellationSnapshot,
  requestWorkflowCancel,
} from "./workflow-cancellation.test-support.ts";

async function fixture(t: TestContext, count = 3) {
  const f = await compositionFixture(t, {
    asset: parallelVersion(count),
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  const children = [];
  for (let i = 0; i < count; i++)
    children.push(
      compositionInput(
        f.input.binding,
        await claimCompositionWork(f.store, `child-${i}`),
      ),
    );
  return { ...f, children };
}
async function terminal(
  f: Awaited<ReturnType<typeof fixture>>,
  index: number,
  status: "failed" | "canceled",
) {
  const input = f.children[index]!,
    run = (await f.store.loadRun(input))!;
  await f.store.commitRun({
    tenantId: input.tenantId,
    expectedRevision: run.revision,
    idempotency: {
      scope: "failure-fixture",
      key: `${run.runId}-${status}`,
      requestFingerprint: status,
    },
    events: [
      {
        schemaVersion: "crewon.run-event.v0",
        identity: { runId: run.runId },
        eventId: `${run.runId}-${status}`,
        sequence: run.lastSequence + 1,
        occurredAt: new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        ...(status === "failed"
          ? {
              type: "run.failed" as const,
              data: { code: "branch-failed", retryable: false },
            }
          : {
              type: "run.canceled" as const,
              data: { reasonCode: "canceled" },
            }),
      },
    ],
    outbox: [],
    workItems: [],
  });
  await f.store.completeWorkItem(input.lease);
}
async function failed(t: TestContext) {
  const f = await fixture(t);
  await terminal(f, 0, "failed");
  return f;
}

test("SQLite two already failed branches retain both failures while the remaining sibling is canceled", async (t) => {
  const f = await fixture(t);
  await terminal(f, 2, "failed");
  await terminal(f, 1, "failed");
  await f.composition.admitWorkflowNodes(f.input);
  await terminal(f, 0, "canceled");
  const result = await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(
    result.execution.nodes.map((n) => n.status),
    ["canceled", "failed", "failed", "canceled"],
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(f.input)).run.status,
    "failed",
  );
});

test("SQLite failed branch signals siblings atomically, preserves root failure and waits for terminal children", async (t) => {
  const f = await failed(t),
    before = cancellationSnapshot(f);
  const lease = f.database
    .prepare(
      "SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at_ms FROM work_items WHERE work_item_id=?",
    )
    .get(f.children[1]!.lease.workItemId);
  const result = await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(result.admissions, []);
  assert.deepEqual(
    result.execution.nodes.map((n) => n.status),
    ["failed", "running", "running", "canceled"],
  );
  assert.equal(result.execution.cancelRequested, false);
  assert.equal((await f.store.loadRun(f.input))!.cancelRequested, false);
  assert.equal((await f.store.loadRun(f.input))!.status, "running");
  assert.deepEqual(
    f.database
      .prepare(
        "SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at_ms FROM work_items WHERE work_item_id=?",
      )
      .get(f.children[1]!.lease.workItemId),
    lease,
  );
  for (const input of f.children.slice(1))
    assert.equal((await f.store.loadRun(input))!.cancelRequested, true);
  assert.deepEqual(
    cancellationSnapshot(f).model_history_items,
    before.model_history_items,
  );
  assert.equal(cancellationSnapshot(f).workflow_cancellation_wakes!.length, 0);
  const committed = cancellationSnapshot(f);
  await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(cancellationSnapshot(f), committed);
  await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
    code: "workflow_finalization_pending",
  });
  await terminal(f, 1, "canceled");
  await terminal(f, 2, "canceled");
  const reopened = f.open().experimentalWorkflowRunCompositionStore({
    dispatchChildren: cancellationChildDispatch,
  });
  const finished = await reopened.admitWorkflowNodes(f.input);
  assert.deepEqual(
    finished.execution.nodes.map((n) => n.status),
    ["failed", "canceled", "canceled", "canceled"],
  );
  assert.equal(
    finished.execution.nodes[0]!.failureCode,
    "workflow_child_failed",
  );
  assert.equal(
    (await reopened.finalizeWorkflowRun(f.input)).run.status,
    "failed",
  );
  for (let i = 0; i < 3; i++) {
    const wake = compositionInput(
      f.input.binding,
      await claimCompositionWork(f.store, `terminal-${i}`),
    );
    assert.equal(
      (await reopened.finalizeWorkflowRun(wake)).disposition,
      "replayed",
    );
  }
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.deepEqual(cancellationSnapshot(f).messages, before.messages);
});

test("SQLite failed workflow accelerates delayed children once and does not reset later reconciliation backoff", async (t) => {
  const f = await failed(t),
    delayed = f.children[1]!;
  await f.store.retryWorkItem({
    ...delayed.lease,
    retryAfterMs: 3_600_000,
    reasonCode: "old-backoff",
  });
  await f.composition.admitWorkflowNodes(f.input);
  assert.equal(
    f.database
      .prepare("SELECT available_at_ms FROM work_items WHERE work_item_id=?")
      .get(delayed.lease.workItemId)!.available_at_ms,
    compositionNow,
  );
  // The earlier ready root wake is owned by a separate coordinator while the
  // ordinary child Worker receives the newly accelerated cancellation.
  const coordinator = await claimCompositionWork(
    f.store,
    "failure-coordinator",
  );
  assert.equal(coordinator.workItem.runId, f.input.runId);
  const claim = await claimCompositionWork(f.store, "cancel-child"),
    input = compositionInput(f.input.binding, claim);
  assert.equal(input.runId, delayed.runId);
  await f.store.retryWorkItem({
    ...input.lease,
    retryAfterMs: 60_000,
    reasonCode: "tool_outcome_unknown",
  });
  const after = cancellationSnapshot(f);
  await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(cancellationSnapshot(f), after);
  assert.equal(
    f.database
      .prepare("SELECT available_at_ms FROM work_items WHERE work_item_id=?")
      .get(delayed.lease.workItemId)!.available_at_ms,
    compositionNow + 60_000,
  );
});

test("SQLite failure does not overwrite an existing independent cancellation or its backoff", async (t) => {
  const f = await failed(t);
  await requestWorkflowCancel(f.store, f.children[1]!, compositionNow);
  await f.store.retryWorkItem({
    ...f.children[1]!.lease,
    retryAfterMs: 60_000,
    reasonCode: "tool_outcome_unknown",
  });
  const before = await f.store.listRunEvents(f.children[1]!, 0, 10);
  await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(await f.store.listRunEvents(f.children[1]!, 0, 10), before);
  assert.equal(
    f.database
      .prepare("SELECT available_at_ms FROM work_items WHERE work_item_id=?")
      .get(f.children[1]!.lease.workItemId)!.available_at_ms,
    compositionNow + 60_000,
  );
});

test("SQLite a later user cancellation preserves the original failed node and does not duplicate child signals", async (t) => {
  const f = await failed(t);
  await f.composition.admitWorkflowNodes(f.input);
  const before = await f.store.listRunEvents(f.children[1]!, 0, 10);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  await f.composition.propagateWorkflowCancellation(f.input);
  assert.deepEqual(await f.store.listRunEvents(f.children[1]!, 0, 10), before);
  await terminal(f, 1, "canceled");
  await terminal(f, 2, "canceled");
  const state = await f.composition.propagateWorkflowCancellation(f.input);
  assert.equal(state.nodes[0]!.status, "failed");
  assert.equal(
    (await f.composition.finalizeWorkflowRun(f.input)).run.status,
    "canceled",
  );
});

for (const target of ["idempotency_receipts", "outbox"])
  test(`SQLite a failure while writing the second sibling ${target} rolls back settlements and all signals`, async (t) => {
    const f = await failed(t),
      before = cancellationSnapshot(f);
    f.database.exec(
      `CREATE TRIGGER fail_sibling BEFORE INSERT ON ${target} WHEN NEW.run_id='${f.children[2]!.runId}' BEGIN SELECT RAISE(ABORT,'sibling failed'); END`,
    );
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(cancellationSnapshot(f), before);
    f.database.exec("DROP TRIGGER fail_sibling");
    assert.equal(
      (await f.composition.admitWorkflowNodes(f.input)).execution.status,
      "failed",
    );
  });

test("SQLite loss of the scheduler lease rolls back sibling cancellation and node settlement", async (t) => {
  const f = await failed(t),
    before = cancellationSnapshot(f);
  let ids = 0;
  const scheduler = f.store.experimentalWorkflowRunCompositionStore({
    dispatchChildren: cancellationChildDispatch,
    nextId: () => {
      if (++ids === 2) f.clock.advance(60_000);
      return `expiry-${ids}`;
    },
  });
  await assert.rejects(scheduler.admitWorkflowNodes(f.input));
  assert.deepEqual(cancellationSnapshot(f), before);
  const recovered = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "after-expiry"),
  );
  assert.equal(recovered.runId, f.input.runId);
  assert.equal(
    (await f.composition.admitWorkflowNodes(recovered)).execution.status,
    "failed",
  );
});

for (const sql of [
  "UPDATE idempotency_receipts SET fingerprint='wrong' WHERE scope LIKE '%workflow.failure-child-cancel.v1%'",
  "UPDATE idempotency_receipts SET result_json=json_set(result_json,'$.events[0].sequence',999) WHERE scope LIKE '%workflow.failure-child-cancel.v1%'",
  "UPDATE idempotency_receipts SET result_json=json_set(result_json,'$.state.threadId','another') WHERE scope LIKE '%workflow.failure-child-cancel.v1%'",
])
  test(`SQLite changed failure cancellation authority cannot be adopted: ${sql}`, async (t) => {
    const f = await failed(t);
    await f.composition.admitWorkflowNodes(f.input);
    f.database.exec(sql);
    const before = cancellationSnapshot(f);
    await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
      code: "workflow_failure_cancel_authority_conflict",
    });
    assert.deepEqual(cancellationSnapshot(f), before);
  });

test(
  "SQLite process death after the first sibling cancellation receipt leaves no half stop and can be resumed",
  { timeout: 15_000 },
  async (t) => {
    const f = await failed(t),
      before = cancellationSnapshot(f);
    const script = `
    import { DatabaseSync } from 'node:sqlite';
    import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import { cancellationChildDispatch } from ${JSON.stringify(new URL("./workflow-cancellation.test-support.ts", import.meta.url).href)};
    const prepare=DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare=function(sql) {
      const statement=prepare.call(this,sql);
      if(sql.includes('INSERT INTO idempotency_receipts')) {
        const run=statement.run.bind(statement);
        statement.run=(...args)=>{const result=run(...args);if(String(args[1]).includes('workflow.failure-child-cancel.v1')) process.exit(77);return result;};
      }
      return statement;
    };
    const store=new SqliteRunStore(process.env.CREWON_FAILURE_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
    await store.experimentalWorkflowRunCompositionStore({dispatchChildren:cancellationChildDispatch}).admitWorkflowNodes(JSON.parse(process.env.CREWON_FAILURE_INPUT));
  `;
    const processResult = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          CREWON_FAILURE_DB: f.path,
          CREWON_FAILURE_INPUT: JSON.stringify(f.input),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(processResult.status, 77, processResult.stderr);
    assert.deepEqual(cancellationSnapshot(f), before);
    assert.equal(
      (
        await f
          .open()
          .experimentalWorkflowRunCompositionStore({
            dispatchChildren: cancellationChildDispatch,
          })
          .admitWorkflowNodes(f.input)
      ).execution.status,
      "failed",
    );
  },
);
