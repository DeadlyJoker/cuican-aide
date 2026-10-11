import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { RunExecutionService } from "@crewon/application";
import { PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE } from "@crewon/plugin-host";
import {
  actor,
  clock,
  sha,
} from "../../control-api/src/desktop-native-plugin-task-runtime.test-support.ts";
import { RuntimeWorker } from "./runtime-worker.ts";
import { PinnedRunExecutionPolicy } from "./standalone-adapters.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  nativeCompositionFixture,
  providerId,
  providerService,
  signal,
} from "./installed-plugin-native-composition.test-support.ts";

test(
  "Native opt-in issues the original graph, executes captured A through real Worker B, and cold observation retains original receipts after disable",
  { skip: process.platform === "win32", timeout: 30000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string; disposition: string };
    assert.equal(task.disposition, "committed");
    const locator = {
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      runId: task.runId,
    };
    const binding = await f.originalStore
      .extensionStore()
      .loadExtensionRunBinding(locator);
    assert.ok(binding?.schemaVersion === "crewon.extension-run-binding.v1");
    const compositions =
      f.originalStore.pluginInstallationStore().compositionStore!();
    const original = await compositions.loadLock({
      scope: f.scope,
      lockDigest: binding.composition.lockDigest,
    });
    assert.ok(original);
    assert.equal(original.scope.authorityEpoch, f.bootstrap.authorityEpoch);
    assert.deepEqual(original.hostServices, [
      PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE,
      ...(["1", "2"] as const).map((apiVersion) => ({
        service: "crewon.tasks",
        apiVersion,
        implementationId: "crewon.desktop-task-core-binding.v1",
        implementationRevision: 1,
      })),
    ]);
    assert.ok(
      original.nodes.some(
        (n) =>
          n.pluginId === providerId &&
          n.packageDigest === f.provider!.packageDigest,
      ),
    );
    assert.ok(
      original.edges.some(
        (edge) =>
          edge.consumerPluginId === f.source.pluginId &&
          edge.service === providerService &&
          edge.provider.kind === "plugin" &&
          edge.provider.pluginId === providerId,
      ),
    );
    const admission = await f.originalStore
      .extensionStore()
      .loadPluginTaskAdmission(locator);
    assert.ok(admission?.schemaVersion === "crewon.plugin-task-admission.v1");
    assert.equal(admission.extensionBindingDigest, binding.bindingDigest);
    const live = await f.openWorker();
    assert.deepEqual(
      live.authority.installedPluginExecution.compositionExecution
        ?.hostServiceMetadata,
      [PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE],
    );
    const start = f.state.records.length;
    const worker = new RuntimeWorker(
      {
        store: f.originalStore,
        execution: new RunExecutionService({
          store: f.originalStore,
          clock,
          ids: { nextId: () => randomUUID() },
          digester: sha,
        }),
        kernel: live.base.kernel,
        policy: new PinnedRunExecutionPolicy(f.executionTarget),
        toolRuntime: live.base.toolRuntime,
        agentVersionRuntimeResolver: { resolve: () => live.base },
        pluginTaskAdmissions: f.originalStore.extensionStore(),
        installedPluginRuntimeResolver: live.resolver,
      },
      {
        ownerId: randomUUID(),
        nextLeaseId: randomUUID,
        leaseDurationMs: 30000,
        retryAfterMs: 0,
        approvalRecheckMs: 1,
        scanIntervalMs: null,
      },
    );
    try {
      const result = await worker.wake();
      assert.equal(result.kind, "completed", JSON.stringify(result));
    } finally {
      await worker.close();
    }
    assert.deepEqual(
      f.state.records
        .slice(start)
        .filter(
          (r) =>
            r === "A:setup" ||
            r === "B:factory" ||
            r === "B:execute" ||
            r === "A:read",
        ),
      ["A:setup", "B:factory", "B:execute", "A:read"],
    );
    const events = await f.originalStore.listRunEvents(locator, 0, 100);
    assert.ok(events.some((event) => event.type === "run.completed"));
    const messages = await f.originalStore.listMessages(
      { ...locator, threadId: binding.threadId },
      0,
      100,
    );
    assert.match(
      JSON.stringify(messages.at(-1)?.content),
      /Native answer:captured-native-A/,
    );
    const command = f.state.commands[0]!;
    const completed = f.state.receipts.get(command.executionId);
    assert.ok(completed);
    await live.close();
    f.state.receipts.clear(); // Cold observation must recover the fixture provider journal, not the old SDK cache.
    const selection = await f.originalStore
      .pluginInstallationStore()
      .loadSelection({ scope: f.scope, pluginId: providerId });
    assert.ok(selection);
    await f.actual.installation.select(actor, {
      pluginId: providerId,
      selectedPackageDigest: f.provider!.packageDigest,
      state: "disabled",
      expectedSelectionRevision: selection.revision,
      idempotencyKey: "native-disable-provider-after-run",
    });
    const coldControl = await f.reopen();
    assert.deepEqual(
      await f.originalStore.extensionStore().loadExtensionRunBinding(locator),
      binding,
    );
    assert.deepEqual(
      await f.originalStore.extensionStore().loadPluginTaskAdmission(locator),
      admission,
    );
    assert.deepEqual(
      await compositions.loadLock({
        scope: f.scope,
        lockDigest: original.lockDigest,
      }),
      original,
    );
    const cold = await f.openWorker();
    const run = await f.originalStore.loadRunInSpace(locator);
    assert.ok(run);
    const lease = await cold.resolver.acquire({
      run,
      base: cold.base,
      purpose: "observe",
      signal: signal(),
    });
    assert.ok(lease);
    try {
      assert.deepEqual(
        await lease.resource.reconcile(command, signal()),
        completed,
      );
      await assert.rejects(lease.resource.execute(command, signal()));
    } finally {
      lease.release();
    }
    assert.equal(f.state.records.filter((r) => r === "B:execute").length, 1);
    assert.equal(f.state.records.filter((r) => r === "B:factory").length, 2);
    assert.ok(coldControl.tasks);
    await cold.close();
  },
);

test(
  "the same Native bootstrap epoch pin withdraws Core task issue, active Worker dispatch and cold reconstruction",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string };
    const live = await f.openWorker();
    const run = await f.originalStore.loadRunInSpace({
      ...actor,
      runId: task.runId,
    });
    assert.ok(run);
    const lease = await live.resolver.acquire({
      run,
      base: live.base,
      purpose: "submit",
      signal: signal(),
    });
    assert.ok(lease);
    const before = f.state.records.length;
    await f.rotateEpoch();
    try {
      for (const method of ["execute", "reconcile", "cancel"] as const)
        await assert.rejects(
          lease.resource[method](f.execution(task.runId), signal()),
          /installed_plugin_native_authority_/,
        );
      await assert.rejects(async () => f.invoke());
      await assert.rejects(
        f.openWorker(),
        /installed_plugin_native_authority_/,
      );
      assert.deepEqual(f.state.records.slice(before), []);
      assert.equal(f.facts().runs, 1);
    } finally {
      lease.release();
      await live.close();
    }
  },
);

test(
  "legacy Native bootstrap retains the v0 task contract and supplies no composition execution",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await nativeCompositionFixture(t, { composition: false });
    const live = await f.openWorker();
    assert.equal(
      live.authority.installedPluginExecution.compositionExecution,
      undefined,
    );
    const task = (await f.invoke()) as { runId: string };
    const binding = await f.originalStore
      .extensionStore()
      .loadExtensionRunBinding({ ...actor, runId: task.runId });
    assert.equal(binding?.schemaVersion, "crewon.extension-run-binding.v0");
    assert.equal(f.facts().runs, 1);
    await live.close();
  },
);

test(
  "a valid new Native owner cannot grant old-epoch composed mutation, while same-epoch resume and original receipt observation remain available",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string };
    const locator = { ...actor, runId: task.runId };
    const run = await f.originalStore.loadRunInSpace(locator);
    assert.ok(run);
    const originalBinding = await f.originalStore
      .extensionStore()
      .loadExtensionRunBinding(locator);
    const live = await f.openWorker();
    const execution = f.execution(task.runId);
    const lease = await live.resolver.acquire({
      run,
      base: live.base,
      purpose: "submit",
      signal: signal(),
    });
    assert.ok(lease);
    const completed = await lease.resource.execute(execution, signal());
    lease.release();
    await live.close();
    // A fresh owner with the same legitimate Native epoch can resume the old Run.
    const resumed = await f.openWorker();
    const allowed = await resumed.resolver.acquire({
      run,
      base: resumed.base,
      purpose: "submit",
      signal: signal(),
    });
    assert.ok(allowed);
    assert.deepEqual(
      await allowed.resource.reconcile(execution, signal()),
      completed,
    );
    allowed.release();
    await resumed.close();
    await f.reissueEpoch(); // Fresh valid pin, exact same actor/package/selection/Agent target.
    const fresh = await f.openWorker();
    await assert.rejects(async () => {
      const unexpected = await fresh.resolver.acquire({
        run,
        base: fresh.base,
        purpose: "submit",
        signal: signal(),
      });
      unexpected?.release();
    }, /installed_plugin_composition_authority_changed/);
    const observed = await fresh.resolver.acquire({
      run,
      base: fresh.base,
      purpose: "observe",
      signal: signal(),
    });
    assert.ok(observed);
    try {
      assert.deepEqual(
        await observed.resource.reconcile(execution, signal()),
        completed,
      );
      await assert.rejects(
        observed.resource.execute(execution, signal()),
        /installed_plugin_composition_authority_changed/,
      );
    } finally {
      observed.release();
    }
    assert.deepEqual(
      await f.originalStore.extensionStore().loadExtensionRunBinding(locator),
      originalBinding,
    );
    assert.equal(f.state.records.filter((r) => r === "B:execute").length, 1);
    await fresh.close();
  },
);

test(
  "Native observation refuses a bootstrap pin withdrawn after the final provider actor await",
  { skip: process.platform === "win32", timeout: 20000 },
  async (t) => {
    const f = await nativeCompositionFixture(t);
    const task = (await f.invoke()) as { runId: string };
    const live = await f.openWorker();
    const deployment = live.authority.installedPluginExecution;
    assert.ok(deployment.compositionExecution?.assertCurrentAuthority);
    let actorReads = 0;
    let withdrawAtTail = false;
    const reader = new InstalledPluginRunContext({
      extensions: f.originalStore.extensionStore(),
      runs: f.originalStore,
      installations: f.originalStore.pluginInstallationStore(),
      compositions:
        f.originalStore.pluginInstallationStore().compositionStore!(),
      compositionAuthority:
        deployment.compositionExecution.assertCurrentAuthority,
      authorization: deployment.authorization,
      resolveActor: async (owner, inputSignal) => {
        const resolved = await deployment.resolveActor(owner, inputSignal);
        // Root refreshes read twice each; this sixth call is the provider's final read.
        if (withdrawAtTail && ++actorReads === 6) await f.rotateEpoch();
        return resolved;
      },
    });
    const snapshot = await reader.load({
      locator: {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        runId: task.runId,
      },
      expectedTarget: f.executionTarget,
      purpose: "observe",
      signal: signal(),
    });
    assert.ok(snapshot);
    withdrawAtTail = true;
    actorReads = 0;
    const before = f.state.records.length;
    await assert.rejects(
      reader.assertCompositionNodeCurrent(
        snapshot,
        providerId,
        "observe",
        signal(),
      ),
      /installed_plugin_native_authority_/,
    );
    assert.equal(actorReads, 6);
    assert.deepEqual(f.state.records.slice(before), []);
    assert.throws(
      () => reader.assertCompositionAuthorityCurrent(snapshot, "observe"),
      /installed_plugin_native_authority_/,
    );
    await live.close();
  },
);
