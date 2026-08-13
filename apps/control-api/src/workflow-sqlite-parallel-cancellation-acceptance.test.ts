import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ModelTransportPort } from "@crewon/agent-kernel";
import { compileAgentVersion } from "@crewon/agent-version";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { ControlApiClient } from "@crewon/control-client";
import {
  activateStandaloneRuntimeAgentVersionRelease,
  ConfiguredAgentVersionRuntimeFactory,
  createStandaloneRuntimeWorker,
  type RuntimeWorkerCompositionConfig,
} from "@crewon/runtime-worker";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import type { FastifyInstance } from "fastify";

import {
  createStandaloneControlApi,
  type StandaloneControlApiConfig,
} from "./standalone-composition.ts";

const SESSION_TOKEN = "workflow-cancel-session-token-000001";
const CSRF_TOKEN = "workflow-cancel-csrf-token-0000001";
const ORIGIN = "http://127.0.0.1:5175";
const ACTOR = {
  principalId: "workflow-cancel-principal",
  actorId: "workflow-cancel-actor",
  tenantId: "workflow-cancel-tenant",
  spaceId: "workflow-cancel-space",
} as const;
const ROUTE = {
  authorityId: "workflow-cancel-authority",
  runtimeGeneration: "ts-v0",
  agentVersionId: "workflow-cancel-agent-v1",
  policySnapshotId: "workflow-cancel-policy-v1",
  workspaceBindingId: null,
} as const;
const EMPTY_SCHEMA = {
  type: "object" as const,
  properties: {},
  required: [],
  additionalProperties: false as const,
};
const DIGESTER = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

test("SQLite Control and parallel RuntimeWorkers cancel a frozen Workflow after simulated lease loss", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "crewon-workflow-parallel-cancel-"),
  );
  const databasePath = join(directory, "runtime.sqlite");
  const runtimes: Array<
    Awaited<ReturnType<typeof createStandaloneRuntimeWorker>>
  > = [];
  context.after(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.close()));
    await rm(directory, { recursive: true, force: true });
  });

  let modelDispatches = 0;
  const transport = (): ModelTransportPort => ({
    adapterName: "parallel-cancel-test",
    adapterVersion: "1",
    modelId: "parallel-cancel-model",
    supportsModelDispatchEvidence: true,
    async *stream(_request, _signal, options) {
      modelDispatches += 1;
      if (options?.dispatchEvidence !== undefined) {
        await options.controlSink?.dispatchBoundaryCrossed?.(
          options.dispatchEvidence,
        );
      }
      const checkpoint = {
        schemaVersion: "crewon.provider-checkpoint.v0" as const,
        adapterName: "parallel-cancel-test",
        adapterVersion: "1",
        modelId: "parallel-cancel-model",
        opaquePayload: { responseId: randomUUID() },
      };
      yield { type: "response.created" as const, checkpoint };
      yield { type: "output.delta" as const, delta: "{}" };
      yield { type: "completed" as const, checkpoint };
    },
  });
  const baseRuntimeConfig = (): RuntimeWorkerCompositionConfig => ({
    runtimeTenantId: ACTOR.tenantId,
    route: ROUTE,
    transport: transport(),
    modelContextWindowTokens: 128_000,
    autoCompactAtTokens: null,
    scanIntervalMs: null,
    retryAfterMs: 60_000,
  });
  await activateStandaloneRuntimeAgentVersionRelease({
    ...baseRuntimeConfig(),
    databasePath,
    actor: ACTOR,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-13T00:00:00.000Z" },
    activationId: "parallel-cancel-activation",
  });

  const controlConfig: StandaloneControlApiConfig = {
    databasePath,
    actor: ACTOR,
    defaultAgentVersionId: ROUTE.agentVersionId,
    sessionToken: SESSION_TOKEN,
    csrfToken: CSRF_TOKEN,
    allowedOrigins: [ORIGIN],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "parallel-cancel-artifact-key",
  };
  const control = createStandaloneControlApi(controlConfig);
  context.after(() => closeIfListening(control.app));
  await control.app.listen({ host: "127.0.0.1", port: 0 });
  const client = new ControlApiClient({
    baseUrl: serverBaseUrl(control.app),
    accessToken: SESSION_TOKEN,
    csrfToken: CSRF_TOKEN,
    origin: ORIGIN,
  });

  const thread = await client.createThread(
    { title: "Parallel cancellation" },
    "parallel-cancel-thread",
  );
  const verifierSource = agentVersionSource("workflow-cancel-verifier-v1");
  const verifier = compileAgentVersion(verifierSource, DIGESTER);
  await client.publishAgentVersion(verifierSource);
  const runtimeFactory = new ConfiguredAgentVersionRuntimeFactory([
    {
      tenantId: ACTOR.tenantId,
      agentVersionId: verifier.agentVersionId,
      contentDigest: verifier.contentDigest,
      authorityId: "workflow-cancel-verifier-authority",
      workspaceBindingId: null,
      materializationDigest: DIGESTER.sha256("workflow-cancel-verifier"),
      createTransport: transport,
      createToolRuntime: () => new InMemoryToolBroker(),
    },
  ]);
  const runtimeConfig = (): RuntimeWorkerCompositionConfig => ({
    ...baseRuntimeConfig(),
    agentVersionRuntimeFactory: runtimeFactory,
    agentVersionDeployments: runtimeFactory.deploymentBindings(ACTOR.tenantId),
  });
  await activateStandaloneRuntimeAgentVersionRelease({
    ...runtimeConfig(),
    databasePath,
    actor: ACTOR,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: { now: () => "2026-08-13T00:00:01.000Z" },
    activationId: "parallel-cancel-verifier-activation",
  });
  const published = await client.publishWorkflowVersion(workflowSource());
  assert.equal(published.disposition, "registered");
  const startInput = {
    workflowVersionId: "parallel-cancel-workflow-v1",
    threadId: thread.thread.threadId,
    input: {},
  };
  const started = await client.startWorkflowRun(
    startInput,
    "parallel-cancel-start",
  );
  const replayedStart = await client.startWorkflowRun(
    startInput,
    "parallel-cancel-start",
  );
  assert.deepEqual(replayedStart, { ...started, disposition: "replayed" });
  assert.deepEqual(started.run.workflowVersionBinding, {
    workflowId: published.workflowVersion.workflowId,
    workflowVersionId: published.workflowVersion.workflowVersionId,
    contentDigest: published.workflowVersion.contentDigest,
  });
  const runId = started.run.runId;

  const openWorker = async (
    ownerId: string,
    afterWorkflowTerminalCandidateCommitted?: () => Promise<void>,
  ) => {
    const runtime = await createStandaloneRuntimeWorker({
      ...runtimeConfig(),
      databasePath,
      ownerId,
      afterWorkflowTerminalCandidateCommitted,
    });
    runtimes.push(runtime);
    return runtime;
  };
  const scheduler = await openWorker("parallel-cancel-scheduler");
  assert.deepEqual(await scheduler.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_fanout_committed",
  });
  await scheduler.close();
  assert.deepEqual(
    inspect(databasePath, runId).nodeWork.map(
      ({ nodeId, claimEpoch, status, leaseEpoch }) => ({
        nodeId,
        claimEpoch,
        status,
        leaseEpoch,
      }),
    ),
    [
      { nodeId: "left", claimEpoch: 1, status: "pending", leaseEpoch: 0 },
      { nodeId: "right", claimEpoch: 1, status: "pending", leaseEpoch: 0 },
    ],
  );

  const boundary = twoLaneBoundary();
  const firstLane = await openWorker(
    "parallel-cancel-lane-1",
    boundary.afterCommitted,
  );
  const secondLane = await openWorker(
    "parallel-cancel-lane-2",
    boundary.afterCommitted,
  );
  const firstWake = firstLane.worker.wake();
  await boundary.firstCommitted;
  const secondWake = secondLane.worker.wake();
  await boundary.bothCommitted;

  const beforeCancel = inspect(databasePath, runId);
  assert.equal(
    new Set(beforeCancel.nodeWork.map(({ workItemId }) => workItemId)).size,
    2,
  );
  assert.equal(
    new Set(beforeCancel.nodeWork.map(({ claimId }) => claimId)).size,
    2,
  );
  assert.equal(
    new Set(beforeCancel.nodeWork.map(({ leaseId }) => leaseId)).size,
    2,
  );
  assert.deepEqual(
    beforeCancel.nodeWork.map(({ status }) => status),
    ["leased", "leased"],
  );
  assert.deepEqual(
    beforeCancel.nodeWork.map(({ leaseEpoch }) => leaseEpoch),
    [1, 1],
  );
  assert.deepEqual(
    beforeCancel.attempts.map(({ status }) => status),
    ["running", "running"],
  );
  assert.deepEqual(
    beforeCancel.dispatches.map(({ status }) => status),
    ["responseObserved", "responseObserved"],
  );
  assert.equal(beforeCancel.terminalCandidates.length, 2);
  assert.equal(
    new Set(
      beforeCancel.terminalCandidates.map(({ candidateId }) => candidateId),
    ).size,
    2,
  );
  assert.equal(modelDispatches, 2);

  const current = (await client.getRun(runId)).run;
  const requested = await client.cancelRun(
    runId,
    { expectedRevision: current.revision },
    "parallel-cancel-request",
  );
  const replayedCancel = await client.cancelRun(
    runId,
    { expectedRevision: current.revision },
    "parallel-cancel-request",
  );
  assert.equal(requested.run.cancelRequested, true);
  assert.deepEqual(replayedCancel, { ...requested, disposition: "replayed" });

  const coordinator = await openWorker("parallel-cancel-coordinator");
  assert.deepEqual(await coordinator.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_cancellation_retry_required",
  });
  const afterCoordinator = inspect(databasePath, runId);
  assert.deepEqual(afterCoordinator.attempts, beforeCancel.attempts);
  assert.deepEqual(afterCoordinator.dispatches, beforeCancel.dispatches);
  assert.deepEqual(
    afterCoordinator.nodeWork.map(
      ({ workItemId, leaseId, leaseEpoch, status }) => ({
        workItemId,
        leaseId,
        leaseEpoch,
        status,
      }),
    ),
    beforeCancel.nodeWork.map(
      ({ workItemId, leaseId, leaseEpoch, status }) => ({
        workItemId,
        leaseId,
        leaseEpoch,
        status,
      }),
    ),
  );
  assert.deepEqual(afterCoordinator.coordinatorWork, [
    {
      status: "pending",
      leaseEpoch: 1,
      lastErrorCode: "workflow_cancellation_retry_required",
    },
  ]);

  // This is a two-Store/two-Worker crash-window simulation, not a SIGKILL:
  // durable lease expiry fences both paused workers before fresh processes reopen SQLite.
  expireLeasedNodeWork(databasePath, runId);
  boundary.release();
  await Promise.all([firstWake, secondWake]);
  await Promise.all([firstLane.close(), secondLane.close()]);
  const expired = inspect(databasePath, runId);
  assert.deepEqual(
    expired.nodeWork.map(({ leaseEpoch }) => leaseEpoch),
    [1, 1],
  );
  assert.equal(modelDispatches, 2);

  const recoveryOne = await openWorker("parallel-cancel-recovery-1");
  const recoveryTwo = await openWorker("parallel-cancel-recovery-2");
  assert.deepEqual(await recoveryOne.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_cancellation_reconcile_required",
  });
  const afterFirstRecovery = inspect(databasePath, runId);
  assert.deepEqual(
    afterFirstRecovery.nodeWork.map(({ leaseEpoch }) => leaseEpoch),
    [2, 1],
  );
  assert.deepEqual(
    afterFirstRecovery.nodeWork.map(({ status }) => status),
    ["completed", "leased"],
  );
  assert.deepEqual(
    afterFirstRecovery.attempts.map(({ status }) => status),
    ["running", "running"],
  );
  assert.equal(afterFirstRecovery.reconciliationWork.length, 1);
  assert.equal(afterFirstRecovery.reconciliationWork[0]?.nodeId, "left");
  assert.equal(modelDispatches, 2);

  assert.deepEqual(await recoveryTwo.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_cancellation_reconcile_required",
  });
  const afterSecondRecovery = inspect(databasePath, runId);
  assert.deepEqual(
    afterSecondRecovery.nodeWork.map(({ leaseEpoch }) => leaseEpoch),
    [2, 2],
  );
  assert.deepEqual(
    afterSecondRecovery.nodeWork.map(({ status }) => status),
    ["completed", "completed"],
  );
  assert.deepEqual(
    afterSecondRecovery.attempts.map(({ status }) => status),
    ["running", "running"],
  );
  assert.equal(afterSecondRecovery.reconciliationWork.length, 2);
  assert.deepEqual(
    afterSecondRecovery.reconciliationWork.map(({ nodeId }) => nodeId),
    ["left", "right"],
  );
  assert.equal(
    new Set(
      afterSecondRecovery.reconciliationWork.map(
        ({ reconciliationOperationId }) => reconciliationOperationId,
      ),
    ).size,
    2,
  );
  assert.equal(modelDispatches, 2);

  const reconcilerOne = await openWorker("parallel-cancel-reconciler-1");
  const reconcilerTwo = await openWorker("parallel-cancel-reconciler-2");
  assert.deepEqual(await reconcilerOne.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_reconciliation_settled",
  });
  assert.deepEqual(await reconcilerTwo.worker.wake(), {
    kind: "workflowRecovery",
    runId,
    code: "workflow_reconciliation_settled",
  });
  makeCoordinatorAvailable(databasePath, runId);
  const finalCoordinator = await openWorker(
    "parallel-cancel-final-coordinator",
  );
  assert.deepEqual(await finalCoordinator.worker.wake(), {
    kind: "completed",
    runId,
  });
  await control.outboxDispatcher.wake();

  const final = (await client.getRun(runId)).run;
  assert.equal(final.status, "canceled");
  assert.equal(final.cancelRequested, true);
  const eventResponse = await client.openRunEventStream({
    runId,
    afterSequence: 0,
    view: "audit",
  });
  const events = await eventResponse.text();
  assert.equal(eventCount(events, "run.cancel.requested"), 1);
  assert.equal(eventCount(events, "run.canceled"), 1);

  const durable = inspect(databasePath, runId);
  assert.equal(durable.verificationAttemptCount, 0);
  assert.equal(durable.liveAttemptCount, 0);
  assert.equal(durable.activeWorkCount, 0);
  assert.equal(durable.pendingCoordinatorCount, 0);
  assert.equal(modelDispatches, 2);
  assert.deepEqual(await finalCoordinator.worker.wake(), { kind: "idle" });
  assert.equal(modelDispatches, 2);
});

function workflowSource() {
  return {
    schemaVersion: "crewon.workflow-version-source.v0" as const,
    workflowId: "parallel-cancel-workflow",
    workflowVersionId: "parallel-cancel-workflow-v1",
    name: "Parallel cancellation",
    description: "Durable parallel cancellation acceptance",
    inputSchema: EMPTY_SCHEMA,
    outputSchema: EMPTY_SCHEMA,
    entryNodeIds: ["left", "right"],
    outputNodeIds: ["verification"],
    nodes: [
      {
        nodeId: "left",
        title: "Left",
        instruction: "Return empty JSON.",
        kind: "agent" as const,
        agentVersionId: ROUTE.agentVersionId,
        dependsOn: [],
        inputSchema: EMPTY_SCHEMA,
        outputSchema: EMPTY_SCHEMA,
      },
      {
        nodeId: "right",
        title: "Right",
        instruction: "Return empty JSON.",
        kind: "agent" as const,
        agentVersionId: ROUTE.agentVersionId,
        dependsOn: [],
        inputSchema: EMPTY_SCHEMA,
        outputSchema: EMPTY_SCHEMA,
      },
      {
        nodeId: "verification",
        title: "Verification",
        instruction: "Verify both results.",
        kind: "verification" as const,
        verifierAgentVersionId: "workflow-cancel-verifier-v1",
        dependsOn: ["left", "right"],
        inputSchema: {
          type: "object" as const,
          properties: { left: EMPTY_SCHEMA, right: EMPTY_SCHEMA },
          required: ["left", "right"],
          additionalProperties: false as const,
        },
        outputSchema: EMPTY_SCHEMA,
      },
    ],
  };
}

function agentVersionSource(agentVersionId: string) {
  return {
    schemaVersion: "crewon.agent-version-source.v0" as const,
    agentVersionId,
    runtimeGeneration: "ts-v0",
    policySnapshotId: ROUTE.policySnapshotId,
    instructions: "Verify empty JSON.",
    model: {
      adapterName: "parallel-cancel-test",
      adapterVersion: "1",
      modelId: "parallel-cancel-model",
      contextWindowTokens: 128_000,
      autoCompactAtTokens: null,
    },
    execution: { streamMaxRetries: 1, maxToolRounds: 1 },
    resources: { workspaceRequired: false, governedContextDigest: null },
    tools: [],
  };
}

function inspect(databasePath: string, runId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    const rows = (sql: string) =>
      database
        .prepare(sql)
        .all(runId)
        .map((row) => ({ ...row }));
    const count = (sql: string) =>
      Number(database.prepare(sql).get(runId)?.count ?? 0);
    return {
      nodeWork: rows(`SELECT
        json_extract(work_item_json,'$.payload.nodeId') nodeId,
        json_extract(work_item_json,'$.payload.claimId') claimId,
        json_extract(work_item_json,'$.payload.claimEpoch') claimEpoch,
        work_item_id workItemId,status,lease_id leaseId,lease_epoch leaseEpoch
        FROM work_items WHERE run_id=?
        AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'
        ORDER BY nodeId`),
      attempts:
        rows(`SELECT step_id stepId,attempt_id attemptId,work_item_id workItemId,status
        FROM run_attempts WHERE run_id=? AND step_id IN ('left','right') ORDER BY stepId`),
      dispatches:
        rows(`SELECT step_id stepId,attempt_id attemptId,operation_id operationId,status
        FROM model_dispatch_receipts WHERE run_id=? ORDER BY stepId`),
      terminalCandidates: rows(`SELECT step_id stepId,
        json_extract(checkpoint_json,'$.terminalCandidate.candidateId') candidateId
        FROM workflow_node_continuations WHERE run_id=? ORDER BY stepId`),
      coordinatorWork:
        rows(`SELECT status,lease_epoch leaseEpoch,last_error_code lastErrorCode
        FROM work_items WHERE run_id=?
        AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel'`),
      reconciliationWork: rows(`SELECT
        json_extract(work_item_json,'$.payload.nodeId') nodeId,
        json_extract(work_item_json,'$.payload.reconciliationOperationId') reconciliationOperationId,
        work_item_id workItemId,status,lease_epoch leaseEpoch
        FROM work_items WHERE run_id=?
        AND json_extract(work_item_json,'$.payload.trigger')='workflowReconcile'
        ORDER BY nodeId`),
      verificationAttemptCount: count(`SELECT count(*) count FROM run_attempts
        WHERE run_id=? AND step_id='verification'`),
      liveAttemptCount: count(`SELECT count(*) count FROM run_attempts
        WHERE run_id=? AND status IN ('running','reconciling')`),
      activeWorkCount: count(`SELECT count(*) count FROM work_items
        WHERE run_id=? AND status IN ('pending','leased')`),
      pendingCoordinatorCount:
        count(`SELECT count(*) count FROM work_items WHERE run_id=?
        AND status IN ('pending','leased')
        AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel'`),
    };
  } finally {
    database.close();
  }
}

function twoLaneBoundary() {
  let committed = 0;
  let markFirstCommitted!: () => void;
  let markBothCommitted!: () => void;
  let release!: () => void;
  const firstCommitted = new Promise<void>((resolve) => {
    markFirstCommitted = resolve;
  });
  const bothCommitted = new Promise<void>((resolve) => {
    markBothCommitted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    firstCommitted,
    bothCommitted,
    release,
    afterCommitted: async () => {
      committed += 1;
      if (committed === 1) markFirstCommitted();
      if (committed === 2) markBothCommitted();
      await held;
    },
  };
}

function expireLeasedNodeWork(databasePath: string, runId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database
      .prepare(
        `UPDATE work_items SET lease_expires_at_ms=0 WHERE run_id=? AND status='leased'
        AND json_extract(work_item_json,'$.payload.trigger')='workflowNode'`,
      )
      .run(runId);
    assert.equal(result.changes, 2);
  } finally {
    database.close();
  }
}

function makeCoordinatorAvailable(databasePath: string, runId: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database
      .prepare(
        `UPDATE work_items SET available_at_ms=0 WHERE run_id=? AND status='pending'
        AND json_extract(work_item_json,'$.payload.trigger')='workflowCancel'`,
      )
      .run(runId);
    assert.equal(result.changes, 1);
  } finally {
    database.close();
  }
}

function eventCount(events: string, type: string): number {
  return events.match(new RegExp(`^event: ${type}$`, "gmu"))?.length ?? 0;
}

function serverBaseUrl(app: FastifyInstance): string {
  const address = app.server.address();
  assert.ok(address !== null && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function closeIfListening(app: FastifyInstance): Promise<void> {
  if (app.server.listening) await app.close();
}
