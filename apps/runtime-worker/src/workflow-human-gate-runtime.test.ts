import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelTransportPort, ModelRequest } from "@crewon/agent-kernel";
import {
  compileWorkflowVersion,
  parseCompiledWorkflowVersion,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import {
  InMemoryToolBroker,
  ToolExecutionUnknownOutcomeError,
} from "@crewon/tool-broker";
import {
  compositionFixture,
  compositionInput,
  claimCompositionWork,
  parallelVersion,
} from "../../../packages/store/src/workflow-run-composition.test-support.ts";
import {
  sequentialGateVersion,
  gateActor,
  gateCompositionOptions,
  gateCommand,
  WorkflowHumanGateApplicationService,
} from "../../../packages/store/src/workflow-human-gate.test-support.ts";
import { workflowAdmissionDigest } from "../../../packages/store/src/workflow-run-admission-validation.ts";
import { childWorker } from "./workflow-child-worker.test-support.ts";

function model(output: string) {
  const requests: ModelRequest[] = [];
  const transport: ModelTransportPort = {
    adapterName: "human-gate-fixture",
    adapterVersion: "1",
    modelId: "synthetic",
    async *stream(request) {
      requests.push(request);
      yield { type: "output.delta", delta: output };
      yield {
        type: "usage",
        inputTokens: 90,
        cachedInputTokens: 64,
        outputTokens: 12,
        totalTokens: 102,
      };
      yield { type: "completed", checkpoint: null };
    },
  };
  return { requests, transport };
}

test("ordinary Workers resume Agent, human review and Verifier across a parked scheduler and reopened Store without resampling the Agent", async (t) => {
  const f = await compositionFixture(t, {
    nowEpochMs: Date.now(),
    asset: sequentialGateVersion(),
    composition: gateCompositionOptions,
  });
  await f.composition.admitWorkflowNodes(f.input);
  await f.store.completeWorkItem(f.input.lease);
  const agentModel = model('{"topic":"agent-result"}'),
    agent = childWorker(f, t, agentModel.transport);
  assert.equal((await agent.worker.wake()).kind, "completed");
  await agent.worker.close();
  assert.equal(agent.callbacks.size, 0);
  const store = f.open(),
    scheduler = store.experimentalWorkflowRunCompositionStore(
      gateCompositionOptions,
    );
  const gateInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(store, "publish-review"),
  );
  const waiting = (await scheduler.admitWorkflowNodes(gateInput)).execution;
  assert.equal(waiting.status, "waitingHuman");
  const command = gateCommand(waiting, "review");
  await store.completeWorkItem(gateInput.lease);
  await store.close();
  const counts = f.database
    .prepare("SELECT count(*) AS n FROM model_history_items")
    .get()!.n;
  const historyBeforeWait = f.database
    .prepare(
      "SELECT * FROM model_history_items ORDER BY tenant_id,thread_id,sequence",
    )
    .all();
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  f.clock.advance(7 * 86_400_000);
  const idleModel = model("must-not-run"),
    idle = childWorker(f, t, idleModel.transport);
  assert.equal((await idle.worker.wake()).kind, "idle");
  await idle.worker.close();
  assert.equal(idleModel.requests.length, 0);
  assert.equal(
    f.database.prepare("SELECT count(*) AS n FROM model_history_items").get()!
      .n,
    counts,
  );
  const reopened = f.open(),
    resumed = reopened.experimentalWorkflowRunCompositionStore(
      gateCompositionOptions,
    ),
    gates = new WorkflowHumanGateApplicationService(resumed);
  const view = await gates.getGate(gateActor, command);
  assert.deepEqual(view.input, { topic: "agent-result" });
  const approved = await gates.decideGate(gateActor, command);
  assert.deepEqual(
    f.database
      .prepare(
        "SELECT * FROM model_history_items ORDER BY tenant_id,thread_id,sequence",
      )
      .all(),
    historyBeforeWait,
  );
  assert.equal(
    (await gates.decideGate(gateActor, command)).disposition,
    "replayed",
  );
  assert.equal(approved.decision.authority.inputDigest, command.inputDigest);
  const verifyInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(reopened, "review-approved"),
  );
  const ready = (await resumed.admitWorkflowNodes(verifyInput)).execution;
  assert.deepEqual(
    ready.nodes.map((n) => n.status),
    ["completed", "completed", "running"],
  );
  await reopened.completeWorkItem(verifyInput.lease);
  await reopened.close();
  const verifierModel = model('{"topic":"verified"}'),
    verifier = childWorker(
      f,
      t,
      verifierModel.transport,
      undefined,
      "verifier-1",
    );
  assert.equal((await verifier.worker.wake()).kind, "completed");
  await verifier.worker.close();
  assert.equal(agentModel.requests.length, 1);
  assert.equal(verifierModel.requests.length, 1);
  assert.ok(JSON.stringify(verifierModel.requests[0]).includes("agent-result"));
  const finalStore = f.open(),
    finalizer = finalStore.experimentalWorkflowRunCompositionStore(
      gateCompositionOptions,
    );
  const finalInput = compositionInput(
    f.input.binding,
    await claimCompositionWork(finalStore, "verified"),
  );
  assert.equal(
    (await finalizer.admitWorkflowNodes(finalInput)).execution.status,
    "completed",
  );
  const final = await finalizer.finalizeWorkflowRun(finalInput);
  assert.equal(final.run.status, "completed");
  assert.equal(
    (
      await finalStore.listMessages(
        { tenantId: final.run.tenantId, threadId: final.run.threadId },
        0,
        10,
      )
    ).at(-1)!.content,
    '{"topic":"verified"}',
  );
  assert.deepEqual(await finalStore.listPendingWorkItems(10), []);
  assert.equal(
    f.database
      .prepare("SELECT count(*) AS n FROM run_attempts WHERE run_id=?")
      .get(f.input.runId)!.n,
    2,
  );
  for (const request of [agentModel.requests[0]!, verifierModel.requests[0]!]) {
    const usage = await finalStore.listModelUsage({
      tenantId: f.input.tenantId,
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
  assert.deepEqual(
    await finalStore.listModelUsage({ ...f.input, afterOrder: 0, limit: 10 }),
    [],
  );
  assert.deepEqual(
    (
      await new WorkflowHumanGateApplicationService(finalizer).decideGate(
        gateActor,
        command,
      )
    ).decision,
    approved.decision,
  );
  await finalStore.close();
});

function parallelReviewVersion() {
  const asset = parallelVersion(2, "humanGate"),
    base = parseCompiledWorkflowVersion(
      asset.definitionJson,
      workflowAdmissionDigest,
    );
  const first = base.nodes.find((n) => n.nodeId === "root-0")!;
  const nodes = base.nodes.map((n) =>
    n.nodeId === "root-0"
      ? {
          kind: "agent" as const,
          nodeId: n.nodeId,
          title: n.title,
          instruction: n.instruction,
          dependsOn: n.dependsOn,
          inputSchema: n.inputSchema,
          outputSchema: n.outputSchema,
          agentVersionId: "agent-1",
        }
      : n.kind === "humanGate"
        ? { ...n, approvalPolicyId: "review-policy" }
        : n,
  );
  const compiled = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: base.workflowId,
      workflowVersionId: base.workflowVersionId,
      name: base.name,
      description: base.description,
      inputSchema: first.inputSchema,
      outputSchema: base.outputSchema,
      entryNodeIds: base.entryNodeIds,
      outputNodeIds: base.outputNodeIds,
      nodes,
    },
    workflowAdmissionDigest,
  );
  return {
    ...asset,
    contentDigest: compiled.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(compiled),
  };
}

test("rejecting a gate directly signals a sibling with an unknown tool effect; recovery does not repeat the model or mutation", async (t) => {
  const f = await compositionFixture(t, {
    nowEpochMs: Date.now(),
    asset: parallelReviewVersion(),
    composition: gateCompositionOptions,
  });
  const state = (await f.composition.admitWorkflowNodes(f.input)).execution;
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
    adapterName: "gate-tool-fixture",
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
  const first = childWorker(f, t, transport, broker);
  assert.equal((await first.worker.wake()).kind, "retried");
  await first.worker.close();
  await first.store.close();
  const command = gateCommand(state, "root-1", "rejected");
  await new WorkflowHumanGateApplicationService(f.composition).decideGate(
    gateActor,
    command,
  );
  const childId = String(
    f.database.prepare("SELECT child_run_id FROM workflow_node_children").get()!
      .child_run_id,
  );
  assert.equal(
    (await f.store.loadRun({ tenantId: f.input.tenantId, runId: childId }))!
      .cancelRequested,
    true,
  );
  // No parent scheduler pass is needed for the authorized rejection to signal the child.
  const recovered = childWorker(f, t, transport, broker);
  const unknown = await recovered.worker.wake();
  assert.equal(unknown.kind, "retried");
  assert.equal("code" in unknown && unknown.code, "tool_outcome_unknown");
  await assert.rejects(f.composition.finalizeWorkflowRun(f.input), {
    code: "workflow_finalization_pending",
  });
  assert.equal((await f.store.loadRun(f.input))!.status, "running");
  assert.equal(calls, 1);
  assert.equal(effects, 1);
  const gateWake = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "hold-gate-wake"),
  );
  broker.cancel = async (command) => ({
    status: "canceled",
    executionId: command.executionId,
    providerReceiptId: "gate-confirmed",
  });
  f.clock.advance(5000);
  assert.equal((await recovered.worker.wake()).kind, "canceled");
  await recovered.worker.close();
  const next = (await f.composition.admitWorkflowNodes(f.input)).execution;
  assert.deepEqual(
    next.nodes.map((n) => n.status),
    ["canceled", "failed", "canceled"],
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(f.input)).run.status,
    "failed",
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(gateWake)).disposition,
    "replayed",
  );
  const terminalWake = compositionInput(
    f.input.binding,
    await claimCompositionWork(f.store, "canceled-child"),
  );
  assert.equal(
    (await f.composition.finalizeWorkflowRun(terminalWake)).disposition,
    "replayed",
  );
  assert.deepEqual(await f.store.listPendingWorkItems(10), []);
  assert.equal(calls, 1);
  assert.equal(effects, 1);
});
