import assert from "node:assert/strict";
import test from "node:test";
import {
  actor,
  businessExecutionFixture,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { professionalProviderFixture } from "./installed-plugin-ui-business-execution.provider.test-support.ts";
import {
  externalInstalledPackage,
  interruptedInstalledAcknowledgement,
  tick,
  until,
} from "./installed-plugin-runtime-maintenance.test-support.ts";
import { ToolResultMaintenance } from "./tool-result-maintenance.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: terminal paid SDK Run repairs COMMIT-to-ACK interruption during idle after authority revocation`,
    options,
    async (t) => {
      const provider = await professionalProviderFixture(t);
      const f = await businessExecutionFixture(t, backend, {
        ...externalInstalledPackage(),
        configurationParameters: {
          organization: "Fixture company",
          providerBaseUrl: provider.baseUrl,
        },
      });
      const interrupted = interruptedInstalledAcknowledgement(t);
      let allowed = true;
      let authorizationCalls = 0;
      const worker = await f.openWorker({
        installedPluginExecution: {
          installRoot: f.pkg.input.installRoot,
          authorization: {
            authorize: async () => {
              authorizationCalls++;
              return allowed
                ? { outcome: "allow" }
                : { outcome: "deny", reasonCode: "fixture_permission_revoked" };
            },
          },
          resolveActor: async () => actor,
          authorizePackage: async () => {
            authorizationCalls++;
            return allowed ? "allow" : "deny";
          },
        },
      });
      const original = await f.defaultTask();
      assert.equal((await worker.worker.wake()).kind, "completed");
      assert.equal(
        interrupted.observed.length,
        0,
        "a Run without a v1 admission never creates an installed SDK runtime",
      );
      assert.equal(provider.requests().length, 0);
      const request = await f.prepareTask("terminal-ack-interruption");
      const task = await request.create();
      assert.deepEqual(await worker.worker.wake(), {
        kind: "completed",
        runId: task.binding.runId,
      });
      const sdk = interrupted.observed[0];
      assert.ok(sdk);
      assert.equal(
        sdk.context.identity.packageDigest,
        f.pkg.installed.packageDigest,
      );
      assert.equal(sdk.context.run.runId, task.binding.runId);
      assert.equal(sdk.closed, false);
      assert.equal(sdk.runtime.canRetire?.(), false);
      assert.equal(
        sdk.runtime.scanRetainedExecutionResults?.({ limit: 128 }).length,
        1,
      );
      assert.ok(sdk.ackAttempts > 0);
      assert.equal(sdk.acknowledged, 0);
      assert.equal(
        (await f.store.loadRunInSpace(task.binding))?.status,
        "completed",
      );
      const command = sdk.commands[0]!;
      const savedReceipt = await f.store.loadToolExecutionReceiptByAction({
        tenantId: actor.tenantId,
        runId: task.binding.runId,
        actionDigest: command.actionDigest,
      });
      assert.equal(savedReceipt?.status, "completed");
      const events = await f.store.listRunEvents(task.binding, 0, 100);
      const messages = await f.store.listMessages(task.binding, 0, 100);
      const modelRequests = structuredClone(f.controls.models);
      const requests = provider.requests();
      const admission = await f.extensions.loadPluginTaskAdmission(
        task.binding,
      );
      const quotes = f.controls.quotes;
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      allowed = false;
      await f.select("disabled", f.pkg.installed.packageDigest);
      const authorizations = authorizationCalls;
      interrupted.control.blocked = false;
      for (let pass = 0; pass < 4 && !sdk.packageClosed; pass++) {
        assert.equal((await worker.worker.wake()).kind, "idle");
        await tick();
      }
      await until(() => sdk.packageClosed);
      assert.equal(sdk.acknowledged, 1);
      assert.equal(sdk.closeCalls, 1);
      assert.ok(sdk.scanned > 0);
      assert.equal(
        authorizationCalls,
        authorizations,
        "local receipt verification does not request revoked external authority",
      );
      assert.deepEqual(provider.requests(), requests);
      assert.deepEqual(f.controls.models, modelRequests);
      assert.deepEqual(
        await f.store.listRunEvents(task.binding, 0, 100),
        events,
      );
      assert.deepEqual(
        await f.store.listMessages(task.binding, 0, 100),
        messages,
      );
      assert.deepEqual(
        await f.extensions.loadPluginTaskAdmission(task.binding),
        admission,
      );
      assert.equal(f.controls.quotes, quotes);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(
        (
          await f.store.loadRunInSpace({
            ...actor,
            runId: original.runState.runId,
          })
        )?.status,
        "completed",
      );
      assert.equal((await worker.worker.wake()).kind, "idle");
      await f.closeWorker();
    },
  );

  test(
    `${backend}: admitted maintenance keeps its actual Node owner through a stalled receipt read and frees capacity only after ACK and physical close`,
    options,
    async (t) => {
      const provider = await professionalProviderFixture(t);
      const f = await businessExecutionFixture(t, backend, {
        ...externalInstalledPackage(),
        configurationParameters: {
          organization: "Fixture company",
          providerBaseUrl: provider.baseUrl,
        },
      });
      const interrupted = interruptedInstalledAcknowledgement(t);
      const worker = await f.openWorker({
        installedPluginExecution: {
          installRoot: f.pkg.input.installRoot,
          maximumRuntimes: 1,
          authorization: { authorize: async () => ({ outcome: "allow" }) },
          resolveActor: async () => actor,
          authorizePackage: async () => "allow",
        },
      });
      const firstTask = await (
        await f.prepareTask("maintenance-capacity-first")
      ).create();
      assert.equal((await worker.worker.wake()).kind, "completed");
      const sdk = interrupted.observed[0]!;
      const command = sdk.commands[0]!;
      const saved = await f.store.loadToolExecutionReceiptByAction({
        tenantId: actor.tenantId,
        runId: firstTask.binding.runId,
        actionDigest: command.actionDigest,
      });
      assert.equal(saved?.status, "completed");
      const resolver = [...interrupted.resolvers][0];
      assert.ok(resolver);
      let releaseRead!: () => void;
      const physicalRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      let reads = 0;
      const maintenance = new ToolResultMaintenance({
        store: {
          loadToolExecutionReceiptByAction: async () => {
            reads++;
            await physicalRead;
            return saved;
          },
        },
        nextRuntimeLease: () => resolver.nextToolResultMaintenanceLease(),
      });
      try {
        assert.equal((await maintenance.poll()).pending, true);
        assert.equal(reads, 1);
        for (let wake = 0; wake < 20; wake++)
          assert.equal((await maintenance.poll()).pending, true);
        assert.equal(reads, 1);
        assert.equal(sdk.closeCalls, 0);
        assert.equal(sdk.packageClosed, false);
        const secondTask = await (
          await f.prepareTask("maintenance-capacity-second")
        ).create();
        const run = await f.store.loadRunInSpace(secondTask.binding);
        assert.ok(run);
        const base = await f.resolver.resolve({
          tenantId: run.tenantId,
          agentVersionId: run.agentVersionId,
        });
        assert.ok(base);
        await assert.rejects(
          resolver.acquire({
            run,
            base,
            purpose: "submit",
            signal: new AbortController().signal,
          }),
          /installed_plugin_runtime_capacity_exhausted/,
        );
        assert.equal(interrupted.observed.length, 1);
        interrupted.control.blocked = false;
        releaseRead();
        await until(() => !maintenance.snapshot().pending && sdk.packageClosed);
        assert.equal(maintenance.snapshot().acknowledged, 1);
        assert.equal(sdk.acknowledged, 1);
        assert.equal(sdk.closeCalls, 1);
        assert.deepEqual(
          provider.requests().map(({ method }) => method),
          ["POST"],
        );
        assert.deepEqual(await worker.worker.wake(), {
          kind: "completed",
          runId: secondTask.binding.runId,
        });
        assert.equal(interrupted.observed.length, 2);
        assert.deepEqual(
          provider.requests().map(({ method }) => method),
          ["POST", "POST"],
        );
        assert.equal(f.controls.quotes, 2);
        assert.equal(await f.count("plugin_credit_reservations"), 2);
      } finally {
        maintenance.close();
        releaseRead();
      }
      await f.closeWorker();
    },
  );
}
