import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
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
import { runtimeWorkerConcurrency } from "./runtime-worker-pool.ts";

test("bounds Run concurrency and preserves the library's single-lane default", () => {
  assert.equal(runtimeWorkerConcurrency(undefined), 1);
  for (const value of [0, -1, 9, 1.5, NaN, Infinity])
    assert.throws(
      () => runtimeWorkerConcurrency(value),
      /runtime_worker_concurrency_invalid/,
    );
});

test("production composition streams two Runs independently, bounds a third, and preserves history on reopen", async (t) => {
  const f = await fixture(t);
  const runs = await Promise.all([
    f.enqueue("first"),
    f.enqueue("second"),
    f.enqueue("third"),
  ]);
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  await waitFor(async () =>
    (
      await Promise.all(
        runs
          .slice(0, 2)
          .map((run) =>
            f.store.listRunEvents(
              { tenantId: "tenant-1", runId: run.runId },
              0,
              100,
            ),
          ),
      )
    ).every((events) =>
      events.some((event) => event.type === "model.output.delta"),
    ),
  );
  // Reconnecting readers recover each stream's own committed prefix while both
  // model calls are still pending; no second model request is needed.
  const streamingReader = new SqliteRunStore(f.databasePath);
  try {
    for (const run of runs.slice(0, 2)) {
      const prefix = await streamingReader.listRunEvents(
        { tenantId: "tenant-1", runId: run.runId },
        0,
        100,
      );
      assert.equal(
        prefix.filter((event) => event.type === "model.output.delta").length,
        1,
      );
      assert.equal(
        prefix.every((event) => event.identity.runId === run.runId),
        true,
      );
      assert.equal(
        prefix.some((event) => event.type === "run.completed"),
        false,
      );
      assert.deepEqual(
        await streamingReader.listRunEvents(
          { tenantId: "tenant-1", runId: run.runId },
          prefix.at(-1)!.sequence,
          100,
        ),
        [],
      );
    }
  } finally {
    streamingReader.close();
  }
  assert.equal(f.entered.has(runs[2]!.runId), false);
  assert.equal(f.maximumActive(), 2);
  // The slow first Run must not prevent the second from finishing or the third starting.
  f.release(runs[1]!.runId);
  await waitFor(
    async () => (await f.load(runs[1]!.runId))?.status === "completed",
  );
  await waitFor(() => f.entered.has(runs[2]!.runId));
  assert.equal((await f.load(runs[0]!.runId))?.status, "running");
  f.release(runs[2]!.runId);
  f.release(runs[0]!.runId);
  await waitFor(async () =>
    (await Promise.all(runs.map((r) => f.load(r.runId)))).every(
      (r) => r?.status === "completed",
    ),
  );
  assert.equal(f.maximumActive(), 2);
  await f.runtime.close();
  assert.equal(f.closed(), 1);
  for (const run of runs) {
    const messages = await f.store.listMessages(
      { tenantId: "tenant-1", threadId: run.threadId },
      0,
      20,
    );
    assert.deepEqual(
      messages.map((message) => message.content),
      [run.label, `answer:${run.runId}`],
    );
    const attempts = await f.store.listRunAttempts(
      {
        tenantId: "tenant-1",
        runId: run.runId,
        stepId: run.workItemId,
      },
      0,
      20,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "completed");
  }
  // A fresh read connection sees the same durable results; no replayed model requests.
  const reopened = new SqliteRunStore(f.databasePath);
  try {
    for (const run of runs)
      assert.equal(
        (await reopened.loadRun({ tenantId: "tenant-1", runId: run.runId }))
          ?.status,
        "completed",
      );
    assert.equal(f.entered.size, 3);
  } finally {
    reopened.close();
  }
});

test("canceling one parallel Run leaves its sibling streaming and closes all lanes before the transport", async (t) => {
  const f = await fixture(t);
  const first = await f.enqueue("cancel me"),
    second = await f.enqueue("keep working");
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  const running = await f.load(first.runId);
  assert.ok(running);
  await f.runs.transitionRun(f.actor, {
    kind: "run.requestCancel",
    runId: first.runId,
    expectedRevision: running.revision,
    idempotencyKey: "cancel-first",
  });
  await waitFor(async () => (await f.load(first.runId))?.status === "canceled");
  assert.equal(f.entered.get(first.runId)?.aborted, true);
  assert.equal(f.entered.get(second.runId)?.aborted, false);
  f.release(second.runId);
  await waitFor(
    async () => (await f.load(second.runId))?.status === "completed",
  );
  await f.runtime.close();
  assert.equal(f.closed(), 1);
});

test("closing production composition aborts both in-flight streams and joins them before shared transport disposal", async (t) => {
  const f = await fixture(t);
  await f.enqueue("first");
  await f.enqueue("second");
  f.runtime.start();
  await waitFor(() => f.entered.size === 2);
  const closing = f.runtime.close();
  assert.equal(f.runtime.close(), closing);
  await closing;
  assert.equal(
    [...f.entered.values()].every((signal) => signal.aborted),
    true,
  );
  assert.equal(f.active(), 0);
  assert.equal(f.closed(), 1);
});

async function fixture(t: TestContext) {
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
    scanIntervalMs: 20,
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

async function waitFor(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await condition())) {
    assert.ok(
      Date.now() < deadline,
      "parallel execution did not reach the expected state",
    );
    await setTimeout(10);
  }
}
