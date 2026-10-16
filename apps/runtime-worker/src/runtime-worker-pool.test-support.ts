import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { TestContext } from "node:test";
import {
  ModelTransportError,
  type ModelTransportPort,
} from "@crewon/agent-kernel";
import {
  RunApplicationService,
  ThreadApplicationService,
} from "@crewon/application";
import { SqliteRunStore } from "@crewon/store";
import { activateStandaloneRuntimeAgentVersionRelease } from "./agent-version-release-composition.ts";
import { createStandaloneRuntimeWorker } from "./standalone-composition.ts";
import {
  NodeSha256ContentDigester,
  SystemApplicationClock,
  UuidV7ApplicationIdGenerator,
} from "./standalone-adapters.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

export async function fixture(t: TestContext, scanIntervalMs = 20) {
  const directory = mkdtempSync(join(tmpdir(), "crewon-worker-pool-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "control.sqlite");
  const entered = new Map<string, AbortSignal>();
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  let active = 0,
    maximumActive = 0,
    closed = 0;
  const transport: ModelTransportPort = {
    adapterName: "pool-fixture",
    adapterVersion: "1",
    modelId: "local-fixture-model",
    async *stream(request, signal) {
      assert.equal(
        entered.has(request.runId),
        false,
        "duplicate model dispatch",
      );
      entered.set(request.runId, signal);
      const gate = deferred();
      gates.set(request.runId, gate);
      active++;
      maximumActive = Math.max(maximumActive, active);
      const abort = () =>
        gate.reject(
          new ModelTransportError({
            category: "canceled",
            code: "fixture_canceled",
            retryable: false,
          }),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        yield { type: "output.delta", delta: `answer:${request.runId}` };
        await gate.promise;
        yield { type: "completed", checkpoint: null };
      } finally {
        active--;
        signal.removeEventListener("abort", abort);
      }
    },
    async close() {
      assert.equal(active, 0);
      closed++;
    },
  };
  const route = {
    authorityId: "authority-1",
    runtimeGeneration: "ts-v0",
    agentVersionId: "pool-agent",
    policySnapshotId: "policy-1",
    workspaceBindingId: null,
  };
  const config = {
    runtimeTenantId: "tenant-1",
    route,
    transport,
    streamMaxRetries: 0,
    workerConcurrency: 2,
    scanIntervalMs,
    cancellationPollIntervalMs: 20,
  };
  const actor = {
    principalId: "principal-1",
    actorId: "actor-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
  };
  const authorization = {
    authorize: async () => ({ outcome: "allow" as const }),
  };
  await activateStandaloneRuntimeAgentVersionRelease({
    ...config,
    databasePath,
    actor,
    authorization,
    clock: new SystemApplicationClock(),
    activationId: "pool-release",
  });
  const runtime = await createStandaloneRuntimeWorker({
    ...config,
    databasePath,
  });
  t.after(() => runtime.close());
  assert.equal(runtime.workers.length, 2);
  assert.equal(runtime.worker, runtime.workers[0]);
  const store = new SqliteRunStore(databasePath);
  t.after(() => store.close());
  const dependencies = {
    store,
    authorization,
    clock: new SystemApplicationClock(),
    ids: new UuidV7ApplicationIdGenerator(),
    digester: new NodeSha256ContentDigester(),
  };
  const threads = new ThreadApplicationService(dependencies),
    runs = new RunApplicationService(dependencies);
  return {
    runtime,
    store,
    databasePath,
    actor,
    runs,
    entered,
    active: () => active,
    maximumActive: () => maximumActive,
    closed: () => closed,
    load: (runId: string) => store.loadRun({ tenantId: actor.tenantId, runId }),
    release: (runId: string) => {
      assert.ok(gates.has(runId));
      gates.get(runId)!.resolve();
    },
    enqueue: async (label: string) => {
      const thread = await threads.createThread(actor, {
        kind: "thread.create",
        idempotencyKey: `thread:${label}`,
        title: label,
      });
      const threadId = thread.state.threadId;
      await threads.appendMessage(actor, {
        kind: "thread.message.append",
        idempotencyKey: `message:${label}`,
        threadId,
        expectedRevision: 1,
        role: "user",
        content: label,
      });
      const run = await runs.createRun(actor, {
        kind: "run.create",
        idempotencyKey: `run:${label}`,
        threadId,
        route,
      });
      assert.ok(run.workItems[0]);
      return {
        runId: run.state.runId,
        threadId,
        label,
        workItemId: run.workItems[0].workItemId,
      };
    },
  };
}

export async function waitFor(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(
      Date.now() < deadline,
      "parallel execution did not reach the expected state",
    );
    await setTimeout(10);
  }
}
