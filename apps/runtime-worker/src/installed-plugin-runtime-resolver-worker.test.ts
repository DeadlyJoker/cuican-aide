import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RunExecutionService } from "@crewon/application";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { installedResolverFixture } from "./installed-plugin-runtime-resolver.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `standalone owned execution config uses ${backend} and a real installed ESM in the paid-task Worker path`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await installedResolverFixture(t, { backend });
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
          leaseDurationMs: 30_000,
          retryAfterMs: 0,
          approvalRecheckMs: 1,
          scanIntervalMs: null,
        },
      );
      try {
        const before = await f.first.store.loadPluginTaskAdmission(
          f.task.binding,
        );
        const outcome = await worker.wake();
        assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
        assert.equal(
          f.controls.records.filter((value) => value === "execute").length,
          1,
        );
        assert.equal(
          f.controls.records.filter((value) => value === "factory").length,
          1,
        );
        assert.equal(f.controls.baseCalls, 0);
        assert.ok(f.controls.records.includes("ack"));
        assert.deepEqual(
          await f.first.store.loadPluginTaskAdmission(f.task.binding),
          before,
        );
        assert.equal(await f.count("plugin_credit_reservations"), 1);
        assert.equal(await f.count("run_snapshots"), 1);
        const events = await f.first.parent.listRunEvents(
          f.task.binding,
          0,
          100,
        );
        assert.ok(events.some((event) => event.type === "run.completed"));
        const completed = events.find(
          (event) => event.type === "run.completed",
        );
        assert.ok(completed?.type === "run.completed");
        const messages = await f.first.parent.listMessages(
          f.task.binding,
          0,
          100,
        );
        assert.match(
          JSON.stringify(messages.at(-1)?.content),
          /answer:installed:0\.1\.0/u,
        );
      } finally {
        await worker.close();
        await resolver.close();
      }
      assert.deepEqual(f.controls.records.slice(-3), [
        "runtime-close",
        "runtime-closed",
        "node-dispose",
      ]);
    },
  );
