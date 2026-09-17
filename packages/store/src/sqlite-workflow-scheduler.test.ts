import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { schedulerFixture } from "./workflow-scheduler.test-support.ts";
import {
  claimCompositionWork,
  compositionInput,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import { requestWorkflowCancel } from "./workflow-cancellation.test-support.ts";

test("scheduler start is leased, current-policy checked, idempotent and adds no model history or Attempt", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "start"),
  );
  const history = f.database
    .prepare("SELECT * FROM model_history_items ORDER BY rowid")
    .all();
  f.authorize(() => ({ outcome: "deny", reasonCode: "revoked" }));
  const counts = f.counts();
  await assert.rejects(f.composition.prepareWorkflowRun(input), {
    code: "workflow_scheduler_policy_denied",
  });
  assert.deepEqual(f.counts(), counts);
  f.authorize(() => ({ outcome: "allow" }));
  const started = await f.composition.prepareWorkflowRun(input);
  assert.equal(started.status, "running");
  assert.deepEqual(await f.composition.prepareWorkflowRun(input), started);
  assert.equal(
    f.database
      .prepare(
        "SELECT count(*) AS n FROM run_events WHERE json_extract(event_json,'$.type')='run.started'",
      )
      .get()!.n,
    1,
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
    0,
  );
  assert.deepEqual(
    f.database
      .prepare("SELECT * FROM model_history_items ORDER BY rowid")
      .all(),
    history,
  );
  f.authorize(() => ({ outcome: "deny", reasonCode: "revoked-after-start" }));
  await assert.rejects(f.composition.admitWorkflowNodes(input), {
    code: "workflow_scheduler_policy_denied",
  });
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    0,
  );
  f.clock.advance(60_001);
  await assert.rejects(f.composition.prepareWorkflowRun(input), {
    code: "lease_expired",
  });
});

test("scheduler refuses a changed frozen queue payload before starting the root", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "payload"),
  );
  f.database
    .prepare(
      "UPDATE work_items SET work_item_json=json_set(work_item_json,'$.payload.workflowInput.valueDigest','sha256:corrupt') WHERE work_item_id=?",
    )
    .run(input.lease.workItemId);
  await assert.rejects(f.composition.prepareWorkflowRun(input));
  assert.equal((await f.store.loadRun(f.root))!.status, "queued");
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
    0,
  );
});

test("root start rolls back its event and receipt when notification insertion fails", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "start-fault"),
  );
  const counts = f.counts();
  f.database.exec(
    "CREATE TRIGGER scheduler_start_fault BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'start-fault'); END",
  );
  await assert.rejects(f.composition.prepareWorkflowRun(input), {
    code: "sqlite_error",
  });
  assert.deepEqual(f.counts(), counts);
  assert.equal((await f.store.loadRun(f.root))!.status, "queued");
  f.database.exec("DROP TRIGGER scheduler_start_fault");
  assert.equal(
    (await f.composition.prepareWorkflowRun(input)).status,
    "running",
  );
});

test("parking relinquishes only the parent lease and requires a recoverable child queue and intact terminal trigger", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "park"),
  );
  await f.composition.prepareWorkflowRun(input);
  await f.composition.admitWorkflowNodes(input);
  const child = f.database
    .prepare("SELECT child_run_id FROM workflow_node_children")
    .get()!;
  f.database
    .prepare(
      "UPDATE work_items SET status='completed',completed_at_ms=1 WHERE run_id=?",
    )
    .run(child.child_run_id!);
  await assert.rejects(f.composition.finishWorkflowSchedulerPass(input), {
    code: "workflow_child_work_authority_missing",
  });
  assert.equal(
    f.database
      .prepare("SELECT status FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId)!.status,
    "leased",
  );
  f.database
    .prepare(
      "UPDATE work_items SET status='pending',completed_at_ms=NULL WHERE run_id=?",
    )
    .run(child.child_run_id!);
  const parked = await f.composition.finishWorkflowSchedulerPass(input);
  assert.deepEqual(parked, {
    kind: "waiting",
    runId: f.root.runId,
    children: 1,
    humanGates: 0,
  });
  assert.equal((await f.store.listPendingWorkItems(10)).length, 1);
  assert.equal((await f.store.loadRun(f.root))!.status, "running");
});

test("a missing child terminal trigger prevents acknowledgement instead of losing the future wake", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "trigger"),
  );
  await f.composition.prepareWorkflowRun(input);
  await f.composition.admitWorkflowNodes(input);
  f.database.exec("DROP TRIGGER workflow_child_terminal_wake");
  await assert.rejects(f.composition.finishWorkflowSchedulerPass(input), {
    code: "workflow_child_schema_corrupt",
  });
  assert.equal(
    f.database
      .prepare("SELECT status FROM work_items WHERE work_item_id=?")
      .get(input.lease.workItemId)!.status,
    "leased",
  );
});

for (const fault of ["enqueue", "acknowledge"] as const) {
  test(`ready successor and acknowledgement both roll back on ${fault} failure`, async (t) => {
    const f = await schedulerFixture(t, parallelVersion(5, "humanGate"));
    const input = compositionInput(
      f.binding,
      await claimCompositionWork(f.store, fault),
    );
    await f.composition.prepareWorkflowRun(input);
    const admitted = await f.composition.admitWorkflowNodes(input);
    assert.equal(
      admitted.execution.nodes.filter((n) => n.status === "waitingHuman")
        .length,
      4,
    );
    assert.equal(
      (await f.composition.admitWorkflowNodes(input)).execution.nodes.filter(
        (n) => n.status === "waitingHuman",
      ).length,
      4,
    );
    const queue = f.database
      .prepare("SELECT * FROM work_items ORDER BY rowid")
      .all();
    f.database.exec(
      fault === "enqueue"
        ? "CREATE TRIGGER pass_fault BEFORE INSERT ON work_items BEGIN SELECT RAISE(ABORT,'pass-fault'); END"
        : "CREATE TRIGGER pass_fault BEFORE UPDATE OF status ON work_items WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'pass-fault'); END",
    );
    await assert.rejects(
      f.composition.finishWorkflowSchedulerPass(input),
      /pass-fault/,
    );
    assert.deepEqual(
      f.database.prepare("SELECT * FROM work_items ORDER BY rowid").all(),
      queue,
    );
    f.database.exec("DROP TRIGGER pass_fault");
    assert.equal(
      (await f.composition.finishWorkflowSchedulerPass(input)).kind,
      "ready",
    );
    const next = compositionInput(
      f.binding,
      await claimCompositionWork(f.store, "successor"),
    );
    await f.composition.prepareWorkflowRun(next);
    const state = (await f.composition.admitWorkflowNodes(next)).execution;
    assert.equal(
      state.nodes.filter((n) => n.status === "waitingHuman").length,
      5,
    );
    assert.deepEqual(await f.composition.finishWorkflowSchedulerPass(next), {
      kind: "waiting",
      runId: f.root.runId,
      children: 0,
      humanGates: 5,
    });
    assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  });
}

test("a cancellation between admission and parking schedules propagation without pretending the child stopped", async (t) => {
  const f = await schedulerFixture(t);
  const input = compositionInput(
    f.binding,
    await claimCompositionWork(f.store, "cancel-race"),
  );
  await f.composition.prepareWorkflowRun(input);
  await f.composition.admitWorkflowNodes(input);
  await requestWorkflowCancel(f.store, f.root, f.clock.nowEpochMilliseconds());
  f.authorize(() => ({ outcome: "deny", reasonCode: "revoked" }));
  assert.equal(
    (await f.composition.finishWorkflowSchedulerPass(input)).kind,
    "ready",
  );
  const root = await f.store.loadRun(f.root);
  assert.equal(root!.status, "running");
  assert.equal(root!.cancelRequested, true);
});

for (const mode of ["waiting", "ready"] as const) {
  test(
    `process death after ${mode} acknowledgement rolls back the transaction and preserves recovery`,
    { timeout: 15_000 },
    async (t) => {
      const f = await schedulerFixture(
        t,
        mode === "ready" ? parallelVersion(5, "humanGate") : undefined,
      );
      const input = compositionInput(
        f.binding,
        await claimCompositionWork(f.store, mode),
      );
      await f.composition.prepareWorkflowRun(input);
      await f.composition.admitWorkflowNodes(input);
      const before = f.database
        .prepare("SELECT * FROM work_items ORDER BY rowid")
        .all();
      const script = `import { DatabaseSync } from 'node:sqlite';
      import { SqliteRunStore } from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
      import { gateCompositionOptions } from ${JSON.stringify(new URL("./workflow-human-gate.test-support.ts", import.meta.url).href)};
      const store = new SqliteRunStore(process.env.CREWON_SCHEDULER_DB, {clock:{nowEpochMilliseconds:()=>${f.clock.nowEpochMilliseconds()}}});
      const scheduler = store.experimentalWorkflowRunCompositionStore({...gateCompositionOptions,scheduler:{authorize:()=>({outcome:'allow'})}});
      const prepare=DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare=function(sql){const statement=prepare.call(this,sql);const run=statement.run.bind(statement);
        statement.run=(...args)=>{const value=run(...args);if(sql.includes("status = 'completed'") && sql.startsWith('UPDATE work_items'))process.exit(77);return value;};return statement;};
      await scheduler.finishWorkflowSchedulerPass(JSON.parse(process.env.CREWON_SCHEDULER_INPUT));`;
      const child = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            CREWON_SCHEDULER_DB: f.path,
            CREWON_SCHEDULER_INPUT: JSON.stringify(input),
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(child.status, 77, child.stderr);
      assert.deepEqual(
        f.database.prepare("SELECT * FROM work_items ORDER BY rowid").all(),
        before,
      );
      const reopened = f
        .open()
        .experimentalWorkflowRunCompositionStore(f.options);
      assert.equal(
        (await reopened.finishWorkflowSchedulerPass(input)).kind,
        mode,
      );
      assert.equal(
        f.database
          .prepare("SELECT status FROM work_items WHERE work_item_id=?")
          .get(input.lease.workItemId)!.status,
        "completed",
      );
    },
  );
}
