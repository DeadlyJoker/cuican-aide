import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { compileAgentVersion, createAgentVersionAsset } from "@crewon/agent-version";
import { ThreadApplicationService, WorkflowRunApplicationService } from "@crewon/application";
import { compileWorkflowVersion, serializeCompiledWorkflowVersion } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { WorkflowNodeSideEffectUncertainError } from "./workflow-runtime-dispatcher.ts";
import { createStandaloneRuntimeWorker, WORKFLOW_RUNTIME_CAPABILITIES } from "./standalone-composition.ts";

const digester = { sha256: (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` };
const schema = { type: "object" as const, properties: {}, required: [], additionalProperties: false as const };
const workflow = compileWorkflowVersion({
  schemaVersion: "crewon.workflow-version-source.v0", workflowId: "wf-gate",
  workflowVersionId: "wf-gate-v1", name: "gate", description: "gate",
  inputSchema: schema, outputSchema: schema, entryNodeIds: ["agent", "gate"],
  outputNodeIds: ["verification"], nodes: [
    { nodeId: "agent", title: "agent", instruction: "agent", kind: "agent",
      agentVersionId: "gate-agent-v1", dependsOn: [], inputSchema: schema, outputSchema: schema },
    { nodeId: "gate", title: "gate", instruction: "gate", kind: "humanGate",
      approvalPolicyId: "approval-policy-1", dependsOn: [], inputSchema: schema, outputSchema: schema },
    { nodeId: "verification", title: "verification", instruction: "verify",
      kind: "verification", verifierAgentVersionId: "gate-verification-v1",
      dependsOn: ["agent", "gate"], inputSchema: { type: "object",
        properties: { agent: schema, gate: schema }, required: ["agent", "gate"],
        additionalProperties: false }, outputSchema: schema },
  ],
}, digester);

for (const decision of ["approve", "reject"] as const) test(
  `SQLite gate Store/Worker vertical ${decision} uses durable resume authority`,
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `crewon-slice-three-${decision}-`));
    const path = join(directory, "runtime.sqlite");
    let runtime: Awaited<ReturnType<typeof createStandaloneRuntimeWorker>> | undefined;
    t.after(async () => {
      if (runtime !== undefined) await runtime.close();
      await rm(directory, { recursive: true, force: true });
    });
    const samples = new Map<string, number>();
    const versions = ["gate-agent-v1", "gate-verification-v1"].map(agentVersion);
    const config = { ...baseConfig(), agentVersionDeployments: versions.map((version) => ({
      schemaVersion: "crewon.agent-version-deployment.v0" as const, tenantId: "tenant-1",
      agentVersionId: version.agentVersionId, contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
      authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
      agentVersionRuntimeFactory: { create: ({ version }: { version: { agentVersionId: string } }) =>
        nodeRuntime(version.agentVersionId, samples) } };
    const setup = new SqliteRunStore(path, { workflowDigester: digester });
    for (const version of versions) await setup.registerAgentVersion(createAgentVersionAsset({
      tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z" }));
    await activateStandaloneRuntimeAgentVersionRelease({ ...config, databasePath: path,
      actor: actor(), authorization: allow(), clock: { now: () => "2026-08-12T00:00:00.000Z" },
      activationId: `activate-${decision}` });
    await new ThreadApplicationService({ store: setup, authorization: allow(),
      clock: { now: () => "2026-08-12T00:00:00.000Z" }, ids: { nextId: () => "gate-thread" },
      digester }).createThread(actor(), { kind: "thread.create",
      idempotencyKey: `thread-${decision}`, title: "Gate" });
    await setup.workflowVersionStore(digester).registerWorkflowVersion({
      schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
      workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
      contentDigest: workflow.contentDigest, definitionJson: serializeCompiledWorkflowVersion(workflow),
      createdAt: "2026-08-12T00:00:00.000Z" });
    let id = 0;
    const started = await new WorkflowRunApplicationService({ store: setup,
      authorization: allow(), clock: { now: () => "2026-08-12T00:00:01.000Z" },
      workflowDigester: digester, ids: { nextId: (kind) => `${kind}-${++id}` },
      routeResolver: { resolveRoute: async () => config.route },
    }).startWorkflowRun(actor(), { kind: "workflowRun.start",
      idempotencyKey: `start-${decision}`, workflowVersionId: workflow.workflowVersionId,
      threadId: "gate-thread", input: {} });
    const runId = started.run.state.runId;
    await setup.close();
    runtime = await openRuntime(path, config, samples, `gate-worker-${decision}`);

    await runtime.worker.wake();
    const published = inspect(path, runId);
    assert.deepEqual(published.schedulerStatuses, ["completed"]);
    assert.equal(published.agentWorkItems, 1);
    assert.equal(published.gateRequests.length, 1);
    assert.deepEqual(published.gateRequests.map(({ status }) => status), ["published"]);
    assert.equal(published.publicationOutbox, 1);
    assert.equal(published.gateStepStatus, "waitingApproval");
    await runtime.close();
    runtime = await openRuntime(path, config, samples, `gate-worker-replay-${decision}`);
    if (decision === "approve") await runtime.worker.wake();
    const afterRestart = inspect(path, runId);
    assert.equal(afterRestart.publicationOutbox, 1);
    assert.equal(samples.get("gate-agent-v1"), decision === "approve" ? 1 : undefined);
    assert.equal(afterRestart.verificationWorkItems, 0);

    const gate = afterRestart.gateRequests[0]!;
    const decisions = new SqliteRunStore(path, { workflowDigester: digester });
    const decisionInput = { tenantId: "tenant-1", runId, binding: {
      workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
      contentDigest: workflow.contentDigest }, nodeId: "gate", claimId: gate.claimId,
      claimEpoch: gate.claimEpoch, gateRequestId: gate.gateRequestId,
      decisionReceiptId: `decision-${decision}`, outcome: decision === "approve"
        ? { status: "completed" as const }
        : { status: "failed" as const, failureCode: "rejected" } };
    const recorded = await decisions.recordWorkflowHumanGateDecision(decisionInput);
    assert.equal(recorded.disposition, "recorded");
    assert.deepEqual(await decisions.recordWorkflowHumanGateDecision(decisionInput), {
      ...recorded, disposition: "replay" });
    if (decision === "reject") {
      leaseResume(path, recorded.approvalResumeWorkItemId);
      const settled = await decisions.settleWorkflowHumanGate({
        tenantId: "tenant-1", runId, binding: decisionInput.binding,
        nodeId: "gate", claimId: gate.claimId, claimEpoch: gate.claimEpoch,
        gateRequestId: gate.gateRequestId, decisionReceiptId: `decision-${decision}`,
        operationId: "settle-reject-with-sibling-pending", lease: {
          workItemId: recorded.approvalResumeWorkItemId, ownerId: "reject-resume-worker",
          leaseId: "reject-resume-lease", leaseEpoch: 1 },
      });
      assert.equal(settled.runDisposition, "nonTerminal");
      assert.equal(settled.execution.status, "running");
      assert.equal(inspect(path, runId).runStatus, "running");
      await decisions.close();
      return;
    }
    await decisions.close();
    const recordedState = inspect(path, runId);
    assert.equal(recordedState.resumeWorkItems, 1);
    assert.equal(recordedState.verificationWorkItems, 0);

    await runtime.worker.wake();
    const resumed = inspect(path, runId);
    assert.equal(resumed.resumeCompleted, 1);
    assert.equal(resumed.gateStepStatus, decision === "approve" ? "completed" : "failed");
    assert.equal(resumed.gateDagStatus, decision === "approve" ? "completed" : "failed");
    assert.equal(resumed.schedulerPending, 1);
    assert.equal(resumed.verificationWorkItems, 0);
    await runtime.worker.wake();
    assert.equal(inspect(path, runId).verificationWorkItems, 1);
    for (let wake = 0; wake < 2; wake += 1) await runtime.worker.wake();
    assert.equal(inspect(path, runId).runStatus, "completed");
    assert.deepEqual(samples, new Map([
      ["gate-agent-v1", 1], ["gate-verification-v1", 1],
    ]));
    const receipt = tamperDecisionReceipt(path, `decision-${decision}`);
    const replayStore = new SqliteRunStore(path, { workflowDigester: digester });
    await assert.rejects(
      replayStore.recordWorkflowHumanGateDecision(decisionInput),
      /corrupt|mismatch/u,
    );
    await replayStore.close();
    restoreDecisionReceipt(path, `decision-${decision}`, receipt);
  },
);

test("SQLite Slice 4 restart settles response-observed model work without resampling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-four-"));
  const path = join(directory, "runtime.sqlite");
  let runtime: Awaited<ReturnType<typeof createStandaloneRuntimeWorker>> | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const samples = new Map<string, number>();
  const versions = ["gate-agent-v1", "gate-verification-v1"].map(agentVersion);
  const config = { ...baseConfig(), agentVersionDeployments: versions.map((version) => ({
    schemaVersion: "crewon.agent-version-deployment.v0" as const, tenantId: "tenant-1",
    agentVersionId: version.agentVersionId, contentDigest: version.contentDigest,
    materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
    authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
    agentVersionRuntimeFactory: { create: ({ version }: { version: { agentVersionId: string } }) =>
      uncertainNodeRuntime(version.agentVersionId, samples) } };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions) await setup.registerAgentVersion(createAgentVersionAsset({
    tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z" }));
  await activateStandaloneRuntimeAgentVersionRelease({ ...config, databasePath: path,
    actor: actor(), authorization: allow(), clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-slice-four" });
  await new ThreadApplicationService({ store: setup, authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" }, ids: { nextId: () => "slice-four-thread" },
    digester }).createThread(actor(), { kind: "thread.create",
    idempotencyKey: "thread-slice-four", title: "Slice four" });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest, definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z" });
  let id = 0;
  const started = await new WorkflowRunApplicationService({ store: setup,
    authorization: allow(), clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester, ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), { kind: "workflowRun.start", idempotencyKey: "start-slice-four",
    workflowVersionId: workflow.workflowVersionId, threadId: "slice-four-thread", input: {} });
  const runId = started.run.state.runId;
  await setup.close();

  runtime = await openUncertainRuntime(path, config, samples, "slice-four-crashed-worker");
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "responseObserved", continuationCount: 0,
    terminalEventCount: 0, nodeStatus: "unknown", reconcilePending: 1,
  });
  await runtime.close();
  runtime = await openUncertainRuntime(path, config, samples, "slice-four-recovery-worker");

  const reconciled = await runtime.worker.wake();
  assert.deepEqual(reconciled, { kind: "workflowRecovery", runId,
    code: "workflow_reconciliation_settled" });
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "terminal", continuationCount: 0,
    terminalEventCount: 1, nodeStatus: "completed", reconcilePending: 0,
  });

  const replay = await runtime.worker.wake();
  assert.notEqual(replay.kind, "workflowRecovery");
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "terminal", continuationCount: 0,
    terminalEventCount: 1, nodeStatus: "completed", reconcilePending: 0,
  });
});

test("SQLite Slice 4 not-dispatched reconciliation grants only a new admission", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-four-not-dispatched-"));
  const path = join(directory, "runtime.sqlite");
  let runtime: Awaited<ReturnType<typeof createStandaloneRuntimeWorker>> | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const samples = new Map<string, number>();
  const versions = ["gate-agent-v1", "gate-verification-v1"].map(agentVersion);
  const config = { ...baseConfig(), agentVersionDeployments: versions.map((version) => ({
    schemaVersion: "crewon.agent-version-deployment.v0" as const, tenantId: "tenant-1",
    agentVersionId: version.agentVersionId, contentDigest: version.contentDigest,
    materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
    authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
    agentVersionRuntimeFactory: { create: ({ version }: { version: { agentVersionId: string } }) =>
      preparedOnlyNodeRuntime(version.agentVersionId) } };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions) await setup.registerAgentVersion(createAgentVersionAsset({
    tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z" }));
  await activateStandaloneRuntimeAgentVersionRelease({ ...config, databasePath: path,
    actor: actor(), authorization: allow(), clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-slice-four-not-dispatched" });
  await new ThreadApplicationService({ store: setup, authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" }, ids: { nextId: () => "not-dispatched-thread" },
    digester }).createThread(actor(), { kind: "thread.create",
    idempotencyKey: "thread-not-dispatched", title: "Not dispatched" });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest, definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z" });
  let id = 0;
  const started = await new WorkflowRunApplicationService({ store: setup,
    authorization: allow(), clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester, ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), { kind: "workflowRun.start",
    idempotencyKey: "start-not-dispatched", workflowVersionId: workflow.workflowVersionId,
    threadId: "not-dispatched-thread", input: {} });
  const runId = started.run.state.runId;
  await setup.close();
  runtime = await openPreparedOnlyRuntime(path, config, "not-dispatched-crashed-worker");
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(samples, new Map());
  const before = inspectNodeAuthorities(path, runId);
  assert.deepEqual(before.dispatchStatuses, ["prepared"]);
  assert.equal(before.reconcilePending, 1);
  await runtime.close();
  runtime = await openPreparedOnlyRuntime(path, config, "not-dispatched-reconcile-worker");

  await runtime.worker.wake();
  const after = inspectNodeAuthorities(path, runId);
  assert.deepEqual(samples, new Map());
  assert.equal(after.reconcileCompleted, 1);
  assert.equal(after.nodeWorkItems.length, 2);
  assert.equal(new Set(after.nodeWorkItems.map(({ claimId }) => claimId)).size, 2);
  assert.deepEqual(after.nodeWorkItems.map(({ claimEpoch }) => claimEpoch), [1, 2]);
  await runtime.close();
  runtime = await openRuntime(path, config, samples, "not-dispatched-fresh-worker");
  await runtime.worker.wake();
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
});

function inspect(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const execution = JSON.parse(database.prepare(
      "SELECT state_json FROM workflow_executions WHERE run_id=?").get(runId)!.state_json as string);
    const gateRequests = database.prepare(`SELECT gate_request_id gateRequestId,
      claim_id claimId,claim_epoch claimEpoch,status FROM workflow_gate_requests WHERE run_id=?`).all(runId)
      .map((row) => ({ gateRequestId: String(row.gateRequestId), claimId: String(row.claimId),
        claimEpoch: Number(row.claimEpoch), status: String(row.status) }));
    const count = (sql: string) => database.prepare(sql).get(runId)!.count as number;
    const step = database.prepare("SELECT status FROM run_steps WHERE run_id=? AND step_id='gate'").get(runId);
    return { gateRequests, gateStepStatus: step?.status,
      gateDagStatus: execution.nodes.find((node: { nodeId: string }) => node.nodeId === "gate")?.status,
      schedulerStatuses: database.prepare(`SELECT status FROM work_items WHERE run_id=? AND
        json_extract(work_item_json,'$.payload.trigger')='workflowScheduler' ORDER BY work_item_order`).all(runId)
        .map((row) => row.status),
      agentWorkItems: count(`SELECT count(*) count FROM work_items WHERE run_id=? AND
        json_extract(work_item_json,'$.payload.nodeId')='agent'`),
      verificationWorkItems: count(`SELECT count(*) count FROM work_items WHERE run_id=? AND
        json_extract(work_item_json,'$.payload.nodeId')='verification'`),
      publicationOutbox: count(`SELECT count(*) count FROM outbox WHERE run_id=? AND topic='workflow.gate.requested'`),
      resumeWorkItems: count(`SELECT count(*) count FROM work_items WHERE run_id=? AND
        json_extract(work_item_json,'$.payload.trigger')='workflowGateResume'`),
      resumeCompleted: count(`SELECT count(*) count FROM work_items WHERE run_id=? AND status='completed' AND
        json_extract(work_item_json,'$.payload.trigger')='workflowGateResume'`),
      schedulerPending: count(`SELECT count(*) count FROM work_items WHERE run_id=? AND status='pending' AND
        json_extract(work_item_json,'$.payload.trigger')='workflowScheduler'`),
      runStatus: JSON.parse(database.prepare(
        "SELECT state_json FROM run_snapshots WHERE run_id=?").get(runId)!.state_json as string).status };
  } finally { database.close(); }
}

function leaseResume(path: string, workItemId: string) {
  const database = new DatabaseSync(path);
  try {
    database.prepare(`UPDATE work_items SET status='leased',lease_owner_id='reject-resume-worker',
      lease_id='reject-resume-lease',lease_epoch=1,lease_expires_at_ms=9999999999999
      WHERE work_item_id=? AND status='pending'`).run(workItemId);
  } finally { database.close(); }
}

function tamperDecisionReceipt(path: string, operationId: string): string {
  const database = new DatabaseSync(path);
  try {
    const original = String(database.prepare(
      "SELECT result_json FROM workflow_composition_receipts WHERE operation_id=?",
    ).get(operationId)!.result_json);
    database.prepare(`UPDATE workflow_composition_receipts SET result_json=json_set(
      result_json,'$.approvalResumeWorkItemId','forged') WHERE operation_id=?`).run(operationId);
    return original;
  } finally { database.close(); }
}
function restoreDecisionReceipt(path: string, operationId: string, resultJson: string) {
  const database = new DatabaseSync(path);
  try { database.prepare(
    "UPDATE workflow_composition_receipts SET result_json=? WHERE operation_id=?",
  ).run(resultJson, operationId); } finally { database.close(); }
}

async function openRuntime(path: string, config: ReturnType<typeof baseConfig> & Record<string, unknown>,
  samples: Map<string, number>, ownerId: string) {
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map((agentVersionId) => ({
      tenantId: "tenant-1", runtime: nodeRuntime(agentVersionId, samples) })),
    workflowComposition: { certification: { schemaVersion: "crewon.workflow-runtime-certification.v0",
      capabilities: WORKFLOW_RUNTIME_CAPABILITIES }, versions: store.workflowVersionStore(digester),
      store: store as never, close: () => store.close() } });
}
async function openUncertainRuntime(path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>, samples: Map<string, number>,
  ownerId: string) {
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1",
        runtime: uncertainNodeRuntime(agentVersionId, samples) })),
    workflowComposition: { certification: { schemaVersion: "crewon.workflow-runtime-certification.v0",
      capabilities: WORKFLOW_RUNTIME_CAPABILITIES }, versions: store.workflowVersionStore(digester),
      store: store as never, close: () => store.close() } });
}
async function openPreparedOnlyRuntime(path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>, ownerId: string) {
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1", runtime: preparedOnlyNodeRuntime(agentVersionId) })),
    workflowComposition: { certification: { schemaVersion: "crewon.workflow-runtime-certification.v0",
      capabilities: WORKFLOW_RUNTIME_CAPABILITIES }, versions: store.workflowVersionStore(digester),
      store: store as never, close: () => store.close() } });
}
function inspectReconciliation(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const execution = JSON.parse(database.prepare(
      "SELECT state_json FROM workflow_executions WHERE run_id=?").get(runId)!.state_json as string);
    return { dispatchStatus: database.prepare(
      "SELECT status FROM model_dispatch_receipts WHERE run_id=?").get(runId)?.status,
      continuationCount: database.prepare(
        "SELECT count(*) count FROM workflow_node_continuations WHERE run_id=?",
      ).get(runId)!.count,
      terminalEventCount: database.prepare(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='workflow.node.completed'`).get(runId)!.count,
      nodeStatus: execution.nodes.find((node: { nodeId: string }) => node.nodeId === "agent")?.status,
      reconcilePending: database.prepare(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND status='pending' AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`)
        .get(runId)!.count };
  } finally { database.close(); }
}
function inspectNodeAuthorities(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const count = (status: string) => database.prepare(`SELECT count(*) count FROM work_items
      WHERE run_id=? AND status=? AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`)
      .get(runId, status)!.count;
    return { dispatchStatuses: database.prepare(
      "SELECT status FROM model_dispatch_receipts WHERE run_id=? ORDER BY rowid").all(runId)
      .map(({ status }) => status), reconcilePending: count("pending"),
      reconcileCompleted: count("completed"), nodeWorkItems: database.prepare(`SELECT
        json_extract(work_item_json,'$.payload.claimId') claimId,
        json_extract(work_item_json,'$.payload.claimEpoch') claimEpoch
        FROM work_items WHERE run_id=? AND
        json_extract(work_item_json,'$.payload.trigger')='workflowNode' ORDER BY work_item_order`)
        .all(runId).map(({ claimId, claimEpoch }) => ({ claimId, claimEpoch })) };
  } finally { database.close(); }
}
function actor() { return { principalId: "principal", actorId: "actor", tenantId: "tenant-1", spaceId: "space-1" }; }
function allow() { return { authorize: async () => ({ outcome: "allow" as const }) }; }
function baseConfig() { return { runtimeTenantId: "tenant-1", route: { authorityId: "authority",
  runtimeGeneration: "ts-v0", agentVersionId: "root-agent", policySnapshotId: "policy-1",
  workspaceBindingId: null }, transport: { adapterName: "unused", adapterVersion: "1", modelId: "unused",
  async *stream() { yield { type: "completed" as const, checkpoint: null }; } },
  modelContextWindowTokens: 128_000, autoCompactAtTokens: null } as const; }
function nodeRuntime(agentVersionId: string, samples: Map<string, number>) {
  const version = agentVersion(agentVersionId);
  return { version, policy: {} as never, toolRuntime: { definitions: () => [], executionPolicy: () => null,
    execute: async () => { throw new Error("tool forbidden"); }, reconcile: async () => { throw new Error("tool forbidden"); } },
    kernel: { supportsModelDispatchEvidence: true,
      modelIdentity: { adapterName: "test", adapterVersion: "1", modelId: "model" },
      async *runSegment(contract: { runId: string; segmentId: string }, _signal: AbortSignal,
        options: { controlSink?: Record<string, (value: unknown) => Promise<void>> }) {
        samples.set(agentVersionId, (samples.get(agentVersionId) ?? 0) + 1);
        const evidence = { operationId: `${contract.segmentId}:dispatch`, requestSequence: 1,
          operation: "dispatch", requestDigest: digester.sha256(agentVersionId), provider: {
            agentVersionId, adapterName: "test", adapterVersion: "1", modelId: "model" } };
        await options.controlSink?.modelRequestPrepared?.(evidence);
        await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
        const base = { schemaVersion: "crewon.agent-event.v0", runId: contract.runId,
          segmentId: contract.segmentId } as const;
        yield { ...base, sequence: 1, type: "segment.started", data: { attempt: 1, model: "model" } };
        yield { ...base, sequence: 2, type: "segment.provider_response_created", data: { checkpoint: {
          schemaVersion: "crewon.provider-checkpoint.v0", adapterName: "test", adapterVersion: "1",
          modelId: "model", opaquePayload: { responseId: `${agentVersionId}-response` } } } };
        yield { ...base, sequence: 3, type: "model.output.delta", data: { delta: "{}" } };
        yield { ...base, sequence: 4, type: "segment.completed", data: { output: "{}" } };
      } } } as never;
}
function uncertainNodeRuntime(agentVersionId: string, samples: Map<string, number>) {
  const version = agentVersion(agentVersionId);
  return { version, policy: {} as never, toolRuntime: {
    definitions: () => [], executionPolicy: () => null,
    execute: async () => { throw new Error("tool forbidden"); },
    reconcile: async () => { throw new Error("tool forbidden"); } },
    kernel: { supportsModelDispatchEvidence: true,
      modelIdentity: { adapterName: "test", adapterVersion: "1", modelId: "model" },
    async *runSegment(contract: { runId: string; segmentId: string }, _signal: AbortSignal,
      options: { controlSink?: Record<string, (value: unknown) => Promise<void>> }) {
      samples.set(agentVersionId, (samples.get(agentVersionId) ?? 0) + 1);
      const evidence = { operationId: `${contract.segmentId}:dispatch`, requestSequence: 1,
        operation: "dispatch", requestDigest: digester.sha256(agentVersionId), provider: {
          agentVersionId, adapterName: "test", adapterVersion: "1", modelId: "model" } };
      await options.controlSink?.modelRequestPrepared?.(evidence);
      await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
      const base = { schemaVersion: "crewon.agent-event.v0", runId: contract.runId,
        segmentId: contract.segmentId } as const;
      yield { ...base, sequence: 1, type: "segment.started", data: { attempt: 1, model: "model" } };
      yield { ...base, sequence: 2, type: "segment.provider_response_created", data: { checkpoint: {
        schemaVersion: "crewon.provider-checkpoint.v0", adapterName: "test", adapterVersion: "1",
        modelId: "model", opaquePayload: { responseId: `${agentVersionId}-response` } } } };
      throw new WorkflowNodeSideEffectUncertainError();
    } } } as never;
}
function preparedOnlyNodeRuntime(agentVersionId: string) {
  const version = agentVersion(agentVersionId);
  return { version, policy: {} as never, toolRuntime: {
    definitions: () => [], executionPolicy: () => null,
    execute: async () => { throw new Error("tool forbidden"); },
    reconcile: async () => { throw new Error("tool forbidden"); } },
    kernel: { supportsModelDispatchEvidence: true,
      modelIdentity: { adapterName: "test", adapterVersion: "1", modelId: "model" },
    async *runSegment(contract: { runId: string; segmentId: string }, _signal: AbortSignal,
      options: { controlSink?: Record<string, (value: unknown) => Promise<void>> }) {
      const evidence = { operationId: `${contract.segmentId}:dispatch`, requestSequence: 1,
        operation: "dispatch", requestDigest: digester.sha256(agentVersionId), provider: {
          agentVersionId, adapterName: "test", adapterVersion: "1", modelId: "model" } };
      await options.controlSink?.modelRequestPrepared?.(evidence);
      throw new WorkflowNodeSideEffectUncertainError();
    } } } as never;
}
function agentVersion(agentVersionId: string) { return compileAgentVersion({
  schemaVersion: "crewon.agent-version-source.v0", agentVersionId, runtimeGeneration: "ts-v0",
  policySnapshotId: "policy-1", instructions: null, model: { adapterName: "test", adapterVersion: "1",
    modelId: "model", contextWindowTokens: 128_000, autoCompactAtTokens: null },
  execution: { streamMaxRetries: 1, maxToolRounds: 1 }, resources: {
    workspaceRequired: false, governedContextDigest: null }, tools: [] }, digester); }
