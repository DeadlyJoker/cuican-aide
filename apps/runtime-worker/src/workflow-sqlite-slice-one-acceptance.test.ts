import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compileWorkflowVersion, replayRunLifecycle,
  serializeCompiledWorkflowVersion,
} from "@crewon/domain";
import {
  compileAgentVersion,
  createAgentVersionAsset,
} from "@crewon/agent-version";
import { SqliteRunStore } from "@crewon/store";
import {
  ThreadApplicationService,
  WorkflowRunApplicationService,
} from "@crewon/application";
import {
  createStandaloneRuntimeWorker,
} from "./standalone-composition.ts";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";

const digester = { sha256: (value: string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}` };
const schema = { type: "object" as const, properties: {}, required: [],
  additionalProperties: false as const };
const workflow = compileWorkflowVersion({
  schemaVersion: "crewon.workflow-version-source.v0", workflowId: "wf",
  workflowVersionId: "wf-v1", name: "slice", description: "slice",
  inputSchema: schema, outputSchema: schema, entryNodeIds: ["agent"],
  outputNodeIds: ["verification"], nodes: [
    { nodeId: "agent", title: "agent", instruction: "agent", kind: "agent",
      agentVersionId: "agent-v1", dependsOn: [], inputSchema: schema,
      outputSchema: schema },
    { nodeId: "verification", title: "verification", instruction: "verify",
      kind: "verification", verifierAgentVersionId: "verification-v1",
      dependsOn: ["agent"], inputSchema: schema, outputSchema: schema },
  ],
}, digester);
const parallelWorkflow = compileWorkflowVersion({
  schemaVersion: "crewon.workflow-version-source.v0", workflowId: "wf-parallel",
  workflowVersionId: "wf-parallel-v1", name: "slice two", description: "parallel",
  inputSchema: schema, outputSchema: schema, entryNodeIds: ["left", "right"],
  outputNodeIds: ["verification"], nodes: [
    { nodeId: "left", title: "left", instruction: "left", kind: "agent",
      agentVersionId: "left-v1", dependsOn: [], inputSchema: schema, outputSchema: schema },
    { nodeId: "right", title: "right", instruction: "right", kind: "agent",
      agentVersionId: "right-v1", dependsOn: [], inputSchema: schema, outputSchema: schema },
    { nodeId: "verification", title: "verification", instruction: "verify",
      kind: "verification", verifierAgentVersionId: "parallel-verification-v1",
      dependsOn: ["left", "right"], inputSchema: {
        type: "object", properties: { left: schema, right: schema },
        required: ["left", "right"], additionalProperties: false }, outputSchema: schema },
  ],
}, digester);
test("standalone SQLite Slice 1 converges real shared Agent to Verification", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-one-"));
  const path = join(directory, "runtime.sqlite");
  let runtime: Awaited<ReturnType<typeof createStandaloneRuntimeWorker>> | undefined;
  t.after(async () => {
    if (runtime !== undefined) await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const samples = new Map<string, number>();
  const nodeVersions = ["agent-v1", "verification-v1"].map(agentVersion);
  const config = { ...baseConfig(), agentVersionDeployments: nodeVersions.map(
    (version) => ({ schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1", agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
      authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
    agentVersionRuntimeFactory: { create: ({ version }: {
      version: { agentVersionId: string } }) =>
      nodeRuntime(version.agentVersionId, samples) },
  };
  const store = new SqliteRunStore(path, { workflowDigester: digester,
    clock: { nowEpochMilliseconds: () => Date.parse("2026-08-12T00:00:10.000Z") } });
  for (const version of nodeVersions) await store.registerAgentVersion(
    createAgentVersionAsset({ tenantId: "tenant-1", version,
      createdAt: "2026-08-12T00:00:00.000Z" }));
  await activateStandaloneRuntimeAgentVersionRelease({ ...config,
    databasePath: path, actor: { principalId: "principal", actorId: "actor",
      tenantId: "tenant-1", spaceId: "space-1" },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    activationId: "activate-slice" });
  let threadId = 0;
  await new ThreadApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => `thread-${++threadId}` }, digester,
  }).createThread({ principalId: "principal", actorId: "actor",
    tenantId: "tenant-1", spaceId: "space-1" }, {
    kind: "thread.create", idempotencyKey: "create-thread", title: "Slice",
  });
  t.after(() => store.close());
  await store.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: workflow.workflowId, workflowVersionId: workflow.workflowVersionId,
    contentDigest: workflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(workflow),
    createdAt: "2026-08-12T00:00:00.000Z",
  });
  let routeCalls = 0;
  let generatedIds = 0;
  const starts = new WorkflowRunApplicationService({ store,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" },
    workflowDigester: digester,
    ids: { nextId: (kind) => `${kind}-${++generatedIds}` },
    routeResolver: { resolveRoute: async () => {
      routeCalls += 1;
      return config.route;
    } },
  });
  const actor = { principalId: "principal", actorId: "actor",
    tenantId: "tenant-1", spaceId: "space-1" };
  const command = { kind: "workflowRun.start" as const,
    idempotencyKey: "start-slice", workflowVersionId: workflow.workflowVersionId,
    threadId: "thread-1", input: {} };
  const freshStart = await starts.startWorkflowRun(actor, command);
  const idsAfterFresh = generatedIds;
  const replayStart = await starts.startWorkflowRun(actor, command);
  assert.deepEqual(replayStart, { ...freshStart,
    run: { ...freshStart.run, disposition: "replayed" } });
  assert.deepEqual({ routeCalls, generatedIds }, { routeCalls: 1,
    generatedIds: idsAfterFresh });
  const runId = freshStart.run.state.runId;
  runtime = await createStandaloneRuntimeWorker({ ...config,
    databasePath: path, scanIntervalMs: null, ownerId: "slice-worker",
    additionalAgentVersionRuntimes: ["agent-v1", "verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1",
        runtime: nodeRuntime(agentVersionId, samples) })),
  });
  const outcomes = [];
  for (let index = 0; index < 5; index += 1) {
    const outcome = await runtime.worker.wake();
    outcomes.push(outcome);
    if (outcome.kind === "completed") break;
  }
  const debugDatabase = new DatabaseSync(path);
  const workItems = debugDatabase.prepare(
    "SELECT status,work_item_json FROM work_items ORDER BY work_item_order",
  ).all();
  debugDatabase.close();
  assert.deepEqual(samples, new Map([["agent-v1", 1], ["verification-v1", 1]]),
    JSON.stringify({ outcomes, workItems }));
  const run = (await store.loadRun({ tenantId: "tenant-1", runId }))!;
  assert.equal(run.status, "completed");
  const events = await store.listRunEvents({ tenantId: "tenant-1", runId }, 0, 100);
  assert.equal(events[1]?.type, "run.started");
  assert.deepEqual(replayRunLifecycle(events), run);
  const secondStart = await starts.startWorkflowRun(actor, {
    ...command,
    idempotencyKey: "start-slice-again",
  });
  const secondOutcomes = [];
  for (let index = 0; index < 5; index += 1) {
    const outcome = await runtime.worker.wake();
    secondOutcomes.push(outcome);
    if (outcome.kind === "completed") break;
  }
  const secondRunId = secondStart.run.state.runId;
  assert.equal((await store.loadRun({ tenantId: "tenant-1", runId: secondRunId }))?.status,
    "completed", JSON.stringify(secondOutcomes));
  assert.deepEqual(samples,
    new Map([["agent-v1", 2], ["verification-v1", 2]]));
  const database = new DatabaseSync(path);
  assert.deepEqual(database.prepare(
    "SELECT status,count(*) count FROM run_attempts GROUP BY status",
  ).all().map((row) => ({ ...row })), [{ status: "completed", count: 4 }]);
  assert.equal(database.prepare(
    "SELECT count(DISTINCT work_item_id) count FROM run_attempts",
  ).get()!.count, 4);
  assert.equal(database.prepare(
    "SELECT count(*) count FROM model_dispatch_receipts WHERE status='terminal'",
  ).get()!.count, 4);
  assert.deepEqual(database.prepare(
    "SELECT run_id runId,step_id stepId FROM run_steps ORDER BY run_id,step_id",
  ).all().map((row) => ({ ...row })), [
    { runId, stepId: "agent" },
    { runId, stepId: "verification" },
    { runId: secondRunId, stepId: "agent" },
    { runId: secondRunId, stepId: "verification" },
  ].sort((left, right) => `${left.runId}:${left.stepId}`.localeCompare(
    `${right.runId}:${right.stepId}`)));
  database.close();
  await runtime.close();
  runtime = undefined;
});

test("SQLite Slice 2 preserves parallel sibling authority and frozen ordering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crewon-slice-two-"));
  const path = join(directory, "runtime.sqlite");
  const runtimes: Array<Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>> = [];
  t.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const versions = ["left-v1", "right-v1", "parallel-verification-v1"].map(agentVersion);
  const config = { ...baseConfig(), agentVersionDeployments: versions.map(
    (version) => ({ schemaVersion: "crewon.agent-version-deployment.v0" as const,
      tenantId: "tenant-1", agentVersionId: version.agentVersionId,
      contentDigest: version.contentDigest,
      materializationDigest: digester.sha256(`materialization:${version.agentVersionId}`),
      authorityId: `authority-${version.agentVersionId}`, workspaceBindingId: null })),
    agentVersionRuntimeFactory: { create: ({ version }: {
      version: { agentVersionId: string } }) => nodeRuntime(version.agentVersionId, new Map()) },
  };
  const setup = new SqliteRunStore(path, { workflowDigester: digester });
  for (const version of versions) await setup.registerAgentVersion(createAgentVersionAsset({
    tenantId: "tenant-1", version, createdAt: "2026-08-12T00:00:00.000Z" }));
  await activateStandaloneRuntimeAgentVersionRelease({ ...config, databasePath: path,
    actor: { principalId: "principal", actorId: "actor", tenantId: "tenant-1", spaceId: "space-1" },
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" }, activationId: "activate-slice-two" });
  await new ThreadApplicationService({ store: setup,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
    ids: { nextId: () => "parallel-thread" }, digester,
  }).createThread({ principalId: "principal", actorId: "actor", tenantId: "tenant-1", spaceId: "space-1" },
    { kind: "thread.create", idempotencyKey: "parallel-thread", title: "Parallel" });
  await setup.workflowVersionStore(digester).registerWorkflowVersion({
    schemaVersion: "crewon.workflow-version-asset.v0", tenantId: "tenant-1",
    workflowId: parallelWorkflow.workflowId, workflowVersionId: parallelWorkflow.workflowVersionId,
    contentDigest: parallelWorkflow.contentDigest,
    definitionJson: serializeCompiledWorkflowVersion(parallelWorkflow),
    createdAt: "2026-08-12T00:00:00.000Z" });
  let id = 0;
  const started = await new WorkflowRunApplicationService({ store: setup,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-12T00:00:01.000Z" }, workflowDigester: digester,
    ids: { nextId: (kind) => `${kind}-${++id}` },
    routeResolver: { resolveRoute: async () => config.route },
  }).startWorkflowRun({ principalId: "principal", actorId: "actor",
    tenantId: "tenant-1", spaceId: "space-1" }, {
    kind: "workflowRun.start", idempotencyKey: "parallel-start",
    workflowVersionId: parallelWorkflow.workflowVersionId,
    threadId: "parallel-thread", input: {} });
  const runId = started.run.state.runId;
  await setup.close();

  const samples = new Map<string, number>();
  const completionOrder: string[] = [];
  let releaseLeft!: () => void;
  const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve; });
  let releaseRight!: () => void;
  const rightGate = new Promise<void>((resolve) => { releaseRight = resolve; });
  const entered = new Set<string>();
  let bothEntered!: () => void;
  const bothEnteredGate = new Promise<void>((resolve) => { bothEntered = resolve; });
  const makeRuntime = async (ownerId: string) => {
    const runtime = await createStandaloneRuntimeWorker({ ...config, databasePath: path,
      scanIntervalMs: null, ownerId,
      additionalAgentVersionRuntimes: versions.map(({ agentVersionId }) => ({
        tenantId: "tenant-1", runtime: nodeRuntime(agentVersionId, samples,
          agentVersionId === "left-v1" ? leftGate : agentVersionId === "right-v1" ? rightGate : null,
          completionOrder, () => {
            entered.add(agentVersionId);
            if (entered.has("left-v1") && entered.has("right-v1")) bothEntered();
          }) })),
    });
    runtimes.push(runtime);
    return runtime;
  };
  const first = await makeRuntime("parallel-worker-1");
  const second = await makeRuntime("parallel-worker-2");
  await first.worker.wake();
  const afterFanout = inspectParallel(path, runId);
  assert.equal(afterFanout.schedulerAttempts, 0);
  assert.deepEqual(afterFanout.nodes.map((node) => node.nodeId), ["left", "right"]);
  assert.equal(new Set(afterFanout.nodes.map((node) => node.workItemId)).size, 2);
  assert.equal(new Set(afterFanout.nodes.map((node) => node.claimId)).size, 2);
  assert.deepEqual(afterFanout.nodes.map((node) => node.claimEpoch), [1, 1]);

  const leftWake = first.worker.wake();
  const rightWake = second.worker.wake();
  await bothEnteredGate;
  const concurrentlyRunning = inspectParallel(path, runId);
  assert.deepEqual(concurrentlyRunning.attempts.map(({ status }) => status),
    ["running", "running"]);
  assert.deepEqual(concurrentlyRunning.nodes.map(({ status }) => status),
    ["leased", "leased"]);
  assert.equal(new Set(concurrentlyRunning.nodes.map(({ leaseId }) => leaseId)).size, 2);
  assert.deepEqual(concurrentlyRunning.steps.map(({ status }) => status),
    ["running", "running"]);
  releaseRight();
  await rightWake;
  assert.deepEqual(completionOrder, ["right-v1"]);
  const rightCompleted = inspectParallel(path, runId);
  assert.deepEqual(rightCompleted.attempts.map(({ status }) => status),
    ["running", "completed"]);
  assert.equal(rightCompleted.verificationWorkItems, 0);
  releaseLeft();
  await leftWake;
  assert.deepEqual(completionOrder.slice(0, 2), ["right-v1", "left-v1"]);
  const afterSiblings = inspectParallel(path, runId);
  assert.equal(new Set(afterSiblings.attempts.map((attempt) => attempt.attemptId)).size, 2);
  assert.equal(new Set(afterSiblings.attempts.map((attempt) => attempt.workItemId)).size, 2);
  assert.equal(afterSiblings.verificationWorkItems, 0);
  assert.deepEqual(afterSiblings.outputNodeOrder, ["left", "right"]);
  await first.worker.wake();
  assert.equal(inspectParallel(path, runId).verificationWorkItems, 1);

  for (let wake = 0; wake < 3; wake += 1) {
    const outcome = await first.worker.wake();
    if (outcome.kind === "completed") break;
  }
  const final = inspectParallel(path, runId);
  assert.equal(final.runStatus, "completed");
  assert.equal(final.verificationInput, '{"left":{},"right":{}}');
  assert.deepEqual(samples, new Map([
    ["left-v1", 1], ["right-v1", 1], ["parallel-verification-v1", 1],
  ]));
  await Promise.all([first.worker.wake(), second.worker.wake()]);
  assert.deepEqual(samples, new Map([
    ["left-v1", 1], ["right-v1", 1], ["parallel-verification-v1", 1],
  ]));
});

function inspectParallel(path: string, runId: string) {
  const database = new DatabaseSync(path);
  try {
    const executionRow = database.prepare(
      "SELECT state_json FROM workflow_executions WHERE run_id=?").get(runId);
    const execution = executionRow === undefined ? { nodes: [] } :
      JSON.parse(executionRow.state_json as string);
    const nodeRows = database.prepare(`SELECT json_extract(work_item_json,'$.payload.nodeId') node_id,
      json_extract(work_item_json,'$.payload.claimId') claim_id,
      json_extract(work_item_json,'$.payload.claimEpoch') claim_epoch,work_item_id,status,lease_id
      FROM work_items WHERE run_id=? AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'
      AND json_extract(work_item_json,'$.payload.nodeId') IN ('left','right') ORDER BY node_id`).all(runId);
    return { schedulerAttempts: database.prepare(`SELECT count(*) count FROM run_attempts a
        JOIN work_items w ON w.work_item_id=a.work_item_id
        WHERE w.run_id=? AND json_extract(w.work_item_json,'$.payload.trigger')='workflowScheduler'`).get(runId)!.count,
      nodes: nodeRows.map((row) => ({ nodeId: row.node_id, claimId: row.claim_id,
        claimEpoch: row.claim_epoch, status: row.status, leaseId: row.lease_id,
        workItemId: row.work_item_id })), attempts: database.prepare(
        "SELECT attempt_id attemptId,work_item_id workItemId,status FROM run_attempts WHERE run_id=? AND step_id IN ('left','right') ORDER BY step_id").all(runId).map((row) => ({ ...row })),
      steps: database.prepare(
        "SELECT step_id stepId,status FROM run_steps WHERE run_id=? AND step_id IN ('left','right') ORDER BY step_id").all(runId).map((row) => ({ ...row })),
      verificationWorkItems: database.prepare(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND json_extract(work_item_json,'$.payload.nodeId')='verification'`).get(runId)!.count,
      outputNodeOrder: execution.nodes.filter((node: { nodeId: string }) =>
        node.nodeId === "left" || node.nodeId === "right").map((node: { nodeId: string }) => node.nodeId),
      verificationInput: database.prepare(`SELECT value_json FROM workflow_execution_values
        WHERE run_id=? AND role='nodeInput' AND node_id='verification'`).get(runId)?.value_json,
      runStatus: JSON.parse(database.prepare(
        "SELECT state_json FROM run_snapshots WHERE run_id=?").get(runId)!.state_json as string).status };
  } finally { database.close(); }
}

function baseConfig() {
  return { runtimeTenantId: "tenant-1", route: { authorityId: "authority",
    runtimeGeneration: "ts-v0", agentVersionId: "root-agent",
    policySnapshotId: "policy-1", workspaceBindingId: null },
    transport: { adapterName: "unused", adapterVersion: "1", modelId: "unused",
      async *stream() { yield { type: "completed" as const, checkpoint: null }; } },
    modelContextWindowTokens: 128_000, autoCompactAtTokens: null,
  } as const;
}

function nodeRuntime(agentVersionId: string, samples: Map<string, number>,
  gate: Promise<void> | null = null, completionOrder: string[] | null = null,
  onEntered: (() => void) | null = null) {
  const version = agentVersion(agentVersionId);
  return { version, policy: {} as never, toolRuntime: {
    definitions: () => [], executionPolicy: () => null,
    execute: async () => { throw new Error("tool forbidden"); },
    reconcile: async () => { throw new Error("tool forbidden"); } },
    kernel: { supportsModelDispatchEvidence: true,
      modelIdentity: { adapterName: "test", adapterVersion: "1", modelId: "model" },
      async *runSegment(contract: { runId: string; segmentId: string }, _signal: AbortSignal,
        options: { controlSink?: Record<string, (value: unknown) => Promise<void>> }) {
        onEntered?.();
        if (gate !== null) await gate;
        samples.set(agentVersionId, (samples.get(agentVersionId) ?? 0) + 1);
        const evidence = { operationId: `${contract.segmentId}:dispatch`, requestSequence: 1,
          operation: "dispatch", requestDigest: digester.sha256(agentVersionId),
          provider: { agentVersionId, adapterName: "test", adapterVersion: "1", modelId: "model" } };
        await options.controlSink?.modelRequestPrepared?.(evidence);
        await options.controlSink?.dispatchBoundaryCrossed?.(evidence);
        const base = { schemaVersion: "crewon.agent-event.v0", runId: contract.runId,
          segmentId: contract.segmentId } as const;
        yield { ...base, sequence: 1, type: "segment.started",
          data: { attempt: 1, model: "model" } };
        yield { ...base, sequence: 2, type: "segment.provider_response_created",
          data: { checkpoint: { schemaVersion: "crewon.provider-checkpoint.v0",
            adapterName: "test", adapterVersion: "1", modelId: "model",
            opaquePayload: { responseId: `${agentVersionId}-response` } } } };
        yield { ...base, sequence: 3, type: "model.output.delta", data: { delta: "{}" } };
        yield { ...base, sequence: 4, type: "segment.completed", data: { output: "{}" } };
        completionOrder?.push(agentVersionId);
      } },
  } as never;
}

function agentVersion(agentVersionId: string) {
  return compileAgentVersion({ schemaVersion: "crewon.agent-version-source.v0",
    agentVersionId, runtimeGeneration: "ts-v0", policySnapshotId: "policy-1",
    instructions: null, model: { adapterName: "test", adapterVersion: "1",
      modelId: "model", contextWindowTokens: 128_000, autoCompactAtTokens: null },
    execution: { streamMaxRetries: 1, maxToolRounds: 1 }, resources: {
      workspaceRequired: false, governedContextDigest: null }, tools: [],
  }, digester);
}
