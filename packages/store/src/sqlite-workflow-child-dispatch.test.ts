import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  claimCompositionWork,
  compositionFixture,
  compositionInput,
  parallelVersion,
} from "./workflow-run-composition.test-support.ts";
import type { SqliteWorkflowChildDispatchOptions } from "./sqlite-workflow-child-dispatch.ts";
import { migrateSqliteWorkflowChildren } from "./sqlite-workflow-child-schema.ts";
import { SqliteWorkflowExecutionStore } from "./workflow-execution-store.ts";

export const childDispatch: SqliteWorkflowChildDispatchOptions = {
  resolveRoute: ({ parent, node }) => ({
    authorityId: parent.authorityId,
    runtimeGeneration: parent.runtimeGeneration,
    policySnapshotId: parent.policySnapshotId,
    workspaceBindingId: parent.workspaceBindingId,
    agentVersionId:
      node.kind === "agent"
        ? node.agentVersionId
        : node.kind === "verification"
          ? node.verifierAgentVersionId
          : "invalid-gate",
  }),
};

test("SQLite standalone DAG writers cannot overwrite the lease-owned state of a real Workflow Run", async (t) => {
  const f = await compositionFixture(t, {
      composition: { dispatchChildren: childDispatch },
    }),
    first = await f.composition.admitWorkflowNodes(f.input);
  const legacy = new SqliteWorkflowExecutionStore(f.database),
    before = snapshot(f);
  await assert.rejects(legacy.createWorkflowExecution(first.execution), {
    code: "workflow_execution_composition_required",
  });
  await assert.rejects(
    legacy.compareAndSwapWorkflowExecution({
      tenantId: f.input.tenantId,
      runId: f.input.runId,
      expectedRevision: first.execution.revision,
      next: { ...first.execution, revision: first.execution.revision + 1 },
      receipt: { operationId: "legacy", fingerprint: "legacy" },
    }),
    { code: "workflow_execution_composition_required" },
  );
  assert.deepEqual(snapshot(f), before);
  assert.deepEqual(
    await legacy.loadWorkflowExecution(f.input),
    first.execution,
  );
});

test(
  "SQLite process death after creating one parallel child leaves no partial handoff or orphan child",
  { timeout: 15_000 },
  async (t) => {
    const f = await compositionFixture(t, {
        asset: parallelVersion(2),
        composition: { dispatchChildren: childDispatch },
      }),
      before = snapshot(f);
    const code = `
    import {SqliteRunStore} from ${JSON.stringify(new URL("./sqlite-run-store.ts", import.meta.url).href)};
    const store=new SqliteRunStore(process.env.CREWON_CHILD_DB,{clock:{nowEpochMilliseconds:()=>${Date.parse("2026-09-14T00:00:00.000Z")}}});
    let routes=0;
    const composition=store.experimentalWorkflowRunCompositionStore({dispatchChildren:{resolveRoute:({parent,node})=>{
      if(++routes===2) process.exit(77);
      return {authorityId:parent.authorityId,runtimeGeneration:parent.runtimeGeneration,policySnapshotId:parent.policySnapshotId,
        workspaceBindingId:parent.workspaceBindingId,agentVersionId:node.agentVersionId};
    }}});
    await composition.admitWorkflowNodes(JSON.parse(process.env.CREWON_CHILD_INPUT));
    await store.close();
  `;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          CREWON_CHILD_DB: f.path,
          CREWON_CHILD_INPUT: JSON.stringify(f.input),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(child.status, 77, child.stderr);
    assert.deepEqual(snapshot(f), before);
    await f
      .open()
      .experimentalWorkflowRunCompositionStore({
        dispatchChildren: childDispatch,
      })
      .admitWorkflowNodes(f.input);
    assert.equal(
      f.database
        .prepare("SELECT count(*) AS n FROM workflow_node_children")
        .get()!.n,
      2,
    );
  },
);

for (const mutation of [
  "DELETE FROM workflow_node_children",
  "UPDATE workflow_node_children SET input_digest='wrong'",
  "UPDATE workflow_node_children SET wake_json=json_set(wake_json,'$.payload.workflowInput.valueId','wrong-input')",
  "UPDATE run_snapshots SET state_json=json_set(state_json,'$.agentVersionId','wrong-agent') WHERE run_id IN (SELECT child_run_id FROM workflow_node_children)",
  "DROP TRIGGER workflow_child_terminal_wake",
])
  test(`SQLite corrupt child ownership cannot be adopted or create another task: ${mutation}`, async (t) => {
    const f = await compositionFixture(t, {
      composition: { dispatchChildren: childDispatch },
    });
    await f.composition.admitWorkflowNodes(f.input);
    f.database.exec(mutation);
    const before = snapshot(f);
    await assert.rejects(f.composition.admitWorkflowNodes(f.input));
    assert.deepEqual(snapshot(f), before);
  });

test("SQLite child routing refuses an earlier unfenced node admission and future schema versions", async (t) => {
  const f = await compositionFixture(t);
  await f.composition.admitWorkflowNodes(f.input);
  const children = f.store.experimentalWorkflowRunCompositionStore({
      dispatchChildren: childDispatch,
    }),
    before = snapshot(f);
  await assert.rejects(children.admitWorkflowNodes(f.input), {
    code: "workflow_child_handoff_missing",
  });
  assert.deepEqual(snapshot(f), before);
  f.database.exec("UPDATE workflow_child_schema SET version=2");
  assert.throws(() => migrateSqliteWorkflowChildren(f.database), {
    code: "workflow_child_schema_unsupported",
  });
});

test("SQLite atomically hands each parallel node to its own ordinary Run and bounded canonical Thread history", async (t) => {
  const f = await compositionFixture(t, {
    asset: parallelVersion(2),
    composition: { dispatchChildren: childDispatch },
  });
  const result = await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(result.admissions, []);
  const children = f.database
    .prepare("SELECT * FROM workflow_node_children ORDER BY node_id")
    .all();
  assert.equal(children.length, 2);
  assert.equal(new Set(children.map((row) => row.child_thread_id)).size, 2);
  for (const [index, row] of children.entries()) {
    const locator = {
      tenantId: f.input.tenantId,
      threadId: String(row.child_thread_id),
    };
    const run = await f.store.loadRun({
      tenantId: f.input.tenantId,
      runId: String(row.child_run_id),
    });
    assert.equal(run!.agentVersionId, `agent-${index}`);
    assert.equal(run!.purpose, "turn");
    assert.equal(run!.status, "queued");
    const history = await f.store.listModelHistoryItems(locator, 0, 100);
    assert.equal(history.length, 3);
    assert.ok(
      history.every(
        (item) =>
          item.type === "message" &&
          item.role === "user" &&
          Buffer.byteLength(item.content) <= 9999,
      ),
    );
    assert.equal(history.at(-1)!.type, "message");
    assert.equal(
      (await f.store.listMessages(locator, 0, 100)).at(-1)!.content,
      'Node input:\n{"topic":"safe"}',
    );
  }
  const before = snapshot(f);
  await f.composition.admitWorkflowNodes(f.input);
  assert.deepEqual(snapshot(f), before);
  await assert.rejects(
    f.composition.settleWorkflowNode({
      ...f.input,
      nodeId: "root-0",
      claimId: String(children[0]!.claim_id),
      outcome: { status: "completed", value: { topic: "manual" } },
    }),
    { code: "workflow_child_settlement_required" },
  );
});

test("SQLite reopening after scheduler lease loss preserves child ownership and cannot duplicate a model task", async (t) => {
  const f = await compositionFixture(t, {
    composition: { dispatchChildren: childDispatch },
  });
  const first = await f.composition.admitWorkflowNodes(f.input),
    before = snapshot(f);
  f.clock.advance(86_400_000);
  // The already-ready child now precedes the later-expired scheduler lease.
  // Hold it as an independent child Worker would, without executing it.
  const child = await claimCompositionWork(f.store, "waiting-child");
  assert.equal(
    child.workItem.runId,
    String(
      f.database
        .prepare("SELECT child_run_id FROM workflow_node_children")
        .get()!.child_run_id,
    ),
  );
  const recovered = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "recovered"),
  );
  assert.equal(recovered.runId, f.input.runId);
  const reopened = f.open().experimentalWorkflowRunCompositionStore({
    dispatchChildren: childDispatch,
  });
  const next = await reopened.admitWorkflowNodes(recovered);
  assert.deepEqual(next.execution, first.execution);
  assert.deepEqual(next.admissions, []);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    1,
  );
  assert.deepEqual(snapshot(f).run_attempts, before.run_attempts);
  await assert.rejects(
    f
      .open()
      .experimentalWorkflowRunCompositionStore()
      .admitWorkflowNodes(recovered),
    { code: "workflow_child_dispatch_unavailable" },
  );
});

for (const table of [
  "thread_idempotency_receipts",
  "idempotency_receipts",
  "workflow_node_children",
] as const) {
  test(`SQLite failure at child ${table} rolls back node, Thread, history, Run and queues`, async (t) => {
    const f = await compositionFixture(t, {
        composition: { dispatchChildren: childDispatch },
      }),
      before = snapshot(f);
    f.database.exec(
      `CREATE TRIGGER fail_child BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'child write failed'); END`,
    );
    await assert.rejects(
      f.composition.admitWorkflowNodes(f.input),
      (error: unknown) =>
        error instanceof Error &&
        (error.message === "child write failed" ||
          (error.cause instanceof Error &&
            error.cause.message === "child write failed")),
    );
    assert.deepEqual(snapshot(f), before);
    f.database.exec("DROP TRIGGER fail_child");
    await f.composition.admitWorkflowNodes(f.input);
    assert.equal(
      f.database
        .prepare("SELECT count(*) AS n FROM workflow_node_children")
        .get()!.n,
      1,
    );
  });
}

test("SQLite denied or mismatched frozen node route cannot leave the first parallel child committed", async (t) => {
  let calls = 0;
  const f = await compositionFixture(t, {
      asset: parallelVersion(2),
      composition: {
        dispatchChildren: {
          resolveRoute(input) {
            const route = childDispatch.resolveRoute(input);
            return ++calls === 2
              ? { ...route, agentVersionId: "wrong-agent" }
              : route;
          },
        },
      },
    }),
    before = snapshot(f);
  await assert.rejects(f.composition.admitWorkflowNodes(f.input), {
    code: "workflow_child_route_mismatch",
  });
  assert.deepEqual(snapshot(f), before);
});

test("SQLite terminal child and parent wake commit together on an independently opened connection", async (t) => {
  const f = await compositionFixture(t);
  const writer = f.open(); // This connection predates installation of the durable terminal trigger.
  await f.store
    .experimentalWorkflowRunCompositionStore({
      dispatchChildren: childDispatch,
    })
    .admitWorkflowNodes(f.input);
  const row = f.database.prepare("SELECT * FROM workflow_node_children").get()!;
  const commit = {
    tenantId: f.input.tenantId,
    expectedRevision: 1,
    idempotency: { scope: "child-fail", key: "one", requestFingerprint: "one" },
    events: [
      {
        schemaVersion: "crewon.run-event.v0" as const,
        identity: { runId: String(row.child_run_id) },
        eventId: "child-failed",
        sequence: 2,
        occurredAt: new Date(f.clock.nowEpochMilliseconds()).toISOString(),
        type: "run.failed" as const,
        data: { code: "node-failed", retryable: false },
      },
    ],
    outbox: [],
    workItems: [],
  };
  f.database
    .prepare(
      `CREATE TRIGGER fail_wake BEFORE INSERT ON work_items WHEN NEW.work_item_id='${row.wake_work_item_id}' BEGIN SELECT RAISE(ABORT,'wake failed'); END`,
    )
    .run();
  const before = snapshot(f);
  await assert.rejects(writer.commitRun(commit), /sqlite_error/u);
  assert.deepEqual(snapshot(f), before);
  f.database.exec("DROP TRIGGER fail_wake");
  await writer.commitRun(commit);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM work_items WHERE work_item_id=?")
      .get(row.wake_work_item_id!)!.n,
    1,
  );
  const after = snapshot(f);
  await writer.commitRun(commit);
  assert.deepEqual(snapshot(f), after);
});

function snapshot(f: Awaited<ReturnType<typeof compositionFixture>>) {
  return {
    ...f.snapshot(),
    ...Object.fromEntries(
      [
        "workflow_node_children",
        "threads",
        "thread_events",
        "messages",
        "model_history_items",
        "thread_idempotency_receipts",
        "run_snapshots",
        "run_events",
        "idempotency_receipts",
        "outbox",
      ].map((table) => [
        table,
        f.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
  };
}
