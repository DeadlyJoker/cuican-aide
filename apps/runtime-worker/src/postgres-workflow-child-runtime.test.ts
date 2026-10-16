import assert from "node:assert/strict";
import test from "node:test";
import { CrewONAgentKernel } from "@crewon/agent-kernel";
import { RunExecutionService } from "@crewon/application";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { RuntimeWorker } from "./runtime-worker.ts";

const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL an ordinary Worker executes a handed-off child and atomically wakes its parent without sampling the root",
  async (t) => {
    const f = await postgresCompositionFixture(t);
    const workerStore = await f.open();
    let calls = 0,
      ids = 0;
    const worker = new RuntimeWorker(
      {
        store: workerStore,
        execution: new RunExecutionService({
          store: workerStore,
          clock: { now: () => new Date().toISOString() },
          ids: { nextId: () => `pg-child-${++ids}` },
          digester: workflowAdmissionDigest,
        }),
        policy: new PinnedRunExecutionPolicy({
          authorityId: f.root.authorityId,
          runtimeGeneration: f.root.runtimeGeneration,
          policySnapshotId: f.root.policySnapshotId,
          workspaceBindingId: f.root.workspaceBindingId,
          agentVersionId: "agent-1",
        }),
        kernel: new CrewONAgentKernel({
          transport: {
            adapterName: "synthetic-pg-child",
            adapterVersion: "1",
            modelId: "synthetic",
            async *stream(request) {
              calls++;
              assert.notEqual(request.runId, f.root.runId);
              yield { type: "output.delta", delta: '{"topic":"child-result"}' };
              yield { type: "completed", checkpoint: null };
            },
          },
        }),
      },
      {
        ownerId: "pg-child-worker",
        nextLeaseId: () => `pg-child-lease-${++ids}`,
        scanIntervalMs: null,
        leaseDurationMs: 30_000,
        cancellationScheduler: { every: () => () => {} },
      },
    );
    t.after(() => worker.close());
    await f.composition.admitWorkflowNodes(f.input);
    const child = (await f.children())[0]!;
    const locator = {
      tenantId: f.root.tenantId,
      threadId: child.child_thread_id,
    };
    const prefix = await f.store.listModelHistoryItems(locator, 0, 100);
    assert.equal((await worker.wake()).kind, "completed");
    assert.equal(calls, 1);
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: child.child_run_id,
      }))!.status,
      "completed",
    );
    assert.equal(
      (await f.store.listMessages(locator, 0, 100)).at(-1)!.content,
      '{"topic":"child-result"}',
    );
    assert.deepEqual(
      (await f.store.listModelHistoryItems(locator, 0, 100)).slice(
        0,
        prefix.length,
      ),
      prefix,
    );
    const wakes = (
      await f.admin.query(
        `SELECT work_item_json,status FROM ${f.sql}.work_items WHERE work_item_id=$1`,
        [child.wake_work_item_id],
      )
    ).rows;
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].status, "pending");
    assert.equal(wakes[0].work_item_json.runId, f.root.runId);
    assert.equal(wakes[0].work_item_json.payload.trigger, "workflowScheduler");
    assert.deepEqual(
      await f.store.listModelUsage({
        tenantId: f.root.tenantId,
        runId: f.root.runId,
        afterOrder: 0,
        limit: 10,
      }),
      [],
    );
    // Replaying the admission retains its child identity; a successor requires a new wake operation.
    await f.composition.admitWorkflowNodes(f.input);
    assert.deepEqual(await f.children(), [child]);
    assert.equal(calls, 1);
  },
);
