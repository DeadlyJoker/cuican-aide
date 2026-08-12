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
  WORKFLOW_RUNTIME_CAPABILITIES,
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
test("certified standalone SQLite Slice 1 converges real shared Agent to Verification", async (t) => {
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
  let closes = 0;
  const versions = store.workflowVersionStore(digester);
  runtime = await createStandaloneRuntimeWorker({ ...config,
    databasePath: path, scanIntervalMs: null, ownerId: "slice-worker",
    additionalAgentVersionRuntimes: ["agent-v1", "verification-v1"].map(
      (agentVersionId) => ({ tenantId: "tenant-1",
        runtime: nodeRuntime(agentVersionId, samples) })),
    workflowComposition: { certification: {
      schemaVersion: "crewon.workflow-runtime-certification.v0",
      capabilities: WORKFLOW_RUNTIME_CAPABILITIES }, versions,
      store: store as never,
      async close() { closes += 1; await store.close(); } },
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
  const database = new DatabaseSync(path);
  assert.deepEqual(database.prepare(
    "SELECT status,count(*) count FROM run_attempts GROUP BY status",
  ).all().map((row) => ({ ...row })), [{ status: "completed", count: 2 }]);
  assert.equal(database.prepare(
    "SELECT count(DISTINCT work_item_id) count FROM run_attempts",
  ).get()!.count, 2);
  assert.equal(database.prepare(
    "SELECT count(*) count FROM model_dispatch_receipts WHERE status='terminal'",
  ).get()!.count, 2);
  database.close();
  await runtime.close();
  runtime = undefined;
  assert.equal(closes, 1);
});

function baseConfig() {
  return { runtimeTenantId: "tenant-1", route: { authorityId: "authority",
    runtimeGeneration: "ts-v0", agentVersionId: "root-agent",
    policySnapshotId: "policy-1", workspaceBindingId: null },
    transport: { adapterName: "unused", adapterVersion: "1", modelId: "unused",
      async *stream() { yield { type: "completed" as const, checkpoint: null }; } },
    modelContextWindowTokens: 128_000, autoCompactAtTokens: null,
  } as const;
}

function nodeRuntime(agentVersionId: string, samples: Map<string, number>) {
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
