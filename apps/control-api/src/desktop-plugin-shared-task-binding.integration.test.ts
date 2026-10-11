import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  nativeTaskRuntimeFixture,
  actor,
  request,
} from "./desktop-native-plugin-task-runtime.test-support.ts";
import {
  fixture as profileFixture,
  actor as profileActor,
  scope as profileScope,
} from "./desktop-plugin-instance-composition.test-support.ts";

for (const apiVersion of ["1", "2"] as const)
  for (const optional of [false, true]) {
    test(`unbound task service ${apiVersion} rejects ${optional ? "optional" : "mandatory"} Node selection before setup while installation remains usable`, async (t) => {
      const f = await profileFixture(t, [
        {
          id: "task-consumer",
          kind: "independent",
          requiresTasks: apiVersion,
          taskOptional: optional,
        },
      ]);
      await f.open("installation", { bindTasks: true });
      const source = f.source("task-consumer");
      let getterCalls = 0;
      const copied = Object.defineProperty({}, "requests", {
        get() {
          getterCalls++;
          throw new Error("must_not_read_copied_core");
        },
      });
      assert.throws(() =>
        f.taskBinding.bindCore(
          copied as Parameters<typeof f.taskBinding.bindCore>[0],
        ),
      );
      assert.equal(getterCalls, 0);
      await f.install(source);
      await assert.rejects(f.select(source, 1));
      assert.equal(f.probe.counts["task-consumer"], undefined);
      const selection = await f.store
        .pluginInstallationStore()
        .loadSelection({ scope: profileScope, pluginId: source.pluginId });
      assert.equal(selection?.state, "disabled");
      const service = f.taskBinding.catalog.registrations.find(
        (registration) => registration.metadata.apiVersion === apiVersion,
      )!;
      assert.throws(
        () =>
          service.implementation.bindForPlugin!(
            {
              pluginId: source.pluginId,
              version: source.version,
              packageDigest: source.packageDigest,
            },
            { onDispose() {} },
          ),
        /desktop_plugin_task_service_unavailable/u,
      );
      const runtime = f.runtime;
      assert.ok("service" in runtime);
      assert.throws(() =>
        runtime.borrowNode({
          actor: profileActor,
          scope: profileScope,
          pluginId: source.pluginId,
          packageDigest: source.packageDigest,
          authorizeBorrow: () => "allow",
        }),
      );
      await f.status();
      await f.close();
    });
  }

test(
  "the real Native UI task owner uses its single original profile consumer, declared provider and Task Core",
  { timeout: 20_000 },
  async (t) => {
    const key = `shared-native-task-${randomUUID()}`;
    const globals = globalThis as unknown as Record<string, unknown>;
    const probe = {
      providerSetups: 0,
      consumerSetups: 0,
      consumerDisposals: 0,
      calls: 0,
      provider: null as object | null,
      borrowed: null as object | null,
      bootWait: null as Promise<void> | null,
      bootEntered: null as (() => void) | null,
    };
    globals[key] = probe;
    t.after(() => {
      delete globals[key];
    });
    const f = await nativeTaskRuntimeFixture(t, undefined, {
      nodeSource: `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.native-business',async setup(ctx){const probe=globalThis[${JSON.stringify(key)}];probe.consumerSetups++;const tasks=ctx.services.getOptional('crewon.tasks','1');const provider=ctx.services.get('test.shared-task-source','1');probe.borrowed=provider;ctx.services.provide('test.native-business','1',{actions:[{contributionId:'workbench',action:'image.generate',kind:'generateTask'}],invoke({input,invocationRef}){probe.calls++;return tasks.createTask({...input,invocationRef});}});if(probe.bootWait){probe.bootEntered();await probe.bootWait;}return {dispose(){probe.consumerDisposals++;}};}};`,
      provider: {
        pluginId: "test.shared-task-provider",
        service: "test.shared-task-source",
        requiresTasks: "2",
        nodeSource: `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'test.shared-task-provider',setup(ctx){const probe=globalThis[${JSON.stringify(key)}];probe.providerSetups++;const tasks=ctx.services.get('crewon.tasks','2');const service={marker:'actual shared provider',hasQuery:typeof tasks.queryTask==='function'};probe.provider=service;ctx.services.provide('test.shared-task-source','1',service);}};`,
      },
    });
    assert.equal(probe.providerSetups, 1);
    assert.equal(probe.consumerSetups, 1);
    assert.equal(probe.borrowed, probe.provider);
    assert.equal((probe.provider as { hasQuery: boolean }).hasQuery, true);
    const receipt = (await f.invoke()) as {
      disposition: string;
      runId: string;
    };
    assert.equal(receipt.disposition, "committed");
    assert.deepEqual(await f.invoke(), { ...receipt, disposition: "replayed" });
    assert.equal(probe.consumerSetups, 1);
    assert.equal(probe.providerSetups, 1);
    assert.deepEqual(f.facts(), {
      runs: 1,
      admissions: 1,
      unmetered: 1,
      financialTables: [],
    });
    assert.ok(f.provider);
    await f.actual.installation.select(actor, {
      pluginId: f.provider.pluginId,
      selectedPackageDigest: f.provider.packageDigest,
      expectedSelectionRevision: 2,
      state: "disabled",
      idempotencyKey: "shared-provider-withdraw",
    });
    const calls = probe.calls;
    await assert.rejects(f.invoke());
    assert.equal(probe.calls, calls);
    assert.equal(probe.consumerDisposals, 1);
    assert.equal(f.facts().runs, 1);
    await f.actual.installation.select(actor, {
      pluginId: f.provider.pluginId,
      selectedPackageDigest: f.provider.packageDigest,
      expectedSelectionRevision: 3,
      state: "enabled",
      idempotencyKey: "shared-provider-restore",
    });
    // Its descriptor keeps the existing optional-provider business compatibility boundary.
    // Withdrawal attempts a replacement whose required get() fails before providing an action.
    assert.equal(probe.consumerSetups, 3);
    assert.equal(probe.providerSetups, 2);
    assert.equal(probe.borrowed, probe.provider);
    assert.deepEqual(await f.invoke(), { ...receipt, disposition: "replayed" });
    assert.equal(probe.consumerSetups, 3);
    assert.equal(f.facts().runs, 1);
    await f.actual.close();
    assert.equal(probe.consumerDisposals, 2);
    let entered!: () => void;
    let resume!: () => void;
    const bootEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    probe.bootEntered = entered;
    probe.bootWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let forced = false;
    const timeout = setTimeout(() => {
      forced = true;
      resume();
    }, 3000);
    const reopened = await f.reopen();
    await bootEntered;
    const readConfiguration = () =>
      reopened.configuration.requests.run(
        { request: request(), actor, preparation: "configuration" },
        () =>
          reopened.configuration.extensions.getConfiguration(actor, {
            pluginId: f.source.pluginId,
            revision: null,
          }),
      );
    const savedConfiguration = await readConfiguration();
    assert.equal(savedConfiguration?.revision, f.configuration.revision);
    const mount = await reopened.ui.openMount(actor, {
      pluginId: f.source.pluginId,
      contributionId: "workbench",
      expectedPackageDigest: f.source.packageDigest,
      expectedSelectionRevision: 2,
    });
    let returned = false;
    const invoking = reopened.ui.invokeAuthenticatedRequest!(
      request(),
      actor,
      { ...f.command, mountRef: mount.mountRef },
      new AbortController().signal,
    );
    void invoking.then(
      () => {
        returned = true;
      },
      () => {
        returned = true;
      },
    );
    try {
      await readConfiguration();
      assert.equal(
        returned,
        false,
        "the action must wait for the actual startup, without blocking authenticated original metadata reads",
      );
      assert.equal(
        forced,
        false,
        "the Runtime and read must not wait for blocked plugin setup",
      );
    } finally {
      resume();
      clearTimeout(timeout);
    }
    const replay = await invoking;
    assert.deepEqual(replay, { ...receipt, disposition: "replayed" });
    assert.equal(probe.providerSetups, 3);
    assert.equal(probe.consumerSetups, 4);
    assert.equal(probe.borrowed, probe.provider);
    assert.equal(f.facts().runs, 1);
    await reopened.close();
    assert.equal(probe.consumerDisposals, 3);
  },
);
