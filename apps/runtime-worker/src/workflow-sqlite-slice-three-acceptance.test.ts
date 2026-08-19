import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { compileAgentVersion, createAgentVersionAsset } from "@crewon/agent-version";
import {
  RunApplicationService,
  ThreadApplicationService,
  WorkflowRunApplicationService,
} from "@crewon/application";
import { compileWorkflowVersion, serializeCompiledWorkflowVersion } from "@crewon/domain";
import { SqliteRunStore } from "@crewon/store";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { WorkflowNodeSideEffectUncertainError } from "./workflow-runtime-dispatcher.ts";
import { createStandaloneRuntimeWorker } from "./standalone-composition.ts";

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
const gateOnlyWorkflow = compileWorkflowVersion({
  schemaVersion: "crewon.workflow-version-source.v0", workflowId: "wf-gate-only",
  workflowVersionId: "wf-gate-only-v1", name: "gate only", description: "gate only",
  inputSchema: schema, outputSchema: schema, entryNodeIds: ["gate"], outputNodeIds: ["verification"],
  nodes: [
    { nodeId: "gate", title: "gate", instruction: "gate", kind: "humanGate",
      approvalPolicyId: "approval-policy-1", dependsOn: [], inputSchema: schema, outputSchema: schema },
    { nodeId: "verification", title: "verification", instruction: "verify", kind: "verification",
      verifierAgentVersionId: "gate-verification-v1", dependsOn: ["gate"],
      inputSchema: schema, outputSchema: schema },
  ],
}, digester);

test("SQLite workflow cancel wake closes a pure waitingHuman run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-five-gate-cancel-"));
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
    activationId: "activate-gate-only-cancel" });
  await new ThreadApplicationService({ store: setup, authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" }, ids: { nextId: () => "gate-only-thread" },
    digester }).createThread(actor(), { kind: "thread.create",
    idempotencyKey: "thread-gate-only", title: "Gate only" });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: gateOnlyWorkflow.workflowId, workflowVersionId: gateOnlyWorkflow.workflowVersionId,
    contentDigest: gateOnlyWorkflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(gateOnlyWorkflow),
    createdAt: "2026-08-12T00:00:00.000Z" });
  let id = 0;
  const started = await new WorkflowRunApplicationService({ store: setup,
    authorization: allow(), clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester, ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), { kind: "workflowRun.start", idempotencyKey: "start-gate-only",
    workflowVersionId: gateOnlyWorkflow.workflowVersionId, threadId: "gate-only-thread", input: {} });
  const runId = started.run.state.runId;
  await setup.close();
  runtime = await openRuntime(path, config, samples, "gate-only-scheduler");
  await runtime.worker.wake();
  await publishWorkflowGate(path, runId, "gate-only-publisher");
  assert.deepEqual(inspectGateOnlyCancel(path, runId), {
    gateStatus: "published", gateStepStatus: "waitingApproval", pendingTriggers: [],
    runStatus: "running", cancelEvents: 0,
  });
  await runtime.close();
  runtime = undefined;

  const cancellationStore = new SqliteRunStore(path, { workflowDigester: digester });
  const current = await cancellationStore.loadRun({ tenantId: "tenant-1", runId });
  assert.ok(current);
  let cancelId = 0;
  const cancellation = new RunApplicationService({ store: cancellationStore,
    authorization: allow(), clock: { now: () => "2026-08-12T00:00:02.000Z" },
    ids: { nextId: (kind) => `cancel-${kind}-${++cancelId}` } });
  const command = { kind: "run.requestCancel" as const, runId,
    expectedRevision: current.revision, idempotencyKey: "cancel-gate-only" };
  await cancellation.transitionRun(actor(), command);
  await cancellation.transitionRun(actor(), command);
  assert.deepEqual(inspectGateOnlyCancel(path, runId).pendingTriggers, ["workflowCancel"]);
  await cancellationStore.close();

  runtime = await openRuntime(path, config, samples, "gate-only-cancel-worker");
  const outcome = await runtime.worker.wake();
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(samples, new Map());
  assert.deepEqual(inspectGateOnlyCancel(path, runId), {
    gateStatus: "canceled", gateStepStatus: "canceled", pendingTriggers: [],
    runStatus: "canceled", cancelEvents: 1,
  });
});

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
    await publishWorkflowGate(path, runId, `gate-publisher-${decision}`);
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

test("SQLite Slice 4 completes checkpoint-only reconciliation without resampling", async (t) => {
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
    code: "workflow_retrieved_node_settled" });
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "terminal", continuationCount: 0,
    terminalEventCount: 1, nodeStatus: "completed", reconcilePending: 0,
  });
  assert.deepEqual(inspectTerminalRecovery(path, runId), {
    stepStatus: "completed", attemptStatus: "completed", reconcileCompleted: 1,
    nodeCompleted: 1, failedEventCount: 0, runStatus: "running",
  });

  const replay = await runtime.worker.wake();
  assert.notEqual(replay.kind, "workflowRecovery");
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "terminal", continuationCount: 0,
    terminalEventCount: 1, nodeStatus: "completed", reconcilePending: 0,
  });
});

test("SQLite restart resumes a durable assistant continuation without response GET", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-continuation-vertical-"),
  );
  const path = join(directory, "runtime.sqlite");
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>
    | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const counters = {
    initialPosts: 0,
    injectedBeforePost: 0,
    resumePosts: 0,
    responseGets: 0,
  };
  const versions = ["gate-agent-v1", "gate-verification-v1"].map(agentVersion);
  const config = {
    ...baseConfig(),
    agentVersionDeployments: versions.map((version) => ({
      schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1",
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(
        `materialization:${version.agentVersionId}`,
      ),
      authorityId: `authority-${version.agentVersionId}`,
      workspaceBindingId: null,
    })),
    agentVersionRuntimeFactory: {
      create: ({ version }: { version: { agentVersionId: string } }) =>
        continuationNodeRuntime(version.agentVersionId, counters),
    },
  };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions)
    await setup.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant-1",
        version,
        createdAt: "2026-08-12T00:00:00.000Z",
      }),
    );
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath: path,
    actor: actor(),
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-continuation-vertical",
  });
  await new ThreadApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "continuation-thread" },
    digester,
  }).createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "thread-continuation",
    title: "Continuation",
  });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  let id = 0;
  const started = await new WorkflowRunApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), {
    kind: "workflowRun.start",
    idempotencyKey: "start-continuation",
    workflowVersionId: workflow.workflowVersionId,
    threadId: "continuation-thread",
    input: {},
  });
  const runId = started.run.state.runId;
  await setup.close();

  runtime = await openContinuationRuntime(
    path,
    config,
    counters,
    "continuation-crash-worker",
  );
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(counters, {
    initialPosts: 1,
    injectedBeforePost: 1,
    resumePosts: 0,
    responseGets: 0,
  });
  assert.deepEqual(inspectContinuationVertical(path, runId), {
    dispatchStatuses: ["responseObserved"],
    continuationCount: 1,
    nodeStatus: "unknown",
    attemptStatus: "running",
    attemptWorkTrigger: "workflowNode",
    terminalEventCount: 0,
    nodeWorkCompleted: 1,
    reconcilePending: 1,
    reconcileCompleted: 0,
  });
  await runtime.close();
  runtime = undefined;

  runtime = await openContinuationRuntime(
    path,
    config,
    counters,
    "continuation-resume-worker",
  );
  const resumed = await runtime.worker.wake();
  assert.deepEqual(counters, {
    initialPosts: 1,
    injectedBeforePost: 1,
    resumePosts: 1,
    responseGets: 0,
  });
  assert.deepEqual(resumed, {
    kind: "workflowRecovery",
    runId,
    code: "workflow_node_resumed_and_settled",
  });
  assert.deepEqual(inspectContinuationVertical(path, runId), {
    dispatchStatuses: ["terminal", "terminal"],
    continuationCount: 0,
    nodeStatus: "completed",
    attemptStatus: "completed",
    attemptWorkTrigger: "workflowReconcile",
    terminalEventCount: 1,
    nodeWorkCompleted: 1,
    reconcilePending: 0,
    reconcileCompleted: 1,
  });
});

test("SQLite GET continuation commit survives Worker close without another GET", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-retrieved-continuation-vertical-"),
  );
  const path = join(directory, "runtime.sqlite");
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>
    | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const counters: RetrievedContinuationCounters = {
    posts: 0,
    gets: 0,
    crashesAfterCommit: 0,
    verificationPosts: 0,
  };
  const versions = ["retrieved-agent-v1", "retrieved-verification-v1"].map(
    agentVersion,
  );
  const retrievedWorkflow = compileWorkflowVersion(
    {
      schemaVersion: "crewon.workflow-version-source.v0",
      workflowId: "wf-retrieved",
      workflowVersionId: "wf-retrieved-v1",
      name: "retrieved",
      description: "retrieved",
      inputSchema: schema,
      outputSchema: schema,
      entryNodeIds: ["agent"],
      outputNodeIds: ["verification"],
      nodes: [
        {
          nodeId: "agent",
          title: "agent",
          instruction: "agent",
          kind: "agent",
          agentVersionId: versions[0]!.agentVersionId,
          dependsOn: [],
          inputSchema: schema,
          outputSchema: schema,
        },
        {
          nodeId: "verification",
          title: "verification",
          instruction: "verification",
          kind: "verification",
          verifierAgentVersionId: versions[1]!.agentVersionId,
          dependsOn: ["agent"],
          inputSchema: schema,
          outputSchema: schema,
        },
      ],
    },
    digester,
  );
  const config = {
    ...baseConfig(),
    retryAfterMs: 0,
    agentVersionDeployments: versions.map((version) => ({
      schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1",
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(
        `retrieved-materialization:${version.agentVersionId}`,
      ),
      authorityId: `retrieved-authority:${version.agentVersionId}`,
      workspaceBindingId: null,
    })),
    agentVersionRuntimeFactory: {
      create: ({ version }: { version: { agentVersionId: string } }) =>
        retrievedContinuationNodeRuntime(version.agentVersionId, counters),
    },
  };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions)
    await setup.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant-1",
        version,
        createdAt: "2026-08-12T00:00:00.000Z",
      }),
    );
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath: path,
    actor: actor(),
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-retrieved-continuation",
  });
  await new ThreadApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "retrieved-thread" },
    digester,
  }).createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "thread-retrieved",
    title: "Retrieved",
  });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: retrievedWorkflow.workflowId,
    workflowVersionId: retrievedWorkflow.workflowVersionId,
    contentDigest: retrievedWorkflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(retrievedWorkflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  let id = 0;
  const started = await new WorkflowRunApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `retrieved-${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), {
    kind: "workflowRun.start",
    idempotencyKey: "start-retrieved",
    workflowVersionId: retrievedWorkflow.workflowVersionId,
    threadId: "retrieved-thread",
    input: {},
  });
  const runId = started.run.state.runId;
  await setup.close();

  runtime = await openRetrievedContinuationRuntime(
    path,
    config,
    counters,
    "retrieved-post-worker",
  );
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(counters, {
    posts: 1,
    gets: 0,
    crashesAfterCommit: 0,
    verificationPosts: 0,
  });
  assert.deepEqual(inspectRetrievedContinuation(path, runId), {
    dispatchStatuses: ["responseObserved"],
    continuationCount: 0,
    attemptStatus: "running",
    attemptWorkTrigger: "workflowNode",
    reconcilePending: 1,
    reconcileCompleted: 0,
    runStatus: "running",
    retrievedDeltas: 0,
    duplicateEvents: 0,
    duplicateOutbox: 0,
  });
  await runtime.close();
  runtime = undefined;

  runtime = await openRetrievedContinuationRuntime(
    path,
    config,
    counters,
    "retrieved-get-worker",
  );
  assert.deepEqual(await runtime.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_node_resume_result_unknown",
  });
  assert.deepEqual(counters, {
    posts: 1,
    gets: 1,
    crashesAfterCommit: 1,
    verificationPosts: 0,
  });
  assert.deepEqual(inspectRetrievedContinuation(path, runId), {
    dispatchStatuses: ["terminal"],
    continuationCount: 1,
    attemptStatus: "running",
    attemptWorkTrigger: "workflowReconcile",
    reconcilePending: 1,
    reconcileCompleted: 0,
    runStatus: "running",
    retrievedDeltas: 1,
    duplicateEvents: 0,
    duplicateOutbox: 0,
  });
  await runtime.close();
  runtime = undefined;

  runtime = await openRetrievedContinuationRuntime(
    path,
    config,
    counters,
    "retrieved-resume-worker",
  );
  for (let wake = 0; wake < 3; wake += 1) await runtime.worker.wake();
  assert.deepEqual(counters, {
    posts: 2,
    gets: 1,
    crashesAfterCommit: 1,
    verificationPosts: 1,
  });
  assert.deepEqual(inspectRetrievedContinuation(path, runId), {
    dispatchStatuses: ["terminal", "terminal", "terminal"],
    continuationCount: 0,
    attemptStatus: "completed",
    attemptWorkTrigger: "workflowReconcile",
    reconcilePending: 0,
    reconcileCompleted: 1,
    runStatus: "completed",
    retrievedDeltas: 1,
    duplicateEvents: 0,
    duplicateOutbox: 0,
  });
});

test("SQLite restart adopts a dispatched Workflow Tool Attempt before reconciling", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-tool-adoption-vertical-"),
  );
  const path = join(directory, "runtime.sqlite");
  let runtime:
    | Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>
    | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const counters = { modelPosts: 0, executes: 0, reconciles: 0 };
  const versions = [
    toolAgentVersion("gate-agent-v1"),
    agentVersion("gate-verification-v1"),
  ];
  const config = {
    ...baseConfig(),
    agentVersionDeployments: versions.map((version) => ({
      schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1",
      agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(
        `materialization:${version.agentVersionId}`,
      ),
      authorityId: `authority-${version.agentVersionId}`,
      workspaceBindingId: null,
    })),
    agentVersionRuntimeFactory: {
      create: ({ version }: { version: { agentVersionId: string } }) =>
        workflowToolCrashRuntime(version.agentVersionId, counters),
    },
  };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions)
    await setup.registerAgentVersion(
      createAgentVersionAsset({
        tenantId: "tenant-1",
        version,
        createdAt: "2026-08-12T00:00:00.000Z",
      }),
    );
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath: path,
    actor: actor(),
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-tool-adoption",
  });
  await new ThreadApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "tool-thread" },
    digester,
  }).createThread(actor(), {
    kind: "thread.create",
    idempotencyKey: "thread-tool-adoption",
    title: "Tool adoption",
  });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0",
    tenantId: "tenant-1",
    workflowId: workflow.workflowId,
    workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  let id = 0;
  const started = await new WorkflowRunApplicationService({
    store: setup,
    authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun(actor(), {
    kind: "workflowRun.start",
    idempotencyKey: "start-tool-adoption",
    workflowVersionId: workflow.workflowVersionId,
    threadId: "tool-thread",
    input: {},
  });
  const runId = started.run.state.runId;
  await setup.close();

  runtime = await openWorkflowToolCrashRuntime(
    path,
    config,
    counters,
    "tool-crash-worker",
  );
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(counters, { modelPosts: 1, executes: 1, reconciles: 0 });
  assert.deepEqual(inspectWorkflowToolAdoption(path, runId), {
    receiptStatus: "dispatched",
    receiptWorkTrigger: "workflowNode",
    toolAttemptStatuses: ["running"],
    toolAttemptWorkTriggers: ["workflowNode"],
    toolCompletedEvents: 0,
    continuationCount: 1,
    nodeStatus: "unknown",
    parentAttemptStatus: "running",
    reconcilePending: 1,
    reconcileCompleted: 0,
  });
  await runtime.close();
  runtime = undefined;

  runtime = await openWorkflowToolCrashRuntime(
    path,
    config,
    counters,
    "tool-resume-worker",
  );
  assert.deepEqual(await runtime.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_node_resumed_and_settled",
  });
  assert.deepEqual(counters, { modelPosts: 2, executes: 1, reconciles: 1 });
  assert.deepEqual(inspectWorkflowToolAdoption(path, runId), {
    receiptStatus: "completed",
    receiptWorkTrigger: "workflowReconcile",
    toolAttemptStatuses: ["completed"],
    toolAttemptWorkTriggers: ["workflowReconcile"],
    toolCompletedEvents: 1,
    continuationCount: 0,
    nodeStatus: "completed",
    parentAttemptStatus: "completed",
    reconcilePending: 0,
    reconcileCompleted: 1,
  });
});

test("SQLite Slice 4 restart settles a Store-owned terminal candidate once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-four-candidate-"));
  const path = join(directory, "runtime.sqlite");
  let runtime: Awaited<ReturnType<typeof createStandaloneRuntimeWorker>> | undefined;
  t.after(async () => { if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true }); });
  const samples = new Map<string, number>();
  const versions = ["gate-agent-v1", "gate-verification-v1"].map(agentVersion);
  let crash = true;
  const config = { ...baseConfig(), agentVersionDeployments: versions.map((version) => ({
    schemaVersion: "crewon.agent-version-deployment.v0" as const, tenantId: "tenant-1",
    agentVersionId: version.agentVersionId, contentDigest: version.contentDigest,
    materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
    authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
    agentVersionRuntimeFactory: { create: ({ version }: { version: { agentVersionId: string } }) =>
      nodeRuntime(version.agentVersionId, samples) },
    afterWorkflowTerminalCandidateCommitted: async () => {
      if (crash) { crash = false; throw new WorkflowNodeSideEffectUncertainError(); }
    } };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions) await setup.registerAgentVersion(createAgentVersionAsset({
    tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z" }));
  await activateStandaloneRuntimeAgentVersionRelease({ ...config, databasePath: path,
    actor: actor(), authorization: allow(), clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-terminal-candidate" });
  await new ThreadApplicationService({ store: setup, authorization: allow(),
    clock: { now: () => "2026-08-12T00:00:00.000Z" }, ids: { nextId: () => "candidate-thread" },
    digester }).createThread(actor(), { kind: "thread.create",
    idempotencyKey: "thread-terminal-candidate", title: "Candidate" });
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
    idempotencyKey: "start-terminal-candidate", workflowVersionId: workflow.workflowVersionId,
    threadId: "candidate-thread", input: {} });
  const runId = started.run.state.runId;
  await setup.close();
  runtime = await openRuntime(path, config, samples, "candidate-crash-worker");
  await runtime.worker.wake();
  await runtime.worker.wake();
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "responseObserved", continuationCount: 1,
    terminalEventCount: 0, nodeStatus: "unknown", reconcilePending: 1 });
  await runtime.close();
  runtime = await openRuntime(path, config, samples, "candidate-reconcile-worker");
  assert.deepEqual(await runtime.worker.wake(), { kind: "workflowRecovery", runId,
    code: "workflow_reconciliation_settled" });
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
  assert.deepEqual(inspectReconciliation(path, runId), {
    dispatchStatus: "terminal", continuationCount: 0,
    terminalEventCount: 1, nodeStatus: "completed", reconcilePending: 0 });
  assert.deepEqual(inspectCandidateTerminal(path, runId), {
    attemptStatus: "completed", stepStatus: "completed",
    nodeWorkCompleted: 1, reconcileWorkCompleted: 1,
    nodeEventCount: 1, nodeOutboxCount: 1,
    valueDigestMatches: true, runStatus: "running",
    snapshotThroughEvents: true,
  });
  const after = await runtime.worker.wake();
  assert.notEqual(after.kind, "workflowRecovery");
  assert.deepEqual(samples, new Map([["gate-agent-v1", 1]]));
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

function inspectGateOnlyCancel(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const snapshot = JSON.parse(String(database.prepare(
      "SELECT state_json FROM run_snapshots WHERE run_id=?").get(runId)!.state_json));
    return {
      gateStatus: database.prepare(
        "SELECT status FROM workflow_gate_requests WHERE run_id=? AND node_id='gate'",
      ).get(runId)?.status,
      gateStepStatus: database.prepare(
        "SELECT status FROM run_steps WHERE run_id=? AND step_id='gate'",
      ).get(runId)?.status,
      pendingTriggers: database.prepare(`SELECT json_extract(work_item_json,'$.payload.trigger') trigger
        FROM work_items WHERE run_id=? AND status='pending' ORDER BY work_item_order`).all(runId)
        .map(({ trigger }) => String(trigger)),
      runStatus: snapshot.status,
      cancelEvents: Number(database.prepare(`SELECT count(*) count FROM run_events
        WHERE run_id=? AND json_extract(event_json,'$.type')='run.cancel.requested'`).get(runId)!.count),
    };
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
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map((agentVersionId) => ({
      tenantId: "tenant-1", runtime: nodeRuntime(agentVersionId, samples) })),
  });
}
async function publishWorkflowGate(path: string, runId: string, ownerId: string) {
  const store = new SqliteRunStore(path, { workflowDigester: digester });
  try {
    for (let index = 0; index < 32; index += 1) {
      const claim = await store.claimNextOutbox({ ownerId,
        leaseId: `${ownerId}-lease-${index}`, leaseDurationMs: 30_000 });
      assert.ok(claim, "expected a pending Human Gate publication");
      const lease = { messageId: claim.message.messageId, ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId, leaseEpoch: claim.lease.epoch };
      if (claim.message.topic === "workflow.gate.requested") {
        assert.equal(claim.message.runId, runId);
        await store.publishWorkflowHumanGate({ lease, message: claim.message });
        return;
      }
      await store.acknowledgeOutbox(lease);
    }
    assert.fail("Human Gate publication was not found within the bounded Outbox scan");
  } finally { await store.close(); }
}
async function openUncertainRuntime(path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>, samples: Map<string, number>,
  ownerId: string) {
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1",
        runtime: uncertainNodeRuntime(agentVersionId, samples) })),
  });
}
async function openPreparedOnlyRuntime(path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>, ownerId: string) {
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1", runtime: preparedOnlyNodeRuntime(agentVersionId) })),
  });
}
async function openContinuationRuntime(path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>,
  counters: ContinuationCounters, ownerId: string) {
  return createStandaloneRuntimeWorker({ ...config, databasePath: path, scanIntervalMs: null, ownerId,
    additionalAgentVersionRuntimes: ["gate-agent-v1", "gate-verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1",
        runtime: continuationNodeRuntime(agentVersionId, counters) })),
  });
}
async function openRetrievedContinuationRuntime(
  path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>,
  counters: RetrievedContinuationCounters,
  ownerId: string,
) {
  return createStandaloneRuntimeWorker({
    ...config,
    databasePath: path,
    scanIntervalMs: null,
    ownerId,
    additionalAgentVersionRuntimes: [
      "retrieved-agent-v1",
      "retrieved-verification-v1",
    ].map((agentVersionId) => ({
      tenantId: "tenant-1",
      runtime: retrievedContinuationNodeRuntime(agentVersionId, counters),
    })),
  });
}
async function openWorkflowToolCrashRuntime(
  path: string,
  config: ReturnType<typeof baseConfig> & Record<string, unknown>,
  counters: WorkflowToolCounters,
  ownerId: string,
) {
  return createStandaloneRuntimeWorker({
    ...config,
    databasePath: path,
    scanIntervalMs: null,
    ownerId,
    additionalAgentVersionRuntimes: [
      "gate-agent-v1",
      "gate-verification-v1",
    ].map((agentVersionId) => ({
      tenantId: "tenant-1",
      runtime: workflowToolCrashRuntime(agentVersionId, counters),
    })),
  });
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
        AND json_extract(event_json,'$.type')='workflow.node.terminal'
        AND json_extract(event_json,'$.data.status')='completed'`).get(runId)!.count,
      nodeStatus: execution.nodes.find((node: { nodeId: string }) => node.nodeId === "agent")?.status,
      reconcilePending: database.prepare(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND status='pending' AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`)
        .get(runId)!.count };
  } finally { database.close(); }
}
function inspectCandidateTerminal(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const scalar = (sql: string) => database.prepare(sql).get(runId) as Record<string, unknown>;
    const execution = JSON.parse(String(scalar(
      "SELECT state_json FROM workflow_executions WHERE run_id=?").state_json));
    const node = execution.nodes.find((value: { nodeId: string }) => value.nodeId === "agent");
    const snapshot = JSON.parse(String(scalar(
      "SELECT state_json FROM run_snapshots WHERE run_id=?").state_json));
    const maxSequence = scalar("SELECT max(sequence) value FROM run_events WHERE run_id=?").value;
    return {
      attemptStatus: scalar("SELECT status FROM run_attempts WHERE run_id=? AND step_id='agent'").status,
      stepStatus: scalar("SELECT status FROM run_steps WHERE run_id=? AND step_id='agent'").status,
      nodeWorkCompleted: scalar(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND status='completed' AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'`).count,
      reconcileWorkCompleted: scalar(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND status='completed' AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`).count,
      nodeEventCount: scalar(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='workflow.node.terminal'`).count,
      nodeOutboxCount: scalar(`SELECT count(*) count FROM outbox WHERE run_id=?
        AND json_extract(message_json,'$.payload.eventType')='workflow.node.terminal'`).count,
      valueDigestMatches: scalar(`SELECT count(*) count FROM workflow_execution_values WHERE run_id=?
        AND role='nodeOutput' AND node_id='agent'`).count === 1 &&
        node.resultDigest === scalar(`SELECT value_digest FROM workflow_execution_values WHERE run_id=?
          AND role='nodeOutput' AND node_id='agent'`).value_digest,
      runStatus: snapshot.status,
      snapshotThroughEvents: snapshot.lastSequence === maxSequence,
    };
  } finally { database.close(); }
}
function inspectTerminalRecovery(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const scalar = (sql: string) => database.prepare(sql).get(runId) as Record<string, unknown>;
    return { stepStatus: scalar("SELECT status FROM run_steps WHERE run_id=? AND step_id='agent'").status,
      attemptStatus: scalar("SELECT status FROM run_attempts WHERE run_id=? AND step_id='agent'").status,
      reconcileCompleted: scalar(`SELECT count(*) count FROM work_items WHERE run_id=? AND status='completed'
        AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`).count,
      nodeCompleted: scalar(`SELECT count(*) count FROM work_items WHERE run_id=? AND status='completed'
        AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'`).count,
      failedEventCount: scalar(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='workflow.node.failed'`).count,
      runStatus: JSON.parse(String(scalar("SELECT state_json FROM run_snapshots WHERE run_id=?").state_json)).status };
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
function inspectContinuationVertical(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const scalar = (sql: string) =>
      database.prepare(sql).get(runId) as Record<string, unknown>;
    const countWork = (trigger: string, status: string) =>
      Number(
        database
          .prepare(
            `SELECT count(*) count
      FROM work_items WHERE run_id=? AND status=? AND
      json_extract(work_item_json,'$.payload.trigger')=?`,
          )
          .get(runId, status, trigger)!.count,
      );
    const execution = JSON.parse(
      String(
        scalar("SELECT state_json FROM workflow_executions WHERE run_id=?")
          .state_json,
      ),
    );
    return {
      dispatchStatuses: database
        .prepare(
          "SELECT status FROM model_dispatch_receipts WHERE run_id=? ORDER BY rowid",
        )
        .all(runId)
        .map(({ status }) => status),
      continuationCount: Number(
        scalar(
          "SELECT count(*) count FROM workflow_node_continuations WHERE run_id=?",
        ).count,
      ),
      nodeStatus: execution.nodes.find(
        (node: { nodeId: string }) => node.nodeId === "agent",
      )?.status,
      attemptStatus: scalar(
        "SELECT status FROM run_attempts WHERE run_id=? AND step_id='agent'",
      ).status,
      attemptWorkTrigger:
        scalar(`SELECT json_extract(work_item_json,'$.payload.trigger') trigger
        FROM run_attempts JOIN work_items USING(work_item_id) WHERE run_attempts.run_id=?
        AND step_id='agent'`).trigger,
      terminalEventCount: Number(
        scalar(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='workflow.node.terminal'`).count,
      ),
      nodeWorkCompleted: countWork("workflowNode", "completed"),
      reconcilePending: countWork("workflowReconcile", "pending"),
      reconcileCompleted: countWork("workflowReconcile", "completed"),
    };
  } finally {
    database.close();
  }
}
function inspectRetrievedContinuation(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const scalar = (sql: string) =>
      database.prepare(sql).get(runId) as Record<string, unknown>;
    const countWork = (status: string) =>
      Number(
        database
          .prepare(
            `SELECT count(*) count FROM work_items WHERE run_id=? AND status=?
        AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`,
          )
          .get(runId, status)!.count,
      );
    return {
      dispatchStatuses: database
        .prepare(
          "SELECT status FROM model_dispatch_receipts WHERE run_id=? ORDER BY rowid",
        )
        .all(runId)
        .map(({ status }) => status),
      continuationCount: Number(
        scalar(
          "SELECT count(*) count FROM workflow_node_continuations WHERE run_id=?",
        ).count,
      ),
      attemptStatus: scalar(
        "SELECT status FROM run_attempts WHERE run_id=? AND step_id='agent'",
      ).status,
      attemptWorkTrigger:
        scalar(`SELECT json_extract(work_item_json,'$.payload.trigger') trigger
        FROM run_attempts JOIN work_items USING(work_item_id)
        WHERE run_attempts.run_id=? AND step_id='agent'`).trigger,
      reconcilePending: countWork("pending"),
      reconcileCompleted: countWork("completed"),
      runStatus: JSON.parse(
        String(
          scalar("SELECT state_json FROM run_snapshots WHERE run_id=?")
            .state_json,
        ),
      ).status,
      retrievedDeltas: Number(
        scalar(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='model.output.delta'
        AND json_extract(event_json,'$.data.delta')='working'`).count,
      ),
      duplicateEvents: Number(
        scalar(`SELECT count(*) count FROM (
          SELECT json_extract(event_json,'$.type'),
            json_extract(event_json,'$.data.segmentId'),
            json_extract(event_json,'$.data.segmentSequence')
          FROM run_events WHERE run_id=?
            AND json_extract(event_json,'$.data.segmentId') IS NOT NULL
          GROUP BY 1,2,3 HAVING count(*) > 1)`).count,
      ),
      duplicateOutbox: Number(
        scalar(`SELECT count(*) count FROM (
          SELECT json_extract(message_json,'$.payload.eventId')
          FROM outbox WHERE run_id=?
            AND json_extract(message_json,'$.payload.eventId') IS NOT NULL
          GROUP BY 1 HAVING count(*) > 1)`).count,
      ),
    };
  } finally {
    database.close();
  }
}
function inspectWorkflowToolAdoption(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const scalar = (sql: string) =>
      database.prepare(sql).get(runId) as Record<string, unknown>;
    const execution = JSON.parse(
      String(
        scalar("SELECT state_json FROM workflow_executions WHERE run_id=?")
          .state_json,
      ),
    );
    const toolAttempts = database
      .prepare(
        `SELECT run_attempts.status status,
      json_extract(work_item_json,'$.payload.trigger') trigger FROM run_attempts
      JOIN work_items USING(work_item_id) WHERE run_attempts.run_id=? AND step_id LIKE 'tool:%'
      ORDER BY attempt_number`,
      )
      .all(runId);
    const receipt = database
      .prepare(
        `SELECT tool_execution_receipts.status status,
      json_extract(work_item_json,'$.payload.trigger') trigger FROM tool_execution_receipts
      JOIN work_items USING(work_item_id) WHERE tool_execution_receipts.run_id=?`,
      )
      .get(runId)!;
    const countWork = (status: string) =>
      Number(
        database
          .prepare(
            `SELECT count(*) count FROM work_items
      WHERE run_id=? AND status=? AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'`,
          )
          .get(runId, status)!.count,
      );
    return {
      receiptStatus: receipt.status,
      receiptWorkTrigger: receipt.trigger,
      toolAttemptStatuses: toolAttempts.map(({ status }) => status),
      toolAttemptWorkTriggers: toolAttempts.map(({ trigger }) => trigger),
      toolCompletedEvents: Number(
        scalar(`SELECT count(*) count FROM run_events WHERE run_id=?
        AND json_extract(event_json,'$.type')='tool.completed'`).count,
      ),
      continuationCount: Number(
        scalar(
          "SELECT count(*) count FROM workflow_node_continuations WHERE run_id=?",
        ).count,
      ),
      nodeStatus: execution.nodes.find(
        (node: { nodeId: string }) => node.nodeId === "agent",
      )?.status,
      parentAttemptStatus: scalar(
        "SELECT status FROM run_attempts WHERE run_id=? AND step_id='agent'",
      ).status,
      reconcilePending: countWork("pending"),
      reconcileCompleted: countWork("completed"),
    };
  } finally {
    database.close();
  }
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
    async *runSegment(contract: { runId: string; segmentId: string; reconcileCheckpoint?: {
      schemaVersion: "crewon.provider-checkpoint.v0"; adapterName: string; adapterVersion: string;
      modelId: string; opaquePayload: Record<string, unknown> } }, _signal: AbortSignal,
      options: { controlSink?: Record<string, (value: unknown) => Promise<void>> }) {
      const base = { schemaVersion: "crewon.agent-event.v0", runId: contract.runId,
        segmentId: contract.segmentId } as const;
      if (contract.reconcileCheckpoint !== undefined) {
        yield { ...base, sequence: 1, type: "segment.provider_response_created", data: {
          checkpoint: contract.reconcileCheckpoint } };
        yield { ...base, sequence: 2, type: "model.output.delta", data: { delta: "{}" } };
        yield { ...base, sequence: 3, type: "segment.completed", data: { output: "{}" } };
        return;
      }
      samples.set(agentVersionId, (samples.get(agentVersionId) ?? 0) + 1);
      const evidence = { operationId: `${contract.segmentId}:request:1`, requestSequence: 1,
        operation: "dispatch", requestDigest: digester.sha256(agentVersionId), provider: {
          agentVersionId, adapterName: "test", adapterVersion: "1", modelId: "model" } };
      await options.controlSink?.modelRequestPrepared?.(evidence);
      await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
      yield { ...base, sequence: 1, type: "segment.started", data: { attempt: 1, model: "model" } };
      yield { ...base, sequence: 2, type: "segment.provider_response_created", data: { checkpoint: {
        schemaVersion: "crewon.provider-checkpoint.v0", adapterName: "test", adapterVersion: "1",
        modelId: "model", opaquePayload: { responseId: `${agentVersionId}-response` } } } };
      throw new WorkflowNodeSideEffectUncertainError();
    } } } as never;
}
type WorkflowToolCounters = {
  modelPosts: number;
  executes: number;
  reconciles: number;
};
function workflowToolCrashRuntime(
  agentVersionId: string,
  counters: WorkflowToolCounters,
) {
  const version =
    agentVersionId === "gate-agent-v1"
      ? toolAgentVersion(agentVersionId)
      : agentVersion(agentVersionId);
  return {
    version,
    policy: {} as never,
    toolRuntime: {
      definitions: () => version.tools,
      executionPolicy: (kind: string, name: string) =>
        kind === "function" && name === "lookup"
          ? {
              effect: "readOnly" as const,
              recovery: "replaySafe" as const,
              resourceBindingId: null,
              credentialBindingId: null,
              executionTarget: {
                kind: "control" as const,
                bindingId: "lookup",
              },
              capability: "workspace.read",
              approvalRequirement: "none" as const,
              limits: {
                timeoutMs: 1_000,
                maxOutputBytes: 1_024,
                maxArtifactBytes: 1_024,
              },
            }
          : null,
      execute: async () => {
        counters.executes += 1;
        throw new WorkflowNodeSideEffectUncertainError();
      },
      reconcile: async (command: { executionId: string }) => {
        counters.reconciles += 1;
        return {
          status: "completed" as const,
          executionId: command.executionId,
          providerReceiptId: "tool-provider-1",
          result: {
            schemaVersion: "crewon.tool-result.v0" as const,
            callId: "lookup-1",
            output: "done",
            isError: false,
            artifactRef: null,
          },
        };
      },
    },
    kernel: {
      supportsModelDispatchEvidence: true,
      modelIdentity: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
      },
      async *runSegment(
        contract: {
          runId: string;
          segmentId: string;
          continuation?: { kind: string };
        },
        _signal: AbortSignal,
        options: {
          controlSink?: Record<string, (value: unknown) => Promise<void>>;
        },
      ) {
        counters.modelPosts += 1;
        await crossModelDispatch(options, contract.segmentId, agentVersionId);
        const base = {
          schemaVersion: "crewon.agent-event.v0",
          runId: contract.runId,
          segmentId: contract.segmentId,
        } as const;
        const checkpoint = providerCheckpoint(
          `${agentVersionId}-${counters.modelPosts}`,
        );
        yield {
          ...base,
          sequence: 1,
          type: "segment.started",
          data: { attempt: 1, model: "model" },
        };
        yield {
          ...base,
          sequence: 2,
          type: "segment.provider_response_created",
          data: { checkpoint },
        };
        if (counters.modelPosts === 1) {
          yield {
            ...base,
            sequence: 3,
            type: "tool.requested",
            data: {
              callId: "lookup-1",
              kind: "function",
              name: "lookup",
              input: "{}",
            },
          };
          return;
        }
        assert.equal(contract.continuation?.kind, "providerCheckpoint");
        yield {
          ...base,
          sequence: 3,
          type: "model.output.delta",
          data: { delta: "{}" },
        };
        yield {
          ...base,
          sequence: 4,
          type: "segment.completed",
          data: { output: "{}" },
        };
      },
    },
  } as never;
}
type ContinuationCounters = {
  initialPosts: number;
  injectedBeforePost: number;
  resumePosts: number;
  responseGets: number;
};
type RetrievedContinuationCounters = {
  posts: number;
  gets: number;
  crashesAfterCommit: number;
  verificationPosts: number;
};
function retrievedContinuationNodeRuntime(
  agentVersionId: string,
  counters: RetrievedContinuationCounters,
) {
  const version = agentVersion(agentVersionId);
  return {
    version,
    policy: {} as never,
    toolRuntime: {
      definitions: () => [],
      executionPolicy: () => null,
      execute: async () => {
        throw new Error("tool forbidden");
      },
      reconcile: async () => {
        throw new Error("tool forbidden");
      },
    },
    kernel: {
      supportsModelDispatchEvidence: true,
      modelIdentity: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
      },
      async *runSegment(
        contract: {
          runId: string;
          segmentId: string;
          continuation?: { kind: string };
          reconcileCheckpoint?: ReturnType<typeof providerCheckpoint>;
        },
        _signal: AbortSignal,
        options: {
          controlSink?: Record<string, (value: unknown) => Promise<void>>;
        },
      ) {
        const base = {
          schemaVersion: "crewon.agent-event.v0",
          runId: contract.runId,
          segmentId: contract.segmentId,
        } as const;
        if (agentVersionId === "retrieved-verification-v1") {
          counters.verificationPosts += 1;
          await crossRetrievedModelDispatch(
            options,
            contract.segmentId,
            agentVersionId,
          );
          const checkpoint = providerCheckpoint(
            `${agentVersionId}-${counters.verificationPosts}`,
          );
          yield {
            ...base,
            sequence: 1,
            type: "segment.started",
            data: { attempt: 1, model: "model" },
          };
          yield {
            ...base,
            sequence: 2,
            type: "segment.provider_response_created",
            data: { checkpoint },
          };
          yield {
            ...base,
            sequence: 3,
            type: "model.output.delta",
            data: { delta: "{}" },
          };
          yield {
            ...base,
            sequence: 4,
            type: "segment.completed",
            data: { output: "{}" },
          };
          return;
        }
        if (contract.reconcileCheckpoint !== undefined) {
          counters.gets += 1;
          assert.equal(counters.posts, 1);
          yield {
            ...base,
            sequence: 1,
            type: "segment.started",
            data: { attempt: 1, model: "model" },
          };
          yield {
            ...base,
            sequence: 2,
            type: "segment.provider_response_created",
            data: { checkpoint: contract.reconcileCheckpoint },
          };
          yield {
            ...base,
            sequence: 3,
            type: "model.output.delta",
            data: { delta: "working" },
          };
          yield {
            ...base,
            sequence: 4,
            type: "segment.continuation_requested",
            data: {
              output: "working",
              completedAssistantItems: ["working"],
              checkpoint: contract.reconcileCheckpoint,
            },
          };
          return;
        }
        if (counters.posts === 1 && counters.crashesAfterCommit === 0) {
          counters.crashesAfterCommit += 1;
          throw new WorkflowNodeSideEffectUncertainError();
        }
        counters.posts += 1;
        await crossRetrievedModelDispatch(
          options,
          contract.segmentId,
          version.agentVersionId,
        );
        const checkpoint = providerCheckpoint(
          `${version.agentVersionId}-${counters.posts}`,
        );
        yield {
          ...base,
          sequence: 1,
          type: "segment.started",
          data: { attempt: 1, model: "model" },
        };
        yield {
          ...base,
          sequence: 2,
          type: "segment.provider_response_created",
          data: { checkpoint },
        };
        if (counters.posts === 1) {
          throw new WorkflowNodeSideEffectUncertainError();
        }
        assert.equal(contract.continuation?.kind, "providerCheckpoint");
        yield {
          ...base,
          sequence: 3,
          type: "model.output.delta",
          data: { delta: "{}" },
        };
        yield {
          ...base,
          sequence: 4,
          type: "segment.completed",
          data: { output: "{}" },
        };
      },
    },
  } as never;
}
async function crossRetrievedModelDispatch(
  options: {
    controlSink?: Record<string, (value: unknown) => Promise<void>>;
  },
  segmentId: string,
  agentVersionId: string,
) {
  const evidence = {
    operationId: `${segmentId}:request:1`,
    requestSequence: 1,
    operation: "dispatch",
    requestDigest: digester.sha256(`${agentVersionId}:${segmentId}`),
    provider: {
      agentVersionId,
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
    },
  };
  await options.controlSink?.modelRequestPrepared?.(evidence);
  await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
}
function continuationNodeRuntime(
  agentVersionId: string,
  counters: ContinuationCounters,
) {
  const version = agentVersion(agentVersionId);
  return {
    version,
    policy: {} as never,
    toolRuntime: {
      definitions: () => [],
      executionPolicy: () => null,
      execute: async () => {
        throw new Error("tool forbidden");
      },
      reconcile: async () => {
        throw new Error("tool forbidden");
      },
    },
    kernel: {
      supportsModelDispatchEvidence: true,
      modelIdentity: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
      },
      async *runSegment(
        contract: {
          runId: string;
          segmentId: string;
          continuation?: { kind: string };
          reconcileCheckpoint?: unknown;
        },
        _signal: AbortSignal,
        options: {
          controlSink?: Record<string, (value: unknown) => Promise<void>>;
        },
      ) {
        if (contract.reconcileCheckpoint !== undefined) {
          counters.responseGets += 1;
          throw new Error("legacy response GET forbidden");
        }
        const base = {
          schemaVersion: "crewon.agent-event.v0",
          runId: contract.runId,
          segmentId: contract.segmentId,
        } as const;
        if (counters.initialPosts === 0) {
          counters.initialPosts += 1;
          await crossModelDispatch(options, contract.segmentId, agentVersionId);
          const checkpoint = providerCheckpoint(
            `${agentVersionId}-continuation`,
          );
          yield {
            ...base,
            sequence: 1,
            type: "segment.started",
            data: { attempt: 1, model: "model" },
          };
          yield {
            ...base,
            sequence: 2,
            type: "segment.provider_response_created",
            data: { checkpoint },
          };
          yield {
            ...base,
            sequence: 3,
            type: "model.output.delta",
            data: { delta: "working" },
          };
          yield {
            ...base,
            sequence: 4,
            type: "segment.continuation_requested",
            data: {
              output: "working",
              completedAssistantItems: ["working"],
              checkpoint,
            },
          };
          return;
        }
        if (counters.injectedBeforePost === 0) {
          counters.injectedBeforePost += 1;
          throw new WorkflowNodeSideEffectUncertainError();
        }
        assert.equal(contract.continuation?.kind, "providerCheckpoint");
        counters.resumePosts += 1;
        await crossModelDispatch(options, contract.segmentId, agentVersionId);
        const checkpoint = providerCheckpoint(`${agentVersionId}-terminal`);
        yield {
          ...base,
          sequence: 1,
          type: "segment.started",
          data: { attempt: 1, model: "model" },
        };
        yield {
          ...base,
          sequence: 2,
          type: "segment.provider_response_created",
          data: { checkpoint },
        };
        yield {
          ...base,
          sequence: 3,
          type: "model.output.delta",
          data: { delta: "{}" },
        };
        yield {
          ...base,
          sequence: 4,
          type: "segment.completed",
          data: { output: "{}" },
        };
      },
    },
  } as never;
}
function providerCheckpoint(responseId: string) {
  return {
    schemaVersion: "crewon.provider-checkpoint.v0" as const,
    adapterName: "test",
    adapterVersion: "1",
    modelId: "model",
    opaquePayload: { responseId },
  };
}
async function crossModelDispatch(
  options: {
    controlSink?: Record<string, (value: unknown) => Promise<void>>;
  },
  segmentId: string,
  agentVersionId: string,
) {
  const evidence = {
    operationId: `${segmentId}:dispatch`,
    requestSequence: 1,
    operation: "dispatch",
    requestDigest: digester.sha256(`${agentVersionId}:${segmentId}`),
    provider: {
      agentVersionId,
      adapterName: "test",
      adapterVersion: "1",
      modelId: "model",
    },
  };
  await options.controlSink?.modelRequestPrepared?.(evidence);
  await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
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
function toolAgentVersion(agentVersionId: string) {
  return compileAgentVersion(
    {
      schemaVersion: "crewon.agent-version-source.v0",
      agentVersionId,
      runtimeGeneration: "ts-v0",
      policySnapshotId: "policy-1",
      instructions: null,
      model: {
        adapterName: "test",
        adapterVersion: "1",
        modelId: "model",
        contextWindowTokens: 128_000,
        autoCompactAtTokens: null,
      },
      execution: { streamMaxRetries: 1, maxToolRounds: 1 },
      resources: {
        workspaceRequired: false,
        governedContextDigest: null,
      },
      tools: [
        {
          schemaVersion: "crewon.tool-definition.v0",
          kind: "function",
          name: "lookup",
          description: "Lookup",
          execution: "serial",
          inputSchema: schema,
        },
      ],
    },
    digester,
  );
}
