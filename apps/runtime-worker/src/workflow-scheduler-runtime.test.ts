import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
} from "@crewon/tool-broker";
import { schedulerFixture } from "../../../packages/store/src/workflow-scheduler.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import {
  gateActor,
  gateCommand,
  sequentialGateVersion,
  WorkflowHumanGateApplicationService,
} from "../../../packages/store/src/workflow-human-gate.test-support.ts";
import { requestWorkflowCancel } from "../../../packages/store/src/workflow-cancellation.test-support.ts";
import { readSqliteWorkflowExecution } from "../../../packages/store/src/sqlite-workflow-execution-authority.ts";
import { childWorker } from "./workflow-child-worker.test-support.ts";
import {
  schedulerWorker,
  drainScheduler,
} from "./workflow-scheduler.test-support.ts";

test("one Worker autonomously runs Agent, parks for human review, and resumes Verifier after reopening without resampling or rewriting its cache prefix", async (t) => {
  const f = await schedulerFixture(t, sequentialGateVersion());
  const first = schedulerWorker(f, t);
  assert.equal((await first.worker.wake()).kind, "workflowWaiting");
  assert.equal(first.requests.length, 0);
  assert.equal((await first.worker.wake()).kind, "completed");
  assert.deepEqual(await first.worker.wake(), {
    kind: "workflowWaiting",
    runId: f.root.runId,
    children: 0,
    humanGates: 1,
  });
  const history = f.database
    .prepare("SELECT * FROM model_history_items ORDER BY rowid")
    .all();
  const counts = f.counts();
  for (let n = 0; n < 100; n++)
    assert.equal((await first.worker.wake()).kind, "idle");
  assert.deepEqual(f.counts(), counts);
  await first.worker.close();
  await first.store.close();
  f.clock.advance(7 * 86_400_000);
  const gate = gateCommand(
    readSqliteWorkflowExecution(f.database, f.root)!,
    "review",
  );
  const app = new WorkflowHumanGateApplicationService(f.composition);
  assert.deepEqual((await app.getGate(gateActor, gate)).input, {
    topic: "agent-result",
  });
  await app.decideGate(gateActor, gate);
  await app.decideGate(gateActor, gate);
  assert.deepEqual(
    f.database
      .prepare("SELECT * FROM model_history_items ORDER BY rowid")
      .all(),
    history,
  );
  const resumed = schedulerWorker(f, t);
  const outcomes = await drainScheduler(resumed.worker);
  assert.ok(
    outcomes.some((o) => o.kind === "completed" && o.runId === f.root.runId),
  );
  assert.equal(first.requests.length, 1);
  assert.equal(resumed.requests.length, 1);
  assert.ok(JSON.stringify(resumed.requests[0]).includes("agent-result"));
  const root = (await f.store.loadRun(f.root))!;
  assert.equal(root.status, "completed");
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.equal(
    (
      await f.store.listMessages(
        { tenantId: root.tenantId, threadId: root.threadId },
        0,
        10,
      )
    ).at(-1)!.content,
    '{"topic":"verified"}',
  );
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM run_attempts WHERE run_id=?")
      .get(root.runId)!.n,
    2,
  );
  assert.deepEqual(
    await f.store.listModelUsage({ ...f.root, afterOrder: 0, limit: 10 }),
    [],
  );
  for (const request of [...first.requests, ...resumed.requests]) {
    const usage = await f.store.listModelUsage({
      tenantId: root.tenantId,
      runId: request.runId,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.record.observation.usage.cachedInputTokens, 64);
    assert.equal(
      usage[0]!.record.observation.usage.cachedInputTokensReported,
      true,
    );
  }
});

test("bounded parent passes fill at most four child slots and complete a larger DAG without a root model call", async (t) => {
  const f = await schedulerFixture(t, parallelVersion(8));
  const runtime = schedulerWorker(f, t);
  let peak = 0;
  for (let n = 0; n < 48; n++) {
    const outcome = await runtime.worker.wake();
    const active = Number(
      f.database
        .prepare(
          "SELECT count(*) AS n FROM workflow_node_children c JOIN run_snapshots r ON c.child_run_id=r.run_id AND c.tenant_id=r.tenant_id WHERE json_extract(r.state_json,'$.status') NOT IN ('completed','failed','canceled')",
        )
        .get()!.n,
    );
    peak = Math.max(peak, active);
    assert.ok(active <= 4);
    if (outcome.kind === "idle") break;
  }
  assert.equal(peak, 4);
  assert.equal(runtime.requests.length, 9);
  assert.ok(
    runtime.requests.every((request) => request.runId !== f.root.runId),
  );
  assert.equal((await f.store.loadRun(f.root))!.status, "completed");
  assert.deepEqual(await f.store.listPendingWorkItems(100), []);
});

test("child completion between admission and acknowledgement survives an extra parent wake and never repeats sampling", async (t) => {
  const f = await schedulerFixture(t);
  let calls = 0,
    hook = true;
  const child = childWorker(f, t, {
    adapterName: "race",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream() {
      calls++;
      yield { type: "output.delta", delta: '{"topic":"race-result"}' };
      yield { type: "completed", checkpoint: null };
    },
  });
  const parent = schedulerWorker(f, t, {
    afterAdmit: async () => {
      if (hook) {
        hook = false;
        assert.equal((await child.worker.wake()).kind, "completed");
      }
    },
  });
  assert.deepEqual(await parent.worker.wake(), {
    kind: "retried",
    runId: f.root.runId,
    code: "workflow_scheduler_ready",
  });
  await drainScheduler(parent.worker);
  assert.equal((await f.store.loadRun(f.root))!.status, "completed");
  assert.equal(calls, 1);
  assert.equal(parent.requests.length, 1);
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
});

test("a committed handoff followed by scheduler interruption recovers on reopen with one child identity and unchanged history", async (t) => {
  const f = await schedulerFixture(t);
  const interrupted = schedulerWorker(f, t, {
    afterAdmit: async () => {
      throw Error("fixture_after_handoff");
    },
  });
  assert.deepEqual(await interrupted.worker.wake(), {
    kind: "retried",
    runId: f.root.runId,
    code: "fixture_after_handoff",
  });
  const child = f.database
    .prepare("SELECT child_run_id,claim_id FROM workflow_node_children")
    .get();
  const history = f.database
    .prepare("SELECT * FROM model_history_items ORDER BY rowid")
    .all();
  await interrupted.worker.close();
  await interrupted.store.close();
  f.clock.advance(60_001);
  const recovered = schedulerWorker(f, t);
  await drainScheduler(recovered.worker);
  assert.equal((await f.store.loadRun(f.root))!.status, "completed");
  assert.equal(recovered.requests.length, 2);
  assert.deepEqual(
    f.database
      .prepare(
        "SELECT child_run_id,claim_id FROM workflow_node_children ORDER BY rowid LIMIT 1",
      )
      .get(),
    child,
  );
  const rows = f.database
    .prepare("SELECT * FROM model_history_items ORDER BY rowid")
    .all();
  assert.deepEqual(rows.slice(0, history.length), history);
});

test("queued root cancellation bypasses revoked execution policy and drains terminal replay wakes without a model", async (t) => {
  const f = await schedulerFixture(t);
  f.authorize(() => ({ outcome: "deny", reasonCode: "revoked" }));
  await requestWorkflowCancel(f.store, f.root, f.clock.nowEpochMilliseconds());
  const runtime = schedulerWorker(f, t);
  const outcomes = await drainScheduler(runtime.worker);
  assert.ok(
    outcomes.some(
      (outcome) =>
        outcome.kind === "canceled" && outcome.runId === f.root.runId,
    ),
  );
  assert.equal((await f.store.loadRun(f.root))!.status, "canceled");
  assert.equal(runtime.requests.length, 0);
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM run_attempts").get()!.n,
    0,
  );
});

test("denied scheduler work preserves the original queue identity and does not create model retries, events, or history", async (t) => {
  const f = await schedulerFixture(t);
  f.authorize(() => ({ outcome: "deny", reasonCode: "revoked" }));
  const counts = f.counts();
  const runtime = schedulerWorker(f, t);
  for (let n = 0; n < 8; n++) {
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "retried",
      runId: f.root.runId,
      code: "workflow_scheduler_policy_denied",
    });
    f.clock.advance(1001);
  }
  assert.deepEqual(f.counts(), counts);
  assert.equal(runtime.requests.length, 0);
  assert.equal((await f.store.loadRun(f.root))!.status, "queued");
  f.authorize(() => ({ outcome: "allow" }));
  await drainScheduler(runtime.worker);
  assert.equal((await f.store.loadRun(f.root))!.status, "completed");
});

test("Worker shutdown after a committed handoff releases the scheduler without canceling children or issuing a model retry", async (t) => {
  const f = await schedulerFixture(t);
  const entered = deferred(),
    release = deferred();
  const runtime = schedulerWorker(f, t, {
    afterAdmit: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const wake = runtime.worker.wake();
  await entered.promise;
  const closing = runtime.worker.close();
  release.resolve();
  assert.deepEqual(await wake, {
    kind: "retried",
    runId: f.root.runId,
    code: "workflow_scheduler_interrupted",
  });
  await closing;
  assert.equal(runtime.requests.length, 0);
  const run = (await f.store.loadRun(f.root))!;
  assert.equal(run.status, "running");
  assert.equal(run.cancelRequested, false);
  await runtime.store.close();
  f.clock.advance(1001);
  const recovered = schedulerWorker(f, t);
  await drainScheduler(recovered.worker);
  assert.equal((await f.store.loadRun(f.root))!.status, "completed");
  assert.equal(recovered.requests.length, 2);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a known invalid child output fails the root once without trying the verifier or resampling", async (t) => {
  const f = await schedulerFixture(t);
  let calls = 0;
  const runtime = schedulerWorker(f, t, {
    transport: {
      adapterName: "invalid-output",
      adapterVersion: "1",
      modelId: "synthetic",
      async *stream() {
        calls++;
        yield { type: "output.delta", delta: "not-json" };
        yield { type: "completed", checkpoint: null };
      },
    },
  });
  await drainScheduler(runtime.worker);
  const root = (await f.store.loadRun(f.root))!;
  assert.equal(root.status, "failed");
  assert.equal(root.failure!.code, "workflow_node_failed");
  assert.equal(calls, 1);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM workflow_node_children")
      .get()!.n,
    1,
  );
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
});

test("automatic root cancellation parks behind an unknown child mutation until its provider confirms cancellation", async (t) => {
  const f = await schedulerFixture(t);
  let calls = 0,
    effects = 0;
  const broker = new InMemoryToolBroker(
    [
      {
        schemaVersion: "crewon.tool-definition.v0",
        kind: "function",
        name: "uncertain_write",
        description: "Fixture",
        execution: "serial",
        inputSchema: { type: "object" },
      },
    ],
    new Map([
      [
        "function:uncertain_write",
        async () => {
          effects++;
          throw new ToolExecutionUnknownOutcomeError();
        },
      ],
    ]),
    new Map([
      [
        "function:uncertain_write",
        {
          effect: "mutation",
          recovery: "reconcilable",
          resourceBindingId: null,
          credentialBindingId: null,
          executionTarget: {
            kind: "control",
            bindingId: "in-memory-tool-broker",
          },
          capability: "workspace.write",
          approvalRequirement: "none",
          limits: {
            timeoutMs: 30_000,
            maxOutputBytes: 262_144,
            maxArtifactBytes: 1_048_576,
          },
        },
      ],
    ]),
  );
  const transport = {
    adapterName: "unknown-mutation",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream() {
      calls++;
      yield {
        type: "tool.call" as const,
        kind: "function" as const,
        callId: "uncertain-call",
        name: "uncertain_write",
        input: "{}",
      };
      yield { type: "completed" as const, checkpoint: null };
    },
  };
  const runtime = schedulerWorker(f, t, { toolRuntime: broker, transport });
  assert.equal((await runtime.worker.wake()).kind, "workflowWaiting");
  const unknown = await runtime.worker.wake();
  assert.equal(unknown.kind, "retried");
  await runtime.worker.close();
  await runtime.store.close();
  await requestWorkflowCancel(f.store, f.root, f.clock.nowEpochMilliseconds());
  const recovered = schedulerWorker(f, t, { toolRuntime: broker, transport });
  const outcomes = await drainScheduler(recovered.worker);
  assert.ok(outcomes.some((outcome) => outcome.kind === "workflowWaiting"));
  assert.equal((await f.store.loadRun(f.root))!.status, "running");
  assert.equal(calls, 1);
  assert.equal(effects, 1);
  broker.cancel = async (command) => ({
    status: "canceled",
    executionId: command.executionId,
    providerReceiptId: "confirmed",
  });
  f.clock.advance(5001);
  await drainScheduler(recovered.worker);
  assert.equal((await f.store.loadRun(f.root))!.status, "canceled");
  assert.equal(calls, 1);
  assert.equal(effects, 1);
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
});
