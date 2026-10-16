import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
} from "@crewon/tool-broker";
import type { ModelTransportPort, ModelRequest } from "@crewon/agent-kernel";
import { PostgresRunStore } from "../../../packages/store/src/postgres-run-store.ts";
import { postgresCancellationFixture } from "../../../packages/store/src/postgres-workflow-cancellation.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { postgresParentWorker } from "./postgres-workflow-parent.test-support.ts";
import { postgresWorkflowChildWorker } from "./postgres-workflow-worker.test-support.ts";
import type { PoolClient } from "pg";
import type { RunState, RunLifecycleEvent } from "@crewon/domain";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL a queued canceled Workflow drains both parent wakes without any model request after Worker restart",
  async (t) => {
    const f = await postgresCancellationFixture(t, { prepare: false });
    await f.request();
    const runtime = await postgresParentWorker(f, t);
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "canceled",
      runId: f.root.runId,
    });
    await runtime.worker.close();
    const reopened = await f.open();
    const resumed = await postgresParentWorker(
      {
        ...f,
        store: reopened,
        composition: reopened.experimentalWorkflowRunCompositionStore(f.config),
      },
      t,
    );
    assert.equal((await resumed.worker.wake()).kind, "canceled");
    assert.equal((await resumed.worker.wake()).kind, "idle");
    assert.equal(runtime.requests.length, 0);
    assert.equal(resumed.requests.length, 0);
    const events = await f.store.listRunEvents(f.root, 0, 100);
    assert.equal(
      events.filter((event) => event.type === "run.canceled").length,
      1,
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);

pgTest(
  "PostgreSQL cancelling a parked parallel Workflow stops every queued child and publishes one terminal parent without a verifier",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      prepare: false,
      asset: parallelVersion(6),
    });
    const runtime = await postgresParentWorker(f, t);
    assert.equal((await runtime.worker.wake()).kind, "workflowWaiting");
    assert.equal((await f.children()).length, 4);
    const before = await f.snapshot();
    await f.request();
    for (let pass = 0; pass < 12; pass++)
      if ((await runtime.worker.wake()).kind === "idle") break;
    assert.equal((await f.store.loadRun(f.root))!.status, "canceled");
    for (const child of await f.children())
      assert.equal(
        (await f.store.loadRun({
          tenantId: f.root.tenantId,
          runId: child.child_run_id,
        }))!.status,
        "canceled",
      );
    assert.equal((await f.children()).length, 4);
    assert.equal(runtime.requests.length, 0);
    assert.deepEqual((await f.snapshot()).messages, before.messages);
    const history = (await f.snapshot()).model_history_items;
    for (const original of before.model_history_items)
      assert.deepEqual(
        history.find((item) => item.item_id === original.item_id),
        original,
      );
    const ids = new Set(before.model_history_items.map((item) => item.item_id));
    const appended = history.filter((item) => !ids.has(item.item_id));
    assert.equal(appended.length, 4);
    assert.ok(
      appended.every(
        (item) =>
          (item.item_json as { source: string }).source === "turn_aborted",
      ),
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
    assert.ok(
      (await f.execution())!.nodes.every((node) => node.status === "canceled"),
    );
  },
);

pgTest(
  "PostgreSQL root cancellation interrupts an active child stream, retains its prefix and reported cache usage and waits for its real terminal state",
  { timeout: 30_000 },
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const callbacks = new Set<() => Promise<void>>();
    let enter!: () => void,
      released = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const requests: ModelRequest[] = [];
    const transport: ModelTransportPort = {
      adapterName: "pg-root-cancel-stream",
      adapterVersion: "1",
      modelId: "synthetic",
      releaseRun: () => {
        released++;
      },
      async *stream(request, signal) {
        requests.push(request);
        yield { type: "output.delta", delta: '{"topic":"unfinished' };
        yield {
          type: "usage",
          inputTokens: 90,
          cachedInputTokens: 64,
          outputTokens: 4,
          totalTokens: 94,
        };
        enter();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
    };
    const active = await postgresWorkflowChildWorker(f, t, undefined, {
      transport,
      cancellationScheduler: {
        every: (_ms, callback) => {
          callbacks.add(callback);
          return () => {
            callbacks.delete(callback);
          };
        },
      },
    });
    const pending = active.worker.wake();
    void pending.catch(() => {});
    assert.equal(
      await Promise.race([
        entered.then(() => "stream"),
        pending.then((result) => JSON.stringify(result)),
      ]),
      "stream",
    );
    const child = (await f.store.loadRun({
      tenantId: f.root.tenantId,
      runId: requests[0]!.runId,
    }))!;
    const prefix = await f.store.listModelHistoryItems(child, 0, 20);
    await f.request();
    await f.composition.propagateWorkflowCancellation(f.input);
    assert.equal((await f.store.loadRun(child))!.cancelRequested, true);
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
    await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
      code: "workflow_cancellation_recovery_required",
    });
    await Promise.all([...callbacks].map((callback) => callback()));
    assert.equal((await pending).kind, "canceled");
    const history = await f.store.listModelHistoryItems(child, 0, 20);
    assert.deepEqual(history.slice(0, prefix.length), prefix);
    const usage = await f.store.listModelUsage({
      ...child,
      afterOrder: 0,
      limit: 10,
    });
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.record.observation.usage.cachedInputTokens, 64);
    assert.equal(requests.length, 1);
    assert.equal(
      (await f.composition.propagateWorkflowCancellation(f.input)).status,
      "canceled",
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
    await active.worker.close();
    assert.equal(callbacks.size, 0);
    assert.equal(released, 1);
  },
);

pgTest(
  "PostgreSQL a canceled parent keeps an unknown child mutation reconciling across Worker restart without repeating it",
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
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
              timeoutMs: 30000,
              maxOutputBytes: 262144,
              maxArtifactBytes: 1048576,
            },
          },
        ],
      ]),
    );
    const transport: ModelTransportPort = {
      adapterName: "pg-root-cancel-tool",
      adapterVersion: "1",
      modelId: "synthetic",
      async *stream() {
        calls++;
        yield {
          type: "tool.call",
          kind: "function",
          callId: "uncertain-call",
          name: "uncertain_write",
          input: "{}",
        };
        yield { type: "completed", checkpoint: null };
      },
    };
    const first = await postgresWorkflowChildWorker(f, t, undefined, {
      transport,
      toolRuntime: broker,
    });
    assert.equal((await first.worker.wake()).kind, "retried");
    await first.worker.close();
    await f.request();
    const child = (await f.children())[0]!;
    const resumed = await postgresParentWorker(f, t, {
      child: { transport, toolRuntime: broker },
    });
    let unknown = false;
    for (let pass = 0; pass < 5; pass++) {
      const result = await resumed.worker.wake();
      if (result.kind === "retried" && result.code === "tool_outcome_unknown") {
        unknown = true;
        break;
      }
    }
    assert.ok(unknown);
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
    const before = (
      await f.admin.query(
        `SELECT available_at FROM ${f.sql}.work_items WHERE run_id=$1`,
        [child.child_run_id],
      )
    ).rows[0];
    // A replayed request and another parent pass must preserve the existing unknown-effect backoff.
    await f.request();
    for (let pass = 0; pass < 3; pass++)
      if ((await resumed.worker.wake()).kind === "idle") break;
    assert.deepEqual(
      (
        await f.admin.query(
          `SELECT available_at FROM ${f.sql}.work_items WHERE run_id=$1`,
          [child.child_run_id],
        )
      ).rows[0],
      before,
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
    broker.cancel = async (command) => ({
      status: "canceled",
      executionId: command.executionId,
      providerReceiptId: "fixture-root-cancel-confirmed",
    });
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET available_at=clock_timestamp() WHERE run_id=$1 AND status='pending'`,
      [child.child_run_id],
    );
    for (let pass = 0; pass < 6; pass++)
      if ((await resumed.worker.wake()).kind === "idle") break;
    assert.equal((await f.store.loadRun(f.root))!.status, "canceled");
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.status,
      "canceled",
    );
    assert.equal(calls, 1);
    assert.equal(effects, 1);
  },
);

class RacingCancellationWriter extends PostgresRunStore {
  beforeSignal: (() => Promise<void>) | undefined;
  protected override async wakeCanceledReconciliationWithin(
    client: PoolClient,
    state: RunState,
    events: readonly RunLifecycleEvent[],
  ) {
    if (state.purpose === "workflow") await this.beforeSignal?.();
    await super.wakeCanceledReconciliationWithin(client, state, events);
  }
}
pgTest(
  "PostgreSQL a child can commit its final reply and FK wake while a user cancellation holds the parent row",
  { timeout: 30_000 },
  async (t) => {
    const f = await postgresCancellationFixture(t);
    await f.composition.admitWorkflowNodes(f.input);
    const child = await postgresWorkflowChildWorker(f, t);
    const writer = new RacingCancellationWriter({
      connectionString: process.env.CREWON_TEST_POSTGRES_URL!,
      schema: f.schema,
    });
    t.after(() => writer.close());
    writer.beforeSignal = async () => {
      assert.equal((await child.worker.wake()).kind, "completed");
    };
    await f.request(writer);
    const completed = (await f.store.loadRun({
      tenantId: f.root.tenantId,
      runId: (await f.children())[0]!.child_run_id,
    }))!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.cancelRequested, false);
    const before = await f.snapshot();
    assert.equal(
      (await f.composition.propagateWorkflowCancellation(f.input)).status,
      "canceled",
    );
    assert.equal((await f.execution())!.nodes[0]!.status, "completed");
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
    assert.deepEqual((await f.snapshot()).messages, before.messages);
    assert.deepEqual(
      (await f.snapshot()).model_history_items,
      before.model_history_items,
    );
    assert.equal(child.requests.length, 1);
  },
);

pgTest(
  "PostgreSQL a later user cancellation preserves the failed node and existing sibling stop receipt",
  async (t) => {
    const f = await postgresCancellationFixture(t, {
      asset: parallelVersion(2),
    });
    await f.composition.admitWorkflowNodes(f.input);
    const child = await postgresWorkflowChildWorker(f, t, () => "not JSON");
    assert.equal((await child.worker.wake()).kind, "completed");
    const failed = (await f.composition.admitWorkflowNodes(f.input)).execution;
    assert.equal(failed.status, "failed");
    const sibling = (await f.children()).find(
      (row) => row.node_id === "root-1",
    )!;
    const before = await f.store.listRunEvents(
      { tenantId: f.root.tenantId, runId: sibling.child_run_id },
      0,
      100,
    );
    await f.request();
    await f.composition.propagateWorkflowCancellation(f.input);
    assert.equal((await child.worker.wake()).kind, "canceled");
    const canceled = await f.composition.propagateWorkflowCancellation(f.input);
    assert.deepEqual(
      canceled.nodes.map((node) => node.status),
      ["failed", "canceled", "canceled"],
    );
    assert.equal(
      (await f.composition.finalizeWorkflowRun(f.input)).run.status,
      "canceled",
    );
    const after = await f.store.listRunEvents(
      { tenantId: f.root.tenantId, runId: sibling.child_run_id },
      0,
      100,
    );
    assert.equal(
      before.filter((event) => event.type === "run.cancel.requested").length,
      1,
    );
    assert.equal(
      after.filter((event) => event.type === "run.cancel.requested").length,
      1,
    );
    assert.equal(child.requests.length, 1);
  },
);
