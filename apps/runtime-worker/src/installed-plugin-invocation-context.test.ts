import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RunExecutionService } from "@crewon/application";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { installedPluginInvocationContext } from "./plugins/installed-plugin-invocation-context.ts";
import { installedResolverFixture } from "./installed-plugin-runtime-resolver.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";

test("invocation facts come from the admitted Run, stay bounded, and cannot turn another action into generation", async (t) => {
  const f = await installedResolverFixture(t);
  const admission = await f.first.store.loadPluginTaskAdmission(f.task.binding);
  assert.ok(admission);
  const before = JSON.stringify({ run: f.run, admission });
  const context = installedPluginInvocationContext(f.run, admission);
  assert.equal(context.length, 1);
  const item = context[0]!;
  assert.ok(item.type === "message");
  assert.equal(item.role, "developer");
  assert.ok(Buffer.byteLength(item.content) < 2048);
  assert.ok(item.content.includes(f.run.runId));
  assert.ok(item.content.includes("earlier Runs do not cancel"));
  assert.ok(item.content.includes("never submit it again"));
  assert.equal(item.content.includes(admission.idempotencyKey), false);
  assert.deepEqual(installedPluginInvocationContext(f.run, admission), context);
  assert.equal(JSON.stringify({ run: f.run, admission }), before);
  assert.throws(
    () =>
      installedPluginInvocationContext(f.run, {
        ...admission,
        runId: "another-run",
      }),
    /context_mismatch/,
  );
  assert.deepEqual(
    installedPluginInvocationContext(f.run, {
      ...admission,
      action: "project.conversation",
    }),
    [],
  );
  const query = installedPluginInvocationContext(f.run, {
    ...admission,
    action: "image.query",
  })[0]!;
  assert.ok(
    query.type === "message" &&
      query.content.includes("Never submit a generation"),
  );
});

test("actual installed Worker streams a result after restart with identical invocation facts and one physical tool execution", async (t) => {
  const f = await installedResolverFixture(t);
  const createWorker = () => {
    const resolver = f.compositionResolver();
    const worker = new RuntimeWorker(
      {
        store: f.first.parent,
        execution: new RunExecutionService({
          store: f.first.parent,
          clock: { now: () => timestamp },
          ids: { nextId: () => randomUUID() },
          digester,
        }),
        kernel: f.base.kernel,
        policy: new PinnedRunExecutionPolicy(f.target),
        toolRuntime: f.base.toolRuntime,
        agentVersionRuntimeResolver: { resolve: () => f.base },
        pluginTaskAdmissions: f.first.store,
        installedPluginRuntimeResolver: resolver,
      },
      {
        ownerId: randomUUID(),
        nextLeaseId: randomUUID,
        leaseDurationMs: 30000,
        retryAfterMs: 0,
        approvalRecheckMs: 1,
        scanIntervalMs: null,
        executionBudget: { maxBoundariesPerWake: 1 },
      },
    );
    return {
      worker,
      async close() {
        await worker.close();
        await resolver.close();
      },
    };
  };
  const first = createWorker();
  try {
    assert.equal((await first.worker.wake()).kind, "retried");
  } finally {
    await first.close();
  }
  const resumed = createWorker();
  try {
    let completed = false;
    for (let i = 0; i < 5; i++) {
      await delay(5);
      if ((await resumed.worker.wake()).kind === "completed") {
        completed = true;
        break;
      }
    }
    assert.equal(completed, true);
    assert.equal(f.controls.modelHistories.length, 2);
    const prefix = (items: (typeof f.controls.modelHistories)[number]) =>
      items.filter(
        (item) =>
          item.type === "message" &&
          item.role === "developer" &&
          item.content.includes(
            "crewon.installed-plugin-invocation-context.v1",
          ),
      );
    assert.equal(prefix(f.controls.modelHistories[0]!).length, 1);
    assert.deepEqual(
      prefix(f.controls.modelHistories[0]!),
      prefix(f.controls.modelHistories[1]!),
    );
    assert.ok(
      f.controls.modelHistories[1]!.some((item) => item.type === "tool_result"),
    );
    assert.equal(
      f.controls.records.filter((item) => item === "execute").length,
      1,
    );
    const events = await f.first.parent.listRunEvents(f.task.binding, 0, 100);
    assert.ok(events.some((event) => event.type === "model.output.delta"));
    assert.ok(events.some((event) => event.type === "run.completed"));
  } finally {
    await resumed.close();
  }
});
