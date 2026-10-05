import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
  CrewONAgentKernel,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  RunExecutionService,
  ThreadApplicationService,
  TurnApplicationService,
  type ActorContext,
  type RunRoute,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import { createStandaloneControlApi } from "../../control-api/src/standalone-composition.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

type WorkerDependencies = ConstructorParameters<typeof RuntimeWorker>[0];

/** Actual ordinary Turn/Kernel/SQLite fixture; only identity policy and model transport are named ports. */
export async function ordinaryProjectPlanningFixture(
  t: TestContext,
  input: Readonly<{
    transport: ModelTransportPort;
    configureWorker?(dependencies: WorkerDependencies): WorkerDependencies;
  }>,
) {
  const root = await mkdtemp(join(tmpdir(), "crewon-project-planning-chat-"));
  await chmod(root, 0o700);
  const path = join(root, "runtime.sqlite");
  const actor: ActorContext = Object.freeze({
    tenantId: "planning-tenant",
    spaceId: "planning-space",
    principalId: "planning-principal",
    actorId: "planning-actor",
  });
  const route: RunRoute = Object.freeze({
    authorityId: "planning-kernel",
    runtimeGeneration: "planning-runtime-1",
    agentVersionId: "planning-agent-1",
    policySnapshotId: "planning-policy-1",
    workspaceBindingId: null,
  });
  const clock = { now: () => new Date().toISOString() };
  let nextId = 0;
  const ids = { nextId: (kind: string) => `${kind}-${++nextId}` };
  const digester = {
    sha256: (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`,
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  let store = new SqliteRunStore(path),
    worker: RuntimeWorker | null = null,
    control: ReturnType<typeof createStandaloneControlApi> | null = null;
  await chmod(path, 0o600);
  t.after(async () => {
    try {
      await worker?.close();
      await control?.app.close();
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const threads = new ThreadApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  });
  const created = await threads.createThread(actor, {
    kind: "thread.create",
    title: null,
    workspaceId: null,
    idempotencyKey: "planning-chat-thread",
  });
  const turn = await new TurnApplicationService({
    store,
    authorization,
    clock,
    ids,
    digester,
  }).startTurn(actor, {
    kind: "turn.start",
    threadId: created.state.threadId,
    expectedThreadRevision: created.state.revision,
    content: "把雨夜收到的一封旧信发展成两集短剧，先提出创作计划。",
    requestedAgentVersionId: route.agentVersionId,
    executionIntent: "none",
    toolPermissionMode: "requestApproval",
    idempotencyKey: "planning-chat-turn",
    route,
  });
  assert.equal(turn.runState.origin, null);
  assert.equal(turn.runState.workspaceBindingId, null);
  const locator = {
    tenantId: actor.tenantId,
    runId: turn.runState.runId,
  };
  function openWorker() {
    assert.equal(worker, null);
    const execution = new RunExecutionService({ store, clock, ids, digester });
    const dependencies: WorkerDependencies = {
      store,
      execution,
      kernel: new CrewONAgentKernel({
        transport: input.transport,
        streamMaxRetries: 0,
      }),
      policy: new PinnedRunExecutionPolicy(route),
    };
    worker = new RuntimeWorker(
      input.configureWorker?.(dependencies) ?? dependencies,
      {
        ownerId: `planning-worker-${++nextId}`,
        nextLeaseId: () => `planning-lease-${++nextId}`,
        leaseDurationMs: 10000,
        retryAfterMs: 0,
        scanIntervalMs: null,
      },
    );
    return worker;
  }
  return {
    actor,
    route,
    path,
    runId: locator.runId,
    threadId: created.state.threadId,
    openWorker,
    store: () => store,
    events: (afterSequence = 0) =>
      store.listRunEvents(locator, afterSequence, 1000),
    history: () =>
      store.listModelHistoryItems(
        { tenantId: actor.tenantId, threadId: created.state.threadId },
        0,
        1000,
      ),
    listenControl: async () => {
      assert.equal(control, null);
      const sessionToken = "planning-read-session-32-byte-fixture",
        origin = "http://127.0.0.1:5175";
      control = createStandaloneControlApi({
        databasePath: path,
        actor,
        defaultAgentVersionId: route.agentVersionId,
        sessionToken,
        csrfToken: "planning-csrf-token-32-byte-fixture",
        allowedOrigins: [origin],
        artifactStore: new InMemoryArtifactStore(),
        artifactEncryptionKeyId: "planning-artifact-key",
        heartbeatIntervalMs: null,
        outboxScanIntervalMs: null,
        automationScanIntervalMs: null,
      });
      await control.app.listen({ host: "127.0.0.1", port: 0 });
      const address = control.app.server.address();
      assert.ok(address && typeof address === "object");
      return {
        origin: `http://127.0.0.1:${address.port}`,
        headers: { authorization: `Bearer ${sessionToken}`, origin },
      };
    },
    reopen: async () => {
      await worker?.close();
      worker = null;
      await control?.app.close();
      control = null;
      await store.close();
      store = new SqliteRunStore(path);
    },
  };
}
