import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { ModelRequest, ModelTransportPort } from "@crewon/agent-kernel";
import {
  RunApplicationService,
  StorageAdmissionError,
  ThreadApplicationService,
  ThreadCompactionApplicationService,
  type StorageAdmissionPort,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import {
  createStandaloneRuntimeWorker,
  type StandaloneRuntimeWorker,
} from "./standalone-composition.ts";

class CapacityGate implements StorageAdmissionPort {
  blocked = false;
  async assertNewWorkAllowed(): Promise<void> {
    if (this.blocked) throw new StorageAdmissionError("storage_capacity_low");
  }
}

test("production Worker defers pressure without starting model attempts and streams after reopen", async (context) => {
  const fixture = await createFixture(context);
  fixture.gate.blocked = true;
  for (let index = 0; index < 10; index += 1) {
    fixture.makeDue();
    assert.deepEqual(await fixture.runtime().worker.wake(), {
      kind: "retried",
      runId: fixture.runId,
      code: "storage_capacity_low",
    });
  }
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.attemptCount(), 0);
  assert.equal(
    (await fixture.events()).filter((event) => event.type === "run.started")
      .length,
    1,
  );
  await fixture.reopen();
  fixture.gate.blocked = false;
  fixture.makeDue();
  assert.equal((await fixture.runtime().worker.wake()).kind, "completed");
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]?.instructions, "stable instructions");
  assert.equal(fixture.attemptCount(), 1);
  const events = await fixture.events();
  const output = events.filter((event) => event.type === "model.output.delta");
  assert.equal(output.length, 2);
  assert.equal(
    events.some((event) => event.type === "run.failed"),
    false,
  );
  const cursor = output[0]?.sequence;
  assert.ok(cursor !== undefined);
  assert.deepEqual(
    await fixture.store.listRunEvents(
      { tenantId: fixture.actor.tenantId, runId: fixture.runId },
      cursor,
      100,
    ),
    events.filter((event) => event.sequence > cursor),
  );
});

for (const pauseAt of ["beforeSecondTool", "beforeContinuation"] as const) {
  test(`pressure ${pauseAt} resumes once with the same tools and model input`, async (context) => {
    const baseline = await createFixture(context, { toolCount: 2 });
    assert.equal((await baseline.runtime().worker.wake()).kind, "completed");
    const paused = await createFixture(context, { toolCount: 2, pauseAt });
    assert.equal((await paused.runtime().worker.wake()).kind, "retried");
    assert.equal(paused.requests.length, 1);
    assert.deepEqual(
      paused.receiptStatuses(),
      pauseAt === "beforeSecondTool"
        ? ["completed", "prepared"]
        : ["completed", "completed"],
    );
    assert.deepEqual(
      paused.executions,
      pauseAt === "beforeSecondTool" ? ["call-1"] : ["call-1", "call-2"],
    );
    const attemptsBeforeRetry = paused.attemptCount();
    for (let index = 0; index < 10; index += 1) {
      paused.makeDue();
      assert.equal((await paused.runtime().worker.wake()).kind, "retried");
    }
    assert.equal(
      paused.attemptCount(),
      attemptsBeforeRetry,
      "pressure retries must not append unused tool/model attempts",
    );
    await paused.reopen();
    paused.gate.blocked = false;
    paused.makeDue();
    assert.equal((await paused.runtime().worker.wake()).kind, "completed");
    assert.deepEqual(paused.executions, ["call-1", "call-2"]);
    assert.deepEqual(paused.receiptStatuses(), ["completed", "completed"]);
    assert.equal(paused.requests.length, 2);
    // The committed tool sample now permits the same incremental continuation
    // in normal execution and after a pressure pause or Worker restart.
    assert.equal(paused.requests[1]?.input.strategy, "providerCheckpoint");
    // Run/segment identities are per execution. All actual model input and the
    // immutable prefix must remain byte-for-byte equal to uninterrupted work.
    const modelBodies = (requests: ModelRequest[]) =>
      requests.map(({ runId: _runId, segmentId: _segmentId, ...body }) => body);
    assert.equal(
      JSON.stringify(modelBodies(paused.requests)),
      JSON.stringify(modelBodies(baseline.requests)),
    );
    assert.equal(paused.modelAttemptCount(), baseline.modelAttemptCount());
    const beforeReplay = await paused.events();
    paused.makeDue();
    assert.equal((await paused.runtime().worker.wake()).kind, "idle");
    assert.deepEqual(await paused.events(), beforeReplay);
  });
}

test("canceling a pressure-deferred Run does not require space recovery or call the model", async (context) => {
  const fixture = await createFixture(context);
  fixture.gate.blocked = true;
  assert.equal((await fixture.runtime().worker.wake()).kind, "retried");
  const run = await fixture.store.loadRun({
    tenantId: fixture.actor.tenantId,
    runId: fixture.runId,
  });
  assert.ok(run !== null);
  await fixture.runs.transitionRun(fixture.actor, {
    kind: "run.requestCancel",
    runId: fixture.runId,
    idempotencyKey: "cancel",
    expectedRevision: run.revision,
  });
  await fixture.reopen();
  fixture.makeDue();
  assert.equal((await fixture.runtime().worker.wake()).kind, "canceled");
  assert.equal(fixture.requests.length, 0);
  assert.equal(
    (
      await fixture.store.loadRun({
        tenantId: fixture.actor.tenantId,
        runId: fixture.runId,
      })
    )?.status,
    "canceled",
  );
});

test("pressure before a later user turn preserves the durable provider continuation after restart", async (context) => {
  const fixture = await createFixture(context);
  assert.equal((await fixture.runtime().worker.wake()).kind, "completed");
  const nextRunId = await fixture.startNextTurn();
  fixture.gate.blocked = true;
  assert.equal((await fixture.runtime().worker.wake()).kind, "retried");
  assert.equal(fixture.requests.length, 1);
  await fixture.reopen();
  fixture.gate.blocked = false;
  fixture.makeDue(nextRunId);
  assert.equal((await fixture.runtime().worker.wake()).kind, "completed");
  assert.equal(fixture.requests.length, 2);
  const request = fixture.requests[1];
  assert.ok(request?.input.strategy === "providerCheckpoint");
  assert.deepEqual(request.input.checkpoint.opaquePayload, {
    responseId: "response-completed",
  });
  assert.deepEqual(
    request.input.items.slice(request.input.newHistoryStartIndex),
    [{ type: "message", role: "user", content: "follow up" }],
  );
  assert.equal(request.instructions, fixture.requests[0]?.instructions);
  assert.deepEqual(request.tools, fixture.requests[0]?.tools);
});

test("manual compaction waits for storage without creating attempts or changing durable model history", async (context) => {
  const fixture = await createFixture(context);
  assert.equal((await fixture.runtime().worker.wake()).kind, "completed");
  const compactionRunId = await fixture.startCompaction();
  fixture.gate.blocked = true;
  for (let index = 0; index < 10; index += 1) {
    fixture.makeDue(compactionRunId);
    assert.equal((await fixture.runtime().worker.wake()).kind, "retried");
  }
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.attemptCount(compactionRunId), 0);
  await fixture.reopen();
  fixture.gate.blocked = false;
  fixture.makeDue(compactionRunId);
  assert.equal((await fixture.runtime().worker.wake()).kind, "completed");
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.attemptCount(compactionRunId), 1);
  assert.equal(
    (
      await fixture.store.listRunEvents(
        { tenantId: fixture.actor.tenantId, runId: compactionRunId },
        0,
        100,
      )
    ).filter((event) => event.type === "context.compacted").length,
    1,
  );
});

async function createFixture(
  context: TestContext,
  options: {
    toolCount?: number;
    pauseAt?: "beforeSecondTool" | "beforeContinuation";
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-storage-recovery-"));
  const databasePath = join(directory, "store.sqlite");
  let runtime: StandaloneRuntimeWorker | undefined;
  let database: DatabaseSync | undefined;
  let store: SqliteRunStore | undefined;
  context.after(async () => {
    await runtime?.close();
    database?.close();
    await store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const gate = new CapacityGate();
  const requests: ModelRequest[] = [];
  const executions: string[] = [];
  const toolCount = options.toolCount ?? 0;
  let pauseTriggered = false;
  const toolRuntime = new InMemoryToolBroker(
    toolCount === 0
      ? []
      : [
          {
            schemaVersion: "crewon.tool-definition.v0",
            kind: "function",
            name: "fixture_tool",
            description: "Fixture",
            execution: "serial",
            inputSchema: { type: "object" },
          },
        ],
    new Map([
      [
        "function:fixture_tool",
        async (invocation) => {
          executions.push(invocation.callId);
          if (options.pauseAt === "beforeSecondTool" && !pauseTriggered) {
            pauseTriggered = true;
            gate.blocked = true;
          }
          return { output: `result-${invocation.callId}` };
        },
      ],
    ]),
    toolCount === 0
      ? new Map()
      : new Map([
          [
            "function:fixture_tool",
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
                timeoutMs: 30_000,
                maxOutputBytes: 256 * 1024,
                maxArtifactBytes: 1024 * 1024,
              },
            },
          ],
        ]),
  );
  const transport: ModelTransportPort = {
    adapterName: "storage-fake",
    adapterVersion: "1",
    modelId: "fake-model",
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1 && toolCount > 0) {
        for (let index = 1; index <= toolCount; index += 1)
          yield {
            type: "tool.call",
            kind: "function",
            callId: `call-${index}`,
            name: "fixture_tool",
            input: "{}",
          };
        yield {
          type: "completed",
          checkpoint: {
            schemaVersion: "crewon.provider-checkpoint.v0",
            adapterName: "storage-fake",
            adapterVersion: "1",
            modelId: "fake-model",
            opaquePayload: { responseId: "response-first" },
          },
        };
      } else {
        yield { type: "output.delta", delta: "done" };
        yield { type: "output.delta", delta: "!" };
        yield {
          type: "usage",
          inputTokens: 2048,
          cachedInputTokens: 1024,
          outputTokens: 2,
          totalTokens: 2050,
        };
        yield {
          type: "completed",
          checkpoint: {
            schemaVersion: "crewon.provider-checkpoint.v0",
            adapterName: "storage-fake",
            adapterVersion: "1",
            modelId: "fake-model",
            opaquePayload: { responseId: "response-completed" },
          },
        };
      }
    },
  };
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const route = {
    authorityId: "standalone-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "agent-version-1",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const config = {
    databasePath,
    runtimeTenantId: actor.tenantId,
    route,
    transport,
    toolRuntime,
    storageAdmission: gate,
    agentInstructions: "stable instructions",
    streamMaxRetries: 0,
    scanIntervalMs: null,
    afterToolReceiptCommitted: async () => {
      if (options.pauseAt === "beforeContinuation" && !pauseTriggered) {
        pauseTriggered = true;
        gate.blocked = true;
      }
    },
  };
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    actor,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    clock: new SystemApplicationClock(),
    activationId: "activation-storage",
  });
  store = new SqliteRunStore(databasePath);
  const dependencies = {
    store,
    authorization: { authorize: async () => ({ outcome: "allow" as const }) },
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  };
  const threads = new ThreadApplicationService(dependencies);
  const runs = new RunApplicationService(dependencies);
  const thread = await threads.createThread(actor, {
    kind: "thread.create",
    idempotencyKey: "create-thread",
    title: null,
  });
  await threads.appendMessage(actor, {
    kind: "thread.message.append",
    idempotencyKey: "message",
    threadId: thread.state.threadId,
    expectedRevision: 1,
    role: "user",
    content: "hello",
  });
  const run = await runs.createRun(actor, {
    kind: "run.create",
    idempotencyKey: "create-run",
    threadId: thread.state.threadId,
    route,
    toolPermissionMode: "fullAccess",
  });
  const runId = run.state.runId;
  database = new DatabaseSync(databasePath);
  runtime = await createStandaloneRuntimeWorker(config);
  const databaseHandle = database;
  const storeHandle = store;
  return {
    actor,
    store: storeHandle,
    runs,
    runId,
    gate,
    requests,
    executions,
    runtime: () => {
      assert.ok(runtime !== undefined);
      return runtime;
    },
    reopen: async () => {
      await runtime?.close();
      runtime = await createStandaloneRuntimeWorker(config);
    },
    makeDue: (id = runId) =>
      databaseHandle
        .prepare(
          "UPDATE work_items SET available_at_ms = 0 WHERE run_id = ? AND status = 'pending'",
        )
        .run(id),
    startNextTurn: async () => {
      const state = await storeHandle.loadThread({
        tenantId: actor.tenantId,
        threadId: thread.state.threadId,
      });
      assert.ok(state !== null);
      await threads.appendMessage(actor, {
        kind: "thread.message.append",
        idempotencyKey: "next-message",
        threadId: state.threadId,
        expectedRevision: state.revision,
        role: "user",
        content: "follow up",
      });
      return (
        await runs.createRun(actor, {
          kind: "run.create",
          idempotencyKey: "next-run",
          threadId: state.threadId,
          route,
          toolPermissionMode: "fullAccess",
        })
      ).state.runId;
    },
    events: () =>
      storeHandle.listRunEvents({ tenantId: actor.tenantId, runId }, 0, 100),
    attemptCount: (id = runId) =>
      Number(
        databaseHandle
          .prepare(
            "SELECT count(*) AS count FROM run_attempts WHERE run_id = ?",
          )
          .get(id)?.count,
      ),
    startCompaction: async () => {
      const state = await storeHandle.loadThread({
        tenantId: actor.tenantId,
        threadId: thread.state.threadId,
      });
      assert.ok(state !== null);
      return (
        await new ThreadCompactionApplicationService(dependencies).start(
          actor,
          {
            kind: "thread.compact",
            idempotencyKey: "compact",
            threadId: state.threadId,
            expectedThreadRevision: state.revision,
            requestedAgentVersionId: route.agentVersionId,
            route,
          },
        )
      ).state.runId;
    },
    modelAttemptCount: () =>
      Number(
        databaseHandle
          .prepare(
            "SELECT count(*) AS count FROM run_attempts a JOIN run_steps s ON s.step_id = a.step_id WHERE a.run_id = ? AND s.kind = 'model'",
          )
          .get(runId)?.count,
      ),
    receiptStatuses: () =>
      databaseHandle
        .prepare(
          "SELECT status FROM tool_execution_receipts WHERE run_id = ? ORDER BY prepared_at, receipt_id",
        )
        .all(runId)
        .map((row) => row.status),
  };
}
