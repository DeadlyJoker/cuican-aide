import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  reduceRunLifecycleEvent,
  type RunLifecycleEvent,
} from "@crewon/domain";
import {
  compositionFixture,
  parallelVersion,
  compositionInput,
  claimCompositionWork,
  compositionNow,
} from "./workflow-run-composition.test-support.ts";
import { sqliteAdmissionFixture } from "./workflow-run-admission.test-support.ts";
import { migrateSqliteWorkflowCancellation } from "./sqlite-workflow-cancellation-schema.ts";
import {
  cancellationChildDispatch,
  cancellationSnapshot,
  requestWorkflowCancel,
} from "./workflow-cancellation.test-support.ts";

test("SQLite scheduler recovers an older writer's durable cancel wake without duplicate child signals", async (t) => {
  const f = await compositionFixture(t, {
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  const run = (await f.store.loadRun(f.input))!;
  const event: RunLifecycleEvent = {
    schemaVersion: "crewon.run-event.v0",
    identity: { runId: run.runId },
    eventId: "older-writer-cancel",
    sequence: run.lastSequence + 1,
    occurredAt: new Date(compositionNow).toISOString(),
    type: "run.cancel.requested",
    data: { actorId: "older-writer-actor" },
  };
  const next = reduceRunLifecycleEvent(run, event);
  f.database.exec("BEGIN IMMEDIATE");
  f.database
    .prepare(
      "UPDATE run_snapshots SET revision=?,last_sequence=?,state_json=?,updated_at=? WHERE tenant_id=? AND run_id=?",
    )
    .run(
      next.revision,
      next.lastSequence,
      JSON.stringify(next),
      next.updatedAt,
      run.tenantId,
      run.runId,
    );
  f.database
    .prepare(
      "INSERT INTO run_events(tenant_id,run_id,sequence,event_id,event_json) VALUES(?,?,?,?,?)",
    )
    .run(
      run.tenantId,
      run.runId,
      event.sequence,
      event.eventId,
      JSON.stringify(event),
    );
  f.database.exec("COMMIT");
  assert.equal(
    f.database
      .prepare("SELECT children_signaled FROM workflow_cancellation_wakes")
      .get()!.children_signaled,
    0,
  );
  assert.equal(
    (await f.composition.propagateWorkflowCancellation(f.input))
      .cancelRequested,
    true,
  );
  assert.equal(
    f.database
      .prepare("SELECT children_signaled FROM workflow_cancellation_wakes")
      .get()!.children_signaled,
    1,
  );
  const before = cancellationSnapshot(f);
  await f.composition.propagateWorkflowCancellation(f.input);
  assert.deepEqual(cancellationSnapshot(f), before);
});

test("SQLite ordinary cancel writer refuses a missing experimental wake trigger instead of committing an unwakeable request", async (t) => {
  const f = await compositionFixture(t);
  f.database.exec("DROP TRIGGER workflow_root_cancellation_wake");
  const before = cancellationSnapshot(f);
  await assert.rejects(
    requestWorkflowCancel(f.store, f.input, compositionNow),
    { code: "workflow_cancellation_schema_corrupt" },
  );
  assert.deepEqual(cancellationSnapshot(f), before);
});

test("SQLite canonical root cancellation atomically wakes a parked scheduler once, including an already-open writer", async (t) => {
  const f = await compositionFixture(t);
  await f.store.completeWorkItem(f.input.lease);
  const result = await requestWorkflowCancel(f.store, f.input, compositionNow);
  assert.equal(result.state.cancelRequested, true);
  const work = await claimCompositionWork(f.store, "cancel-wake");
  assert.equal(work.workItem.runId, f.input.runId);
  const input = compositionInput(f.input.binding, work);
  assert.equal(
    (await f.composition.propagateWorkflowCancellation(input)).status,
    "canceled",
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(input)).run.status,
    "canceled",
  );
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_cancellation_wakes")
      .get()!.n,
    1,
  );
});

test("SQLite queued workflow cancels before any node, model Attempt or child Thread starts", async (t) => {
  const f = await sqliteAdmissionFixture(t),
    run = (await f.start()).run.state;
  const input = compositionInput(
    run.workflowVersionBinding!,
    await claimCompositionWork(f.store, "queued-root"),
  );
  const composition = f.store.experimentalWorkflowRunCompositionStore({
    dispatchChildren: cancellationChildDispatch,
  });
  await requestWorkflowCancel(f.store, input, compositionNow);
  const state = await composition.propagateWorkflowCancellation(input);
  assert.equal(state.status, "canceled");
  assert.ok(
    state.nodes.every(
      (node) => node.status === "canceled" && node.claimId === null,
    ),
  );
  const terminal = await composition.finalizeWorkflowRun(input);
  assert.equal(terminal.run.status, "canceled");
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
    0,
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM threads").get()!.n,
    1,
  );
  const wake = compositionInput(
    input.binding,
    await claimCompositionWork(f.store, "extra-cancel-wake"),
  );
  assert.equal(
    (await composition.finalizeWorkflowRun(wake)).disposition,
    "replayed",
  );
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
});

test("SQLite cancellation accelerates the existing delayed child queue while preserving a live sibling lease and model history", async (t) => {
  const f = await compositionFixture(t, {
    asset: parallelVersion(2),
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  const delayed = await claimCompositionWork(f.store, "delayed");
  const delayedInput = compositionInput(f.input.binding, delayed);
  await f.store.retryWorkItem({
    ...delayedInput.lease,
    retryAfterMs: 3_600_000,
    reasonCode: "backoff",
  });
  const leased = await claimCompositionWork(f.store, "leased");
  const originalLease = f.database
    .prepare(
      "SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at_ms FROM work_items WHERE work_item_id=?",
    )
    .get(leased.workItem.workItemId);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const before = cancellationSnapshot(f);
  const state = await f.composition.propagateWorkflowCancellation(f.input);
  assert.equal(state.cancelRequested, true);
  assert.equal(
    state.nodes.filter((node) => node.status === "running").length,
    2,
  );
  assert.equal(state.nodes.at(-1)!.status, "canceled");
  assert.deepEqual(
    f.database
      .prepare(
        "SELECT lease_id,lease_owner_id,lease_epoch,lease_expires_at_ms FROM work_items WHERE work_item_id=?",
      )
      .get(leased.workItem.workItemId),
    originalLease,
  );
  assert.equal(
    f.database
      .prepare("SELECT available_at_ms FROM work_items WHERE work_item_id=?")
      .get(delayed.workItem.workItemId)!.available_at_ms,
    compositionNow,
  );
  assert.deepEqual(
    cancellationSnapshot(f).model_history_items,
    before.model_history_items,
  );
  for (const child of [delayed, leased]) {
    const events = await f.store.listRunEvents(
      { tenantId: f.input.tenantId, runId: child.workItem.runId },
      0,
      10,
    );
    assert.deepEqual(events.at(-1)!.data, { actorId: "canceling-actor" });
  }
  const after = cancellationSnapshot(f);
  await f.composition.propagateWorkflowCancellation(f.input);
  assert.deepEqual(cancellationSnapshot(f), after);
  await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
    code: "workflow_cancellation_recovery_required",
  });
  // The in-flight retry must consume the cancellation wake rather than restoring an hour of backoff.
  await f.store.retryWorkItem({
    ...compositionInput(f.input.binding, leased).lease,
    retryAfterMs: 3_600_000,
    reasonCode: "late-backoff",
  });
  assert.equal(
    f.database
      .prepare("SELECT available_at_ms FROM work_items WHERE work_item_id=?")
      .get(leased.workItem.workItemId)!.available_at_ms,
    compositionNow,
  );
});

test("SQLite cancellation can retire a waiting human gate without creating an execution Attempt", async (t) => {
  const f = await compositionFixture(t, {
    asset: parallelVersion(1, "humanGate"),
  });
  await f.composition.admitWorkflowNodes(f.input);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const canceled = await f.composition.propagateWorkflowCancellation(f.input);
  assert.equal(canceled.status, "canceled");
  assert.equal(
    (await f.composition.finalizeWorkflowRun(f.input)).run.status,
    "canceled",
  );
  assert.equal(
    f.database.prepare("SELECT status FROM run_steps").get()!.status,
    "canceled",
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
    0,
  );
});

test("SQLite unowned legacy running node cancellation stays unresolved instead of declaring an external effect stopped", async (t) => {
  const f = await compositionFixture(t);
  await f.composition.admitWorkflowNodes(f.input);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const before = cancellationSnapshot(f);
  await assert.rejects(f.composition.propagateWorkflowCancellation(f.input), {
    code: "workflow_node_recovery_required",
  });
  assert.deepEqual(cancellationSnapshot(f), before);
});

test("SQLite cancel-wake insertion failure rolls back the request event, flag and wake identity", async (t) => {
  const f = await compositionFixture(t),
    before = cancellationSnapshot(f);
  f.database.exec(
    "CREATE TRIGGER fail_cancel_wake BEFORE INSERT ON work_items BEGIN SELECT RAISE(ABORT,'cancel wake failed'); END",
  );
  await assert.rejects(requestWorkflowCancel(f.store, f.input, compositionNow));
  assert.deepEqual(cancellationSnapshot(f), before);
  f.database.exec("DROP TRIGGER fail_cancel_wake");
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const count = f.database
    .prepare("SELECT count(*) AS n FROM work_items")
    .get()!.n;
  await assert.rejects(
    requestWorkflowCancel(f.store, f.input, compositionNow),
    { code: "cancel_already_requested" },
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM work_items").get()!.n,
    count,
  );
});

for (const fault of ["outbox", "processExit"] as const)
  test(
    `SQLite ${fault} during root request leaves no partially canceled siblings or root signal`,
    { timeout: 15_000 },
    async (t) => {
      const f = await compositionFixture(t, {
        asset: parallelVersion(2),
        composition: { dispatchChildren: cancellationChildDispatch },
      });
      await f.composition.admitWorkflowNodes(f.input);
      const before = cancellationSnapshot(f);
      if (fault === "outbox") {
        f.database.exec(
          "CREATE TRIGGER fail_cancel_outbox BEFORE INSERT ON outbox WHEN NEW.run_id=(SELECT child_run_id FROM workflow_node_children ORDER BY node_id LIMIT 1 OFFSET 1) BEGIN SELECT RAISE(ABORT,'cancel failed'); END",
        );
        await assert.rejects(
          requestWorkflowCancel(f.store, f.input, compositionNow),
        );
        f.database.exec("DROP TRIGGER fail_cancel_outbox");
      } else {
        const script = `
    import { DatabaseSync } from 'node:sqlite';
    import {SqliteRunStore} from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    import {requestWorkflowCancel} from ${JSON.stringify(new URL("./workflow-cancellation.test-support.ts", import.meta.url).href)};
    const original = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = original.call(this, sql);
      return new Proxy(statement, {get(target, key) {
        if (key === 'run') return (...args) => {
          const result = target.run(...args);
          if (sql.includes('INSERT INTO idempotency_receipts') && String(args[1]).includes('workflow.child-cancel.v1')) process.exit(77);
          return result;
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    const store=new SqliteRunStore(process.env.CREWON_CANCEL_DB,{clock:{nowEpochMilliseconds:()=>${compositionNow}}});
    await requestWorkflowCancel(store,JSON.parse(process.env.CREWON_CANCEL_INPUT),${compositionNow});
    await store.close();`;
        const child = spawnSync(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "-e", script],
          {
            env: {
              ...process.env,
              CREWON_CANCEL_DB: f.path,
              CREWON_CANCEL_INPUT: JSON.stringify(f.input),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        assert.equal(child.status, 77, child.stderr);
      }
      assert.deepEqual(cancellationSnapshot(f), before);
      await requestWorkflowCancel(f.store, f.input, compositionNow);
      assert.equal(
        (
          await f
            .open()
            .experimentalWorkflowRunCompositionStore({
              dispatchChildren: cancellationChildDispatch,
            })
            .propagateWorkflowCancellation(f.input)
        ).cancelRequested,
        true,
      );
    },
  );

test("SQLite scheduler lease expiry rolls back DAG cancellation while preserving already-authorized child signals", async (t) => {
  const f = await compositionFixture(t, {
    asset: parallelVersion(2),
    composition: { dispatchChildren: cancellationChildDispatch },
  });
  await f.composition.admitWorkflowNodes(f.input);
  await requestWorkflowCancel(f.store, f.input, compositionNow);
  const before = cancellationSnapshot(f),
    now = f.clock.nowEpochMilliseconds.bind(f.clock);
  let reads = 0;
  f.clock.nowEpochMilliseconds = () => {
    if (++reads === 3) f.clock.advance(60_000);
    return now();
  };
  await assert.rejects(f.composition.propagateWorkflowCancellation(f.input));
  assert.deepEqual(cancellationSnapshot(f), before);
  const input = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "recover-cancel"),
  );
  assert.equal(
    (await f.composition.propagateWorkflowCancellation(input)).cancelRequested,
    true,
  );
});

for (const mutation of [
  "DROP TRIGGER workflow_root_cancellation_wake",
  "UPDATE workflow_cancellation_schema SET version=2",
  "DELETE FROM workflow_cancellation_wakes",
  "UPDATE workflow_cancellation_wakes SET request_sequence=1",
  "UPDATE idempotency_receipts SET result_json=json_set(result_json,'$.workItems[0].workItemId','foreign-work') WHERE scope LIKE 'workflow-child:%'",
])
  test(`SQLite cancellation rejects incomplete or corrupt authority: ${mutation}`, async (t) => {
    const f = await compositionFixture(t, {
      composition: { dispatchChildren: cancellationChildDispatch },
    });
    await f.composition.admitWorkflowNodes(f.input);
    await requestWorkflowCancel(f.store, f.input, compositionNow);
    f.database.exec(mutation);
    const before = cancellationSnapshot(f);
    await assert.rejects(f.composition.propagateWorkflowCancellation(f.input));
    assert.deepEqual(cancellationSnapshot(f), before);
    if (mutation.includes("version=2"))
      assert.throws(() => migrateSqliteWorkflowCancellation(f.database), {
        code: "workflow_cancellation_schema_unsupported",
      });
  });
