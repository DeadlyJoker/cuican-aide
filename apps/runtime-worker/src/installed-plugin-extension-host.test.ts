import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionConfiguration } from "@crewon/domain";
import { PluginExecutionPackage } from "@crewon/plugin-host";
import { InstalledPluginExtensionHost } from "./plugins/installed-plugin-extension-host.ts";
import {
  gate,
  hostFixture,
  digester,
  scope,
} from "./installed-plugin-extension-host.test-support.ts";

test("task admission identifies the exact installed registration DTO without authorizing or starting resources", async (t) => {
  const f = await hostFixture(t);
  f.state.allowed = false;
  f.state.profile = null;
  await f.select("disabled");
  const reads = f.factoryState.reads;
  assert.equal(
    f.host.taskAdmissionMode({
      registration: structuredClone(f.request.registration),
    }),
    "installed",
  );
  assert.deepEqual(await f.events(), []);
  assert.equal(f.factoryState.transports, 0);
  assert.equal(f.factoryState.baseTools, 0);
  assert.equal(f.factoryState.reads, reads);
  assert.equal(f.state.packageChecks, 0);
  assert.deepEqual(f.state.actions, []);
});

test("task admission rejects changed identity, digest, manifest, unrecognized brand copies and a closed host", async (t) => {
  const f = await hostFixture(t);
  const registration = f.request.registration;
  for (const changed of [
    {
      ...registration,
      manifest: {
        ...registration.manifest,
        pluginId: registration.manifest.pluginId + ".other",
      },
    },
    {
      ...registration,
      manifest: { ...registration.manifest, version: "2.0.0" },
    },
    { ...registration, manifestDigest: digester.sha256("changed manifest") },
    {
      ...registration,
      implementationDigest: digester.sha256("changed implementation"),
    },
    {
      ...registration,
      manifest: {
        ...registration.manifest,
        description: "Changed instructions",
      },
    },
    structuredClone(f.entry.registration),
    null,
    [],
  ])
    assert.throws(() =>
      f.host.taskAdmissionMode({ registration: changed as never }),
    );
  assert.deepEqual(await f.events(), []);
  assert.equal(f.factoryState.transports, 0);
  assert.equal(f.factoryState.baseTools, 0);
  await f.host.close();
  assert.throws(() => f.host.taskAdmissionMode({ registration }), /closed/);
});

test("configuration validation rechecks installed metadata and authority without Node or provider setup", async (t) => {
  const f = await hostFixture(t);
  await f.host.validateConfiguration(f.request);
  assert.deepEqual(await f.events(), []);
  assert.equal(f.state.packageChecks, 0);
  assert.equal(f.factoryState.transports, 0);
  assert.equal(f.factoryState.baseTools, 0);
  assert.ok(f.state.actions.length > 0);
  assert.ok(f.state.actions.every((action) => action === "extension:read"));
});

test("actual factory runtime and registered SDK factory produce readiness without creating or executing business tools", async (t) => {
  const f = await hostFixture(t);
  const ready = await f.host.evaluate(f.request);
  assert.equal(ready.outcome, "ready");
  if (ready.outcome === "ready")
    assert.equal(ready.target.agentVersionId, f.entry.version.agentVersionId);
  assert.equal(f.factoryState.baseCalls, 0);
  assert.deepEqual(await f.events(), ["import", "setup"]);
  assert.ok(f.state.actions.includes("agentVersion:read"));
  assert.ok(f.state.packageChecks >= 3);
  const again = await f.host.evaluate(f.request);
  assert.equal(again.outcome, "ready");
  assert.deepEqual(await f.events(), ["import", "setup"]);
  await f.host.close();
  await f.host.close();
  assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
});

test("missing actual SDK factory keeps a deployed placeholder unavailable and permits clean setup retry", async (t) => {
  const f = await hostFixture(t, { registerFactory: false });
  for (let n = 0; n < 2; n++)
    assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.equal(
    (await f.events()).filter((event) => event === "setup").length,
    2,
  );
  assert.equal(
    (await f.events()).filter((event) => event === "dispose").length,
    2,
  );
  assert.equal((await f.events()).includes("create"), false);
  await f.host.close();
});

test("missing SDK factory plus failed physical cleanup stays quarantined and close reports the actual failure", async (t) => {
  const f = await hostFixture(t, {
    registerFactory: false,
    disposeFails: true,
    maximumPackages: 1,
  });
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.equal(
    (await f.events()).filter((event) => event === "setup").length,
    1,
  );
  assert.equal(
    (await f.events()).filter((event) => event === "dispose").length,
    1,
  );
  await assert.rejects(
    f.host.close(),
    /installed_plugin_extension_host_cleanup_failed/,
  );
  await assert.rejects(
    f.host.close(),
    /installed_plugin_extension_host_cleanup_failed/,
  );
});

for (const revoke of [
  "principal",
  "profile",
  "selection",
  "policy",
  "package",
] as const)
  test(`warm SDK owner does not confer current authority after ${revoke} changes`, async (t) => {
    const f = await hostFixture(t);
    assert.equal((await f.host.evaluate(f.request)).outcome, "ready");
    if (revoke === "principal")
      f.state.actor = { ...f.request.actor, principalId: "other-principal" };
    if (revoke === "profile")
      f.state.profile = { ...scope, profileId: "other-profile" };
    if (revoke === "selection") await f.select("disabled");
    if (revoke === "policy") f.state.allowed = false;
    if (revoke === "package") {
      f.state.packageAllowed = false;
      assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
    } else
      await assert.rejects(
        f.host.evaluate(f.request),
        /identity_invalid|profile_invalid|selection_unavailable|forbidden/,
      );
    assert.equal(
      (await f.events()).filter((event) => event === "setup").length,
      1,
    );
    assert.equal((await f.events()).includes("create"), false);
  });

test("selection revocation during actual ESM setup is rechecked before commit and physically disposed", async (t) => {
  const f = await hostFixture(t);
  const entered = gate();
  const release = gate();
  f.nodeState.onSetup = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.evaluate(f.request);
  await entered.promise;
  await f.select("disabled");
  release.resolve();
  await assert.rejects(pending, /selection_unavailable/);
  assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
  await f.host.close();
});

test("late package permission denial with failed disposal preserves the real failed owner", async (t) => {
  const f = await hostFixture(t, { disposeFails: true, maximumPackages: 1 });
  f.nodeState.onSetup = async () => {
    f.state.packageAllowed = false;
  };
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  f.state.packageAllowed = true;
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.equal(
    (await f.events()).filter((event) => event === "setup").length,
    1,
  );
  await assert.rejects(f.host.close(), /cleanup_failed/);
});

test("close waits for physical setup and disposal, and joins repeated close calls", async (t) => {
  const f = await hostFixture(t);
  const setupEntered = gate();
  const setupRelease = gate();
  const disposeEntered = gate();
  const disposeRelease = gate();
  f.nodeState.onSetup = async () => {
    setupEntered.resolve();
    await setupRelease.promise;
  };
  f.nodeState.onDispose = async () => {
    disposeEntered.resolve();
    await disposeRelease.promise;
  };
  const pending = f.host.evaluate(f.request);
  const rejected = assert.rejects(pending, /closed/);
  await setupEntered.promise;
  let closed = false;
  const close = f.host.close().then(() => {
    closed = true;
  });
  const again = f.host.close();
  setupRelease.resolve();
  await disposeEntered.promise;
  assert.equal(closed, false);
  disposeRelease.resolve();
  await Promise.all([close, again, rejected]);
  assert.deepEqual(await f.events(), ["import", "setup", "dispose"]);
});

test("concurrent readiness shares one actual pending package owner and keeps independent current caller checks", async (t) => {
  const f = await hostFixture(t);
  const entered = gate();
  const release = gate();
  f.nodeState.onSetup = async () => {
    entered.resolve();
    await release.promise;
  };
  const first = f.host.evaluate(f.request);
  await entered.promise;
  const second = f.host.evaluate(f.request);
  release.resolve();
  assert.deepEqual(
    (await Promise.all([first, second])).map((value) => value.outcome),
    ["ready", "ready"],
  );
  assert.equal(
    (await f.events()).filter((event) => event === "setup").length,
    1,
  );
});

test("stale configuration never opens Node even for a real immutable deployment", async (t) => {
  const f = await hostFixture(t);
  const configuration = createExtensionConfiguration(
    { ...f.request.configuration, revision: 2 },
    digester,
  );
  assert.equal(
    (await f.host.evaluate({ ...f.request, configuration })).outcome,
    "unavailable",
  );
  assert.deepEqual(await f.events(), []);
});

test("constructor rejects unverified registrations, duplicate metadata, fake resolver and invalid capacity", async (t) => {
  const f = await hostFixture(t);
  assert.throws(
    () =>
      new InstalledPluginExtensionHost({
        ...f.dependencies,
        registrations: [structuredClone(f.entry.registration)],
      }),
    /registration_unverified/,
  );
  assert.throws(
    () =>
      new InstalledPluginExtensionHost({
        ...f.dependencies,
        registrations: [f.entry.registration, f.entry.registration],
      }),
    /registration_conflict/,
  );
  assert.throws(
    () =>
      new InstalledPluginExtensionHost({
        ...f.dependencies,
        runtimeResolver: { acquire: async () => null } as never,
      }),
    /configuration_invalid/,
  );
  for (const maximumPackages of [0, 33, 1.5])
    assert.throws(
      () =>
        new InstalledPluginExtensionHost({
          ...f.dependencies,
          maximumPackages,
        }),
      /capacity_invalid/,
    );
  assert.throws(
    () =>
      new InstalledPluginExtensionHost({
        ...f.dependencies,
        installRoot: "relative",
      }),
    /configuration_invalid/,
  );
  assert.deepEqual(await f.events(), []);
});

test("method capture retains the real resolver, store receivers and fixed installation root", async (t) => {
  const f = await hostFixture(t);
  const input = f.dependencies as {
    -readonly [K in keyof typeof f.dependencies]: (typeof f.dependencies)[K];
  };
  input.installRoot = "/tmp/other-root";
  input.resolveActor = async () => null;
  input.authorizePackage = async () => "deny";
  t.mock.method(f.resolver, "acquire", async () => {
    throw new Error("replacement acquire called");
  });
  t.mock.method(f.installations, "loadSelection", async () => {
    throw new Error("replacement selection called");
  });
  assert.equal((await f.host.evaluate(f.request)).outcome, "ready");
});

test("current profile revocation while package authority is pending is checked before Node import", async (t) => {
  const f = await hostFixture(t);
  const entered = gate();
  const release = gate();
  f.state.onPackage = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.evaluate(f.request);
  await entered.promise;
  f.state.profile = null;
  release.resolve();
  await assert.rejects(pending, /profile_invalid/);
  assert.deepEqual(await f.events(), []);
});

test("ordinary validation cannot invoke the Node package loader", async (t) => {
  const f = await hostFixture(t);
  const spy = t.mock.method(PluginExecutionPackage, "open", async () => {
    throw new Error("unexpected loader");
  });
  await f.host.validateConfiguration(f.request);
  assert.equal(spy.mock.callCount(), 0);
});

for (const quarantined of [false, true])
  test(`capacity counts ${quarantined ? "failed physical cleanup" : "healthy owner"} across an actual installed version update`, async (t) => {
    const f = await hostFixture(t, {
      secondVersion: true,
      maximumPackages: 1,
      registerFactory: !quarantined,
      disposeFails: quarantined,
    });
    assert.equal(
      (await f.host.evaluate(f.request)).outcome,
      quarantined ? "unavailable" : "ready",
    );
    assert.ok(f.secondRequest);
    await f.select(
      "enabled",
      f.entries[1]!.registration.identity.packageDigest,
    );
    assert.equal(
      (await f.host.evaluate(f.secondRequest)).outcome,
      "unavailable",
    );
    assert.equal(
      (await f.events()).filter((event) => event === "setup").length,
      1,
    );
    if (quarantined) await assert.rejects(f.host.close(), /cleanup_failed/);
    else await f.host.close();
  });

test("actual runtime scope cannot be substituted by a copied DTO retaining its materialization", async (t) => {
  const f = await hostFixture(t);
  const lease = await f.resolver.acquire({
    tenantId: scope.tenantId,
    agentVersionId: f.request.agentVersionId,
  });
  assert.ok(lease);
  t.mock.method(f.resolver, "acquire", async () => ({
    resource: { ...lease.resource },
    release() {},
  }));
  const host = new InstalledPluginExtensionHost(f.dependencies);
  t.after(() => host.close());
  assert.equal((await host.evaluate(f.request)).outcome, "unavailable");
  assert.deepEqual(await f.events(), []);
  lease.release();
});

test("actual tool catalog changes cannot be replaced with manifest-only readiness", async (t) => {
  const f = await hostFixture(t);
  const lease = await f.resolver.acquire({
    tenantId: scope.tenantId,
    agentVersionId: f.request.agentVersionId,
  });
  assert.ok(lease);
  const original = lease.resource.toolRuntime.definitions();
  t.mock.method(lease.resource.toolRuntime, "definitions", () =>
    original.slice(1),
  );
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.deepEqual(await f.events(), []);
  lease.release();
});

test("SDK registration revoked during final asynchronous metadata checks is unavailable at return", async (t) => {
  const f = await hostFixture(t);
  let afterSetupReads = 0;
  f.factoryState.onRead = async () => {
    if (f.nodeState.revokeFactory !== null && ++afterSetupReads === 5)
      f.nodeState.revokeFactory();
  };
  assert.equal((await f.host.evaluate(f.request)).outcome, "unavailable");
  assert.ok(afterSetupReads >= 5);
  assert.deepEqual(await f.events(), ["import", "setup"]);
});

test("readiness keeps the actual runtime lease through final authority and metadata checks", async (t) => {
  const f = await hostFixture(t);
  let releases = 0;
  const acquire = f.resolver.acquire.bind(f.resolver);
  t.mock.method(
    f.resolver,
    "acquire",
    async (input: Parameters<typeof acquire>[0]) => {
      const lease = await acquire(input);
      if (lease === null) return null;
      return {
        resource: lease.resource,
        release() {
          releases++;
          lease.release();
        },
      };
    },
  );
  const host = new InstalledPluginExtensionHost(f.dependencies);
  t.after(() => host.close());
  let finalChecks = 0;
  f.factoryState.onRead = async () => {
    if (f.nodeState.revokeFactory !== null) {
      finalChecks++;
      assert.equal(releases, 0);
    }
  };
  f.state.onPolicy = async () => {
    if (f.nodeState.revokeFactory !== null) assert.equal(releases, 0);
  };
  assert.equal((await host.evaluate(f.request)).outcome, "ready");
  assert.ok(finalChecks > 0);
  assert.equal(releases, 1);
  await host.close();
});

test("close waits for an actual pending runtime construction and releases its late lease", async (t) => {
  const f = await hostFixture(t);
  const entered = gate();
  const release = gate();
  f.factoryState.onBaseCreate = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.evaluate(f.request);
  const rejected = assert.rejects(pending, /closed/);
  await entered.promise;
  let closed = false;
  const close = f.host.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([close, rejected]);
  // Closing the real registry must complete: the readiness lease no longer pins it.
  await f.registry.close();
  assert.equal(f.factoryState.baseCloses, 1);
  assert.equal(f.factoryState.transportCloses, 1);
  assert.deepEqual(await f.events(), []);
});
