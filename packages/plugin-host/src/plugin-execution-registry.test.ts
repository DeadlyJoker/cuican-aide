import assert from "node:assert/strict";
import test from "node:test";
import type {
  PluginExecutionServices,
  PluginToolRuntimeContext,
  PluginToolRuntimeFactory,
} from "@crewon/plugin-sdk/node";
import { PluginNodeHost, type PluginNodeLease } from "./plugin-node-host.ts";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import { preparedBorrow } from "./plugin-node-preparation.test-support.ts";
import {
  executionContext,
  executionPackage,
  factorySetup,
  runtimeSource,
} from "./plugin-execution-registry.test-support.ts";

test("installed factory receives the optional host execution services unchanged", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    setup: `const execution=ctx.services.get('crewon.execution','1');
execution.register({create(input,services){record('mode:'+services.approvalRequirement);record('http:'+typeof services.jsonHttp?.request);const runtime=${runtimeSource};runtime.services=services;return runtime;}});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  const services: PluginExecutionServices = Object.freeze({
    approvalRequirement: "perAction",
    jsonHttp: Object.freeze({ request: async () => ({ fixture: true }) }),
  });
  try {
    const factory = registry.acquire(lease);
    const runtime = await factory.create(
      executionContext(lease.identity),
      services,
    );
    assert.equal(
      (runtime as unknown as { services: PluginExecutionServices }).services,
      services,
    );
    assert.deepEqual(await pkg.records(), [
      "load",
      "setup",
      "mode:perAction",
      "http:function",
    ]);
    await runtime.close?.();
  } finally {
    lease.release();
  }
});

test("an actual installed ESM factory registers during setup and automatic host cleanup removes it", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t);
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  const factory = registry.acquire(lease);
  const runtime = await factory.create(executionContext(lease.identity));
  assert.deepEqual(runtime.definitions(), []);
  assert.equal(runtime.canRetire?.(), true);
  host.deactivate(pkg.expectedPluginId);
  const retained = await factory.create(executionContext(lease.identity));
  assert.deepEqual(retained.definitions(), []);
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "factory:1.0.0",
    "factory:1.0.0",
  ]);
  lease.release();
  await host.drain();
  assert.throws(() => factory.create(executionContext(lease.identity)), {
    message: "plugin_lease_released",
  });
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "factory:1.0.0",
    "factory:1.0.0",
    "dispose",
  ]);
  // Returned ToolRuntimes belong to the caller, not to the registry or Node setup disposer.
  await runtime.close?.();
  await retained.close?.();
  assert.equal(
    (await pkg.records()).filter((record) => record === "runtime-close").length,
    2,
  );
});

test("copied leases and getter identities cannot borrow a factory; context identity is metadata", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t);
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    assert.throws(() => registry.acquire({ ...lease }), {
      message: "plugin_node_lease_invalid",
    });
    let getters = 0;
    const forged = Object.defineProperty({}, "identity", {
      get() {
        getters++;
        return lease.identity;
      },
    });
    assert.throws(() => registry.acquire(forged as PluginNodeLease), {
      message: "plugin_node_lease_invalid",
    });
    const factory = registry.acquire(lease);
    const identityContext = executionContext(
      Object.freeze({ ...lease.identity }),
    );
    await factory.create(identityContext);
    assert.throws(
      () =>
        factory.create(
          executionContext({ ...lease.identity, version: "forged-version" }),
        ),
      {
        code: "plugin_execution_identity_mismatch",
      },
    );
    const getterContext = Object.defineProperty({}, "identity", {
      enumerable: true,
      get() {
        getters++;
        return lease.identity;
      },
    });
    assert.throws(
      () => factory.create(getterContext as PluginToolRuntimeContext),
      { code: "plugin_execution_identity_mismatch" },
    );
    assert.equal(getters, 0);
    assert.deepEqual(await pkg.records(), ["load", "setup", "factory:1.0.0"]);
  } finally {
    lease.release();
  }
});

test("a captured factory preserves its original method and receiver after registration", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    setup: `const execution=ctx.services.get('crewon.execution','1');
const original={create(input){if(this!==original)throw new Error('receiver-lost');record('original');return ${runtimeSource}}};
execution.register(original);original.create=()=>{throw new Error('mutated')};`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    await registry.acquire(lease).create(executionContext(lease.identity));
    assert.deepEqual(await pkg.records(), ["load", "setup", "original"]);
  } finally {
    lease.release();
  }
});

test("factory getters, hidden fields, symbols, custom prototypes and invalid methods are rejected without executing them", async (t) => {
  for (const [index, factory] of [
    `{get create(){record('getter');return ()=>null}}`,
    `Object.defineProperty({create(){return null}},'hidden',{value:true})`,
    `{create(){return null},[Symbol.iterator](){record('iterator')}}`,
    `Object.create({create(){record('inherited')}})`,
    `{create:3}`,
  ].entries()) {
    const registry = new PluginExecutionRegistry();
    const host = new PluginNodeHost({ services: [registry.hostService()] });
    t.after(() => host.close());
    const pkg = await executionPackage(t, {
      pluginId: `example.invalid-factory-${index}`,
      setup: `ctx.services.get('crewon.execution','1').register(${factory});`,
    });
    await assert.rejects(host.activate(pkg), {
      code: "plugin_execution_factory_invalid",
    });
    assert.deepEqual(await pkg.records(), ["load", "setup"]);
    assert.deepEqual(host.snapshot(), []);
  }
});

test("duplicate registration fails activation and automatically removes the earlier registration", async (t) => {
  const registry = new PluginExecutionRegistry({ maximumFactories: 1 });
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const bad = await executionPackage(t, {
    setup: `${factorySetup} execution.register({create(){return null}});`,
  });
  await assert.rejects(host.activate(bad), {
    code: "plugin_execution_factory_conflict",
  });
  assert.deepEqual(host.snapshot(), []);
  const good = await executionPackage(t, { pluginId: "example.after-failure" });
  await host.activate(good);
  const lease = host.acquire(
    preparedBorrow(good.expectedPluginId, good.expectedPackageDigest),
  );
  try {
    assert.deepEqual(
      (
        await registry.acquire(lease).create(executionContext(lease.identity))
      ).definitions(),
      [],
    );
  } finally {
    lease.release();
  }
});

test("registration is closed after real setup even when its bound SDK port was retained", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup: `const port=ctx.services.get('crewon.execution','1');ctx.services.provide(ctx.identity.pluginId,'1',{late(){port.register({create(){return null}})}});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    assert.throws(
      () =>
        lease.getService<{ late(): void }>(pkg.expectedPluginId, "1").late(),
      { code: "plugin_registration_closed" },
    );
    assert.throws(() => registry.acquire(lease), {
      code: "plugin_execution_factory_unavailable",
    });
  } finally {
    lease.release();
  }
});

test("manual disposal revokes both acquisition and future creation without closing returned runtimes", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup: `const handle=ctx.services.get('crewon.execution','1').register({create(){return ${runtimeSource}}});ctx.services.provide(ctx.identity.pluginId,'1',{stop(){handle.dispose();handle.dispose()}});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    const factory = registry.acquire(lease);
    const runtime = await factory.create(executionContext(lease.identity));
    lease.getService<{ stop(): void }>(pkg.expectedPluginId, "1").stop();
    assert.throws(() => registry.acquire(lease), {
      code: "plugin_execution_factory_unavailable",
    });
    assert.throws(() => factory.create(executionContext(lease.identity)), {
      code: "plugin_execution_factory_unavailable",
    });
    assert.deepEqual(runtime.definitions(), []);
    assert.deepEqual(await pkg.records(), ["load", "setup"]);
  } finally {
    lease.release();
  }
});

test("different package versions and a fresh same-digest instance never share factory authority", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const first = await executionPackage(t);
  const next = await executionPackage(t, { version: "2.0.0" });
  await host.activate(first);
  const old = host.acquire(
    preparedBorrow(first.expectedPluginId, first.expectedPackageDigest),
  );
  const oldFactory = registry.acquire(old);
  await host.activate(next);
  const current = host.acquire(
    preparedBorrow(next.expectedPluginId, next.expectedPackageDigest),
  );
  try {
    await oldFactory.create(executionContext(old.identity));
    await registry.acquire(current).create(executionContext(current.identity));
    assert.throws(() => oldFactory.create(executionContext(current.identity)), {
      code: "plugin_execution_identity_mismatch",
    });
  } finally {
    current.release();
  }
  const oldIdentity = old.identity;
  old.release();
  await host.drain();
  await host.activate(first);
  const replacement = host.acquire(
    preparedBorrow(first.expectedPluginId, first.expectedPackageDigest),
  );
  try {
    assert.notEqual(replacement.identity, oldIdentity);
    assert.deepEqual(replacement.identity, oldIdentity);
    assert.throws(
      () => oldFactory.create(executionContext(replacement.identity)),
      { message: "plugin_lease_released" },
    );
    await registry
      .acquire(replacement)
      .create(executionContext(replacement.identity));
  } finally {
    replacement.release();
  }
});

test("the registration bound is enforced before binding and is released after failed setup or instance cleanup", async (t) => {
  assert.throws(() => new PluginExecutionRegistry({ maximumFactories: 0 }), {
    code: "plugin_execution_limit_invalid",
  });
  const registry = new PluginExecutionRegistry({ maximumFactories: 1 });
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const first = await executionPackage(t);
  const next = await executionPackage(t, { pluginId: "example.capacity" });
  await host.activate(first);
  await assert.rejects(host.activate(next), {
    code: "plugin_host_service_binding_failed",
  });
  assert.deepEqual(await next.records(), ["load", "setup"]);
  host.deactivate(first.expectedPluginId);
  await host.drain();
  await host.activate(next);
  const lease = host.acquire(
    preparedBorrow(next.expectedPluginId, next.expectedPackageDigest),
  );
  try {
    await registry.acquire(lease).create(executionContext(lease.identity));
  } finally {
    lease.release();
  }
});

test("closing the registry revokes new creation while an already started factory remains caller-owned", async (t) => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({
    services: [
      registry.hostService(),
      { service: "host.gate", apiVersion: "1", value: { wait: () => gate } },
    ],
  });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    requires: [{ service: "host.gate", apiVersion: "1", optional: false }],
    setup: `const gate=ctx.services.get('host.gate','1');ctx.services.get('crewon.execution','1').register({async create(){record('creating');await gate.wait();return ${runtimeSource}}});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    const factory = registry.acquire(lease);
    const started = factory.create(executionContext(lease.identity));
    registry.close();
    registry.close();
    assert.throws(() => registry.acquire(lease), {
      code: "plugin_execution_registry_closed",
    });
    assert.throws(() => factory.create(executionContext(lease.identity)), {
      code: "plugin_execution_registry_closed",
    });
    resume();
    const runtime = await started;
    assert.deepEqual(runtime.definitions(), []);
    assert.deepEqual(await pkg.records(), ["load", "setup", "creating"]);
  } finally {
    resume();
    lease.release();
  }
  const fresh = new PluginNodeHost({
    services: [
      registry.hostService(),
      { service: "host.gate", apiVersion: "1", value: { wait: () => gate } },
    ],
  });
  t.after(() => fresh.close());
  await assert.rejects(fresh.activate(pkg), {
    code: "plugin_host_service_binding_failed",
  });
});

test("a package that throws after registering cannot leave a factory in the shared registry", async (t) => {
  const registry = new PluginExecutionRegistry({ maximumFactories: 1 });
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const failed = await executionPackage(t, {
    setup: `${factorySetup}throw new Error('fixture setup failed');`,
  });
  await assert.rejects(host.activate(failed), {
    message: "fixture setup failed",
  });
  assert.deepEqual(host.snapshot(), []);
  const next = await executionPackage(t, { pluginId: "example.recovered" });
  await host.activate(next);
  const lease = host.acquire(
    preparedBorrow(next.expectedPluginId, next.expectedPackageDigest),
  );
  try {
    const factory: PluginToolRuntimeFactory = registry.acquire(lease);
    await factory.create(executionContext(lease.identity));
  } finally {
    lease.release();
  }
});

test("closing NodeHost revokes future factory creation before its borrowed instance cleanup", async (t) => {
  const registry = new PluginExecutionRegistry();
  const host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t);
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  const factory = registry.acquire(lease);
  const runtime = await factory.create(executionContext(lease.identity));
  const closing = assert.rejects(host.close(), {
    code: "plugin_host_has_live_leases",
  });
  assert.throws(() => registry.acquire(lease), {
    message: "plugin_host_closed",
  });
  assert.throws(() => factory.create(executionContext(lease.identity)), {
    message: "plugin_host_closed",
  });
  assert.deepEqual(runtime.definitions(), []);
  assert.deepEqual(await pkg.records(), ["load", "setup", "factory:1.0.0"]);
  lease.release();
  await closing;
  assert.deepEqual(await pkg.records(), [
    "load",
    "setup",
    "factory:1.0.0",
    "dispose",
  ]);
});
