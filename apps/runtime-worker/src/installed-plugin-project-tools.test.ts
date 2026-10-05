import assert from "node:assert/strict";
import test from "node:test";
import { parsePluginTaskAdmission } from "@crewon/domain";
import { verifyLocalPluginPackage } from "@crewon/plugin-host";
import {
  assertInstalledPluginProjectToolsExternalCurrent,
  closeInstalledPluginProjectToolsStartup,
  composeInstalledPluginProjectToolsDependencies,
  createInstalledPluginProjectToolsOwner,
} from "./plugins/installed-plugin-project-tools.ts";
import {
  installedResolverFixture,
  deferred,
  signal,
  tick,
} from "./installed-plugin-runtime-resolver.test-support.ts";
import { actor } from "../../../packages/store/src/extension-configuration-service.test-support.ts";

test("external project authority checks actual admitted identity around the publisher decision without borrowing stores", async (t) => {
  const f = await installedResolverFixture(t);
  const admission = parsePluginTaskAdmission(
    await f.first.store.loadPluginTaskAdmission(f.task.binding),
  );
  const candidate = await verifyLocalPluginPackage({ directory: f.source });
  let calls = 0,
    policy = 0;
  const common = {
    admission,
    candidate,
    scope: f.profile,
    purpose: "submit" as const,
    signal: signal(),
    assertActive() {},
  };
  await assertInstalledPluginProjectToolsExternalCurrent({
    ...common,
    resolveActor: async (owner) => {
      calls++;
      assert.deepEqual(owner, {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        actorId: actor.actorId,
      });
      return actor;
    },
    authorizePackage: async (input) => {
      policy++;
      assert.equal(input.candidate, candidate);
      assert.deepEqual(input.scope, f.profile);
      assert.equal(input.purpose, "submit");
      return "allow";
    },
  });
  assert.equal(calls, 2);
  assert.equal(policy, 1);
  for (const field of [
    "tenantId",
    "spaceId",
    "actorId",
    "principalId",
  ] as const) {
    calls = 0;
    await assert.rejects(
      assertInstalledPluginProjectToolsExternalCurrent({
        ...common,
        resolveActor: async () =>
          ++calls === 1
            ? actor
            : { ...actor, [field]: `${actor[field]}-foreign` },
        authorizePackage: async () => "allow",
      }),
      /installed_plugin_project_tools_actor_mismatch/u,
    );
    assert.equal(calls, 2);
  }
  calls = 0;
  await assert.rejects(
    assertInstalledPluginProjectToolsExternalCurrent({
      ...common,
      resolveActor: async () => {
        calls++;
        return actor;
      },
      authorizePackage: async () => "deny",
    }),
    /installed_plugin_runtime_publisher_denied/u,
  );
  assert.equal(calls, 1);
});

test("external authority withdraws or aborts while publisher policy is pending", async (t) => {
  const f = await installedResolverFixture(t);
  const admission = parsePluginTaskAdmission(
    await f.first.store.loadPluginTaskAdmission(f.task.binding),
  );
  const candidate = await verifyLocalPluginPackage({ directory: f.source });
  for (const cause of ["withdraw", "abort"] as const) {
    const entered = deferred<void>(),
      leave = deferred<void>(),
      abort = new AbortController();
    let live = true,
      calls = 0;
    const result = assertInstalledPluginProjectToolsExternalCurrent({
      admission,
      candidate,
      scope: f.profile,
      purpose: "submit",
      signal: abort.signal,
      resolveActor: async () => {
        calls++;
        return actor;
      },
      assertActive() {
        if (!live) throw new Error("owned-withdrawn");
      },
      authorizePackage: async () => {
        entered.resolve();
        await leave.promise;
        return "allow";
      },
    });
    const rejected = assert.rejects(
      result,
      cause === "withdraw" ? /owned-withdrawn/u : /owned-aborted/u,
    );
    await entered.promise;
    if (cause === "withdraw") live = false;
    else abort.abort(new Error("owned-aborted"));
    leave.resolve();
    await rejected;
    assert.equal(
      calls,
      1,
      "withdrawal is checked before another identity callback",
    );
  }
});

test("per-Run service possession during ESM setup grants no commands and does not change historical service sets", async (t) => {
  const f = await installedResolverFixture(t);
  const admission = parsePluginTaskAdmission(
    await f.first.store.loadPluginTaskAdmission(f.task.binding),
  );
  const snapshot = await f.contexts.load({
    locator: {
      tenantId: f.run.tenantId,
      spaceId: f.run.spaceId,
      runId: f.run.runId,
    },
    expectedTarget: f.target,
    purpose: "submit",
    signal: signal(),
  });
  assert.ok(snapshot);
  let projectReads = 0;
  const dependencies = composeInstalledPluginProjectToolsDependencies({
    store: f.first.parent,
    config: {
      version: "crewon.project-tools.v1",
      authorization: {
        async authorize() {
          projectReads++;
          return { outcome: "deny", reasonCode: "owned-denial" };
        },
      },
    },
    resolveActor: async () => actor,
  });
  const input = {
    dependencies,
    context: snapshot.context,
    admission,
    scope: f.profile,
    tools: f.base.extensions![0]!.registration.manifest.tools,
    candidate: () => null,
    authorizeCurrent: async () =>
      assert.fail("setup must not reach current authorization"),
    authorizePackage: async () => "deny" as const,
    assertActive() {},
  };
  assert.equal(
    createInstalledPluginProjectToolsOwner({
      ...input,
      dependencies: undefined,
    }),
    null,
  );
  const first = createInstalledPluginProjectToolsOwner(input),
    second = createInstalledPluginProjectToolsOwner(input);
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
  const service = first.hostService().value as {
    readProject(input: unknown): Promise<unknown>;
  };
  await assert.rejects(
    service.readProject({
      command: f.execution(),
      request: { projectId: "unowned-project" },
    }),
    /plugin_project_tools_authority_denied/u,
  );
  assert.equal(projectReads, 0);
  const historical = {
    ...snapshot.context,
    run: {
      ...snapshot.context.run,
      source: {
        runId: f.run.runId,
        bindingDigest: snapshot.context.run.bindingDigest,
        operationId: "original",
      },
    },
  };
  assert.equal(
    createInstalledPluginProjectToolsOwner({ ...input, context: historical }),
    null,
  );
  await first.close();
  await second.close();
});

test("startup cleanup joins its service before returning and quarantines physical failures with the package owner", async () => {
  const entered = deferred<void>(),
    leave = deferred<void>();
  let closed = false;
  const joining = closeInstalledPluginProjectToolsStartup({
    owner: {
      async close() {
        entered.resolve();
        await leave.promise;
        closed = true;
      },
    },
    failureOwner: null,
  });
  await entered.promise;
  let done = false;
  void joining.then(() => {
    done = true;
  });
  await tick();
  assert.equal(done, false);
  leave.resolve();
  assert.deepEqual(await joining, { failureOwner: null, error: null });
  assert.equal(closed, true);
  let serviceCloses = 0,
    packageCloses = 0;
  const failure = new Error("owned-physical-failure");
  const quarantined = await closeInstalledPluginProjectToolsStartup({
    owner: {
      async close() {
        serviceCloses++;
        throw failure;
      },
    },
    failureOwner: {
      async close() {
        packageCloses++;
      },
    },
  });
  assert.equal(quarantined.error, failure);
  assert.ok(quarantined.failureOwner);
  await assert.rejects(
    quarantined.failureOwner.close(),
    /installed_plugin_runtime_close_failed/u,
  );
  assert.equal(serviceCloses, 2);
  assert.equal(packageCloses, 1);
});
