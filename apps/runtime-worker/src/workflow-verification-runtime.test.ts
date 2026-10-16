import assert from "node:assert/strict";
import test from "node:test";
import { schedulerFixture } from "../../../packages/store/src/workflow-scheduler.test-support.ts";
import { verificationTextVersion } from "../../../packages/store/src/workflow-verification.test-support.ts";
import {
  schedulerWorker,
  drainScheduler,
} from "./workflow-scheduler.test-support.ts";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import {
  canonicalJson,
  type WorkflowExecutionState,
} from "@crewon/application";
import { parseCompiledWorkflowVersion } from "@crewon/domain";
import {
  validateWorkflowNodeRows,
  type WorkflowNodeRow,
} from "../../../packages/store/src/workflow-node-authority.ts";
import { workflowNodeValue } from "../../../packages/store/src/workflow-node-value.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";

for (const scenario of [
  { text: "VERDICT: PASS", failure: null },
  { text: "VERDICT: FAIL", failure: "control_workflow_verification_failed" },
  {
    text: "VERDICT: PASS\nVERDICT: FAIL",
    failure: "control_workflow_verification_invalid",
  },
  { text: "Looks fine", failure: "control_workflow_verification_invalid" },
])
  test(`SQLite durable verifier settles ${JSON.stringify(scenario.text)} after reopen without resampling or publishing false success`, async (t) => {
    const f = await schedulerFixture(t, verificationTextVersion());
    const requests: string[] = [];
    const transport: ModelTransportPort = {
      adapterName: "verification-fixture",
      adapterVersion: "1",
      modelId: "synthetic",
      async *stream(request) {
        requests.push(request.runId);
        const child = await f.store.loadRun({
          tenantId: f.root.tenantId,
          runId: request.runId,
        });
        const result =
          child!.agentVersionId === "verifier-1"
            ? scenario.text
            : "Prepared evidence";
        if (child!.agentVersionId === "verifier-1")
          assert.match(JSON.stringify(request), /Transport clarification/);
        yield { type: "output.delta", delta: JSON.stringify({ result }) };
        yield { type: "completed", checkpoint: null };
      },
    };
    const first = schedulerWorker(f, t, { transport });
    assert.equal((await first.worker.wake()).kind, "workflowWaiting");
    assert.equal((await first.worker.wake()).kind, "completed");
    assert.equal((await first.worker.wake()).kind, "workflowWaiting");
    assert.equal((await first.worker.wake()).kind, "completed");
    assert.equal(requests.length, 2);
    const history = f.database
      .prepare("SELECT * FROM model_history_items ORDER BY rowid")
      .all();
    await first.worker.close();
    await first.store.close();
    const reopened = schedulerWorker(f, t, { transport });
    await drainScheduler(reopened.worker);
    const root = (await f.store.loadRun(f.root))!;
    assert.equal(
      root.status,
      scenario.failure === null ? "completed" : "failed",
    );
    const verifier = f.database
      .prepare("SELECT * FROM workflow_node_admissions WHERE node_id='verify'")
      .get()!;
    if (scenario.failure !== null) {
      assert.equal(verifier.output_json, null);
      const state = JSON.parse(
        String(
          f.database
            .prepare("SELECT state_json FROM workflow_executions")
            .get()!.state_json,
        ),
      );
      assert.equal(
        state.nodes.find((node: { nodeId: string }) => node.nodeId === "verify")
          .failureCode,
        scenario.failure,
      );
    }
    const messages = await f.store.listMessages(
      { tenantId: root.tenantId, threadId: root.threadId },
      0,
      100,
    );
    assert.equal(
      messages.filter((message) => message.role === "assistant").length,
      scenario.failure === null ? 1 : 0,
    );
    assert.equal(requests.length, 2);
    if (scenario.failure === null) {
      const state = JSON.parse(
        String(
          f.database
            .prepare("SELECT state_json FROM workflow_executions")
            .get()!.state_json,
        ),
      ) as WorkflowExecutionState;
      const workflow = parseCompiledWorkflowVersion(
        verificationTextVersion().definitionJson,
        workflowAdmissionDigest,
      );
      const rows = f.database
        .prepare(
          "SELECT n.*,q.tenant_id AS queue_tenant,q.run_id AS queue_run,q.lease_epoch AS queue_epoch,q.status AS queue_status,q.lease_expires_at_ms AS queue_expires FROM workflow_node_admissions n JOIN work_items q ON q.work_item_id=n.work_item_id",
        )
        .all() as unknown as WorkflowNodeRow[];
      validateWorkflowNodeRows(rows, state, workflow);
      // Simulate a retained older writer that accepted FAIL: all hashes and receipt fields agree.
      // Read authority must still refuse to treat it as a successful verification.
      const definition = workflow.nodes.find(
        (node) => node.kind === "verification",
      )!;
      const invalid = workflowNodeValue(
        { result: "VERDICT: FAIL" },
        definition.outputSchema,
      );
      const row = rows.find((node) => node.node_id === definition.nodeId)!;
      row.output_digest = invalid.digest;
      row.output_json = invalid.json;
      row.settlement_fingerprint = canonicalJson({
        kind: "workflow.node-settle.v1",
        nodeId: definition.nodeId,
        claimId: row.claim_id,
        outcome: { status: "completed", digest: invalid.digest },
      });
      const prior = {
        ...state,
        nodes: state.nodes.map((node) =>
          node.nodeId === definition.nodeId
            ? { ...node, resultDigest: invalid.digest }
            : node,
        ),
      };
      assert.throws(() => validateWorkflowNodeRows(rows, prior, workflow), {
        code: "workflow_node_authority_corrupt",
      });
    }
    const before = await f.store.listRunEvents(f.root, 0, 100);
    await drainScheduler(reopened.worker);
    assert.deepEqual(await f.store.listRunEvents(f.root, 0, 100), before);
    for (const row of history)
      assert.deepEqual(
        f.database
          .prepare("SELECT * FROM model_history_items WHERE item_id=?")
          .get(row.item_id as string),
        row,
      );
  });
