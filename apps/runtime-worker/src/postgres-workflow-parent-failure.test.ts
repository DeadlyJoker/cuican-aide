import assert from "node:assert/strict";
import test from "node:test";
import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
  workflowOutputSchema,
} from "@crewon/domain";
import { postgresCompositionFixture } from "../../../packages/store/src/postgres-workflow-composition.test-support.ts";
import { parallelVersion } from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import { admissionVersion } from "../../../packages/store/src/workflow-run-admission.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { postgresParentWorker } from "./postgres-workflow-parent.test-support.ts";
const pgTest = process.env.CREWON_TEST_POSTGRES_URL ? test : test.skip;

pgTest(
  "PostgreSQL an invalid child fails the parent once without a fabricated reply or verifier sample",
  async (t) => {
    const f = await postgresCompositionFixture(t, { prepare: false });
    const runtime = await postgresParentWorker(f, t, {
      output: () => "not JSON",
    });
    const before = await f.snapshot();
    assert.equal((await runtime.worker.wake()).kind, "workflowWaiting");
    assert.equal((await runtime.worker.wake()).kind, "completed");
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "failed",
      runId: f.root.runId,
      code: "workflow_node_failed",
    });
    const root = (await f.store.loadRun(f.root))!;
    assert.equal(root.status, "failed");
    assert.equal(root.outputRef, null);
    assert.equal(runtime.requests.length, 1);
    assert.deepEqual(
      (await f.snapshot()).messages.filter(
        (row) => row.thread_id === root.threadId,
      ),
      before.messages.filter((row) => row.thread_id === root.threadId),
    );
    assert.equal((await runtime.worker.wake()).kind, "idle");
  },
);

pgTest(
  "PostgreSQL a failed DAG cannot finalize while a sibling still has pending execution",
  async (t) => {
    const f = await postgresCompositionFixture(t, {
      prepare: false,
      asset: parallelVersion(2),
    });
    let calls = 0;
    const runtime = await postgresParentWorker(f, t, {
      output: () => (++calls === 1 ? "not JSON" : '{"topic":"other-child"}'),
    });
    await runtime.worker.wake();
    const second = (await f.children()).find(
      (row) => row.node_id === "root-1",
    )!;
    await f.admin.query(
      `UPDATE ${f.sql}.work_items SET available_at=clock_timestamp()+interval '1 day' WHERE run_id=$1`,
      [second.child_run_id],
    );
    assert.equal((await runtime.worker.wake()).kind, "completed");
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "workflowWaiting",
      runId: f.root.runId,
      children: 1,
      humanGates: 0,
    });
    assert.equal((await f.store.loadRun(f.root))!.status, "running");
    // Failure propagation wakes the delayed original queue; the ordinary Worker honors cancellation.
    assert.equal(
      (await f.store.loadRun({
        tenantId: f.root.tenantId,
        runId: second.child_run_id,
      }))!.cancelRequested,
      true,
    );
    assert.equal((await runtime.worker.wake()).kind, "canceled");
    assert.deepEqual(await runtime.worker.wake(), {
      kind: "failed",
      runId: f.root.runId,
      code: "workflow_node_failed",
    });
    assert.equal(runtime.requests.length, 1);
  },
);

pgTest(
  "PostgreSQL aggregate output above budget fails the parent once without truncation or another model call",
  async (t) => {
    const schema = {
      type: "object" as const,
      properties: {
        topic: { type: "string" as const, maxLength: 9999, enum: null },
      },
      required: ["topic"],
      additionalProperties: false as const,
    };
    const asset = admissionVersion(schema),
      base = parseCompiledWorkflowVersion(
        asset.definitionJson,
        workflowAdmissionDigest,
      );
    const outputNodeIds = [
      "verify-one",
      "verify-two",
      "verify-three",
      "verify-four",
    ];
    const nodes = [
      base.nodes[0]!,
      ...outputNodeIds.map((nodeId) => ({ ...base.nodes[1]!, nodeId })),
    ];
    const compiled = compileWorkflowVersion(
      {
        schemaVersion: "crewon.workflow-version-source.v0",
        workflowId: base.workflowId,
        workflowVersionId: base.workflowVersionId,
        name: base.name,
        description: base.description,
        inputSchema: base.inputSchema,
        entryNodeIds: base.entryNodeIds,
        nodes,
        outputNodeIds,
        outputSchema: workflowOutputSchema({ nodes, outputNodeIds }),
      },
      workflowAdmissionDigest,
    );
    const f = await postgresCompositionFixture(t, {
      prepare: false,
      asset: {
        ...asset,
        contentDigest: compiled.contentDigest,
        definitionJson: serializeCompiledWorkflowVersion(compiled),
      },
    });
    const runtime = await postgresParentWorker(f, t, {
      output: () => JSON.stringify({ topic: "x".repeat(9000) }),
    });
    const before = await f.snapshot();
    for (let n = 0; n < 24; n++)
      if ((await runtime.worker.wake()).kind === "idle") break;
    const root = (await f.store.loadRun(f.root))!;
    assert.equal(root.status, "failed");
    assert.equal(root.failure?.code, "workflow_output_limit");
    assert.equal(root.outputRef, null);
    assert.equal(runtime.requests.length, 5);
    assert.deepEqual(
      (await f.snapshot()).messages.filter(
        (row) => row.thread_id === root.threadId,
      ),
      before.messages.filter((row) => row.thread_id === root.threadId),
    );
    assert.deepEqual(await f.store.listPendingWorkItems(100), []);
  },
);
