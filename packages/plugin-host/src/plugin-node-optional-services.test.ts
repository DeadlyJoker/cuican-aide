import assert from "node:assert/strict";
import test from "node:test";
import { PluginNodeHost, type PluginHostService } from "./plugin-node-host.ts";
import {
  allowPreparedCommit,
  preparedBorrow,
  preparedPackage,
} from "./plugin-node-preparation.test-support.ts";

const optional = (service: string) => ({
  service,
  apiVersion: "1",
  optional: true,
});
const ownProvision = [{ service: "example.story", apiVersion: "1" }];

test("one actual installed ESM package can detect task-only and execution-only contexts", async (t) => {
  const pkg = await preparedPackage(t, {
    requires: [optional("crewon.tasks"), optional("crewon.execution")],
    provides: ownProvision,
    setup: `if(typeof ctx.services.getOptional!=='function')throw new Error('plugin_optional_service_api_unavailable');
const tasks=ctx.services.getOptional('crewon.tasks','1');
const execution=ctx.services.getOptional('crewon.execution','1');
ctx.services.provide(ctx.identity.pluginId,'1',{
read(){return {tasks:tasks?.name??null,execution:execution?.name??null}},
strictMissing(){return ctx.services.get(tasks?'crewon.execution':'crewon.tasks','1')}
});`,
  });
  for (const service of ["crewon.tasks", "crewon.execution"]) {
    const host = new PluginNodeHost({
      services: [{ service, apiVersion: "1", value: { name: service } }],
    });
    try {
      const identity = await host.activate(pkg);
      assert.equal(identity.packageDigest, pkg.expectedPackageDigest);
      const lease = host.acquire(
        preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
      );
      try {
        const value = lease.getService<{
          read(): { tasks: string | null; execution: string | null };
          strictMissing(): never;
        }>(pkg.expectedPluginId, "1");
        assert.deepEqual(value.read(), {
          tasks: service === "crewon.tasks" ? service : null,
          execution: service === "crewon.execution" ? service : null,
        });
        assert.throws(() => value.strictMissing(), {
          code: "plugin_dependency_unavailable",
        });
      } finally {
        lease.release();
      }
    } finally {
      await host.close();
    }
  }
});

test("optional absence includes an incompatible provider but never changes strict get", async (t) => {
  const pkg = await preparedPackage(t, {
    requires: [optional("host.optional")],
    setup: `if(ctx.services.getOptional('host.optional','1')!==undefined)throw new Error('unexpected_optional');
try{ctx.services.get('host.optional','1')}catch(error){record(error.code);return}
throw new Error('strict_get_must_reject');`,
  });
  for (const services of [
    [],
    [{ service: "host.optional", apiVersion: "2", value: {} }],
  ]) {
    const host = new PluginNodeHost({ services });
    try {
      await host.activate(pkg);
    } finally {
      await host.close();
    }
  }
  assert.equal(
    (await pkg.records()).filter(
      (record) => record === "plugin_dependency_unavailable",
    ).length,
    2,
  );
});

test("undeclared, wrong requested API and mandatory lookups do not masquerade as optional absence", async (t) => {
  for (const input of [
    {
      requires: [],
      service: "host.optional",
      version: "1",
      code: "plugin_dependency_undeclared",
    },
    {
      requires: [optional("host.optional")],
      service: "host.optional",
      version: "2",
      code: "plugin_dependency_undeclared",
    },
    {
      requires: [{ ...optional("host.optional"), optional: false }],
      service: "host.optional",
      version: "1",
      code: "plugin_dependency_not_optional",
    },
  ]) {
    let bindings = 0;
    const host = new PluginNodeHost({
      services: [
        {
          service: "host.optional",
          apiVersion: "1",
          value: {},
          bindForPlugin() {
            bindings++;
            return {};
          },
        },
      ],
    });
    const pkg = await preparedPackage(t, {
      requires: input.requires,
      setup: `ctx.services.getOptional(${JSON.stringify(input.service)},${JSON.stringify(input.version)});`,
    });
    try {
      await assert.rejects(host.activate(pkg), { code: input.code });
      assert.equal(bindings, 0);
      assert.deepEqual(host.snapshot(), []);
    } finally {
      await host.close();
    }
  }
});

test("get and getOptional share one actual bound identity, receiver and cleanup lifetime", async (t) => {
  class OptionalHostService implements PluginHostService {
    readonly service = "host.optional";
    readonly apiVersion = "1";
    readonly value = { identity: "unbound-authority" };
    bindings = 0;
    disposals = 0;
    bindForPlugin(
      identity: Parameters<NonNullable<PluginHostService["bindForPlugin"]>>[0],
      lifetime: Parameters<NonNullable<PluginHostService["bindForPlugin"]>>[1],
    ) {
      this.bindings++;
      lifetime.onDispose(() => {
        this.disposals++;
      });
      return { identity };
    }
  }
  const service = new OptionalHostService();
  const host = new PluginNodeHost({ services: [service] });
  const pkg = await preparedPackage(t, {
    requires: [optional(service.service)],
    provides: ownProvision,
    setup: `const first=ctx.services.getOptional('host.optional','1');
const strict=ctx.services.get('host.optional','1');
const second=ctx.services.getOptional('host.optional','1');
ctx.services.provide(ctx.identity.pluginId,'1',{read:()=>first.identity,same:()=>first===strict&&strict===second});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    const value = lease.getService<{ read(): object; same(): boolean }>(
      pkg.expectedPluginId,
      "1",
    );
    assert.equal(value.read(), lease.identity);
    assert.equal(value.same(), true);
    assert.equal(service.bindings, 1);
    assert.equal(service.disposals, 0);
  } finally {
    lease.release();
    await host.close();
  }
  assert.equal(service.disposals, 1);
});

test("optional binding failure remains tainted even when the next optional dependency is absent", async (t) => {
  let bindings = 0;
  let goodBindings = 0;
  const cause = new Error("fixture-optional-binding-failure");
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.bad",
        apiVersion: "1",
        value: {},
        bindForPlugin() {
          bindings++;
          throw cause;
        },
      },
      {
        service: "host.good",
        apiVersion: "1",
        value: {},
        bindForPlugin() {
          goodBindings++;
          return {};
        },
      },
    ],
  });
  const pkg = await preparedPackage(t, {
    requires: [
      optional("host.bad"),
      optional("host.absent"),
      optional("host.good"),
    ],
    setup: `let original;
try{ctx.services.getOptional('host.bad','1')}catch(error){original=error;record('binding-failed')}
for(const service of ['host.bad','host.absent','host.good']){
try{ctx.services.getOptional(service,'1');throw new Error('taint-was-lost')}
catch(error){if(error!==original)throw error;record('taint-preserved')}}`,
  });
  try {
    await assert.rejects(host.activate(pkg), (error: unknown) => {
      const result = error as Error & { code: string };
      return (
        result.code === "plugin_host_service_binding_failed" &&
        result.cause === cause
      );
    });
    assert.equal(bindings, 1);
    assert.equal(goodBindings, 0);
    assert.equal(
      (await pkg.records()).filter((record) => record === "taint-preserved")
        .length,
      3,
    );
    assert.deepEqual(host.snapshot(), []);
  } finally {
    await host.close();
  }
});

test("optional lookup preserves the prepared dependency availability commit fence", async (t) => {
  for (const initiallyPresent of [false, true]) {
    const provider = await preparedPackage(t, {
      pluginId: "example.provider",
      provides: [{ service: "story.optional", apiVersion: "1" }],
      setup: "ctx.services.provide('story.optional','1',{value:1});",
    });
    const consumer = await preparedPackage(t, {
      requires: [optional("story.optional")],
      setup:
        "record(ctx.services.getOptional('story.optional','1')===undefined?'absent':'present');",
    });
    const host = new PluginNodeHost({ services: [] });
    try {
      if (initiallyPresent) await host.activate(provider);
      const prepared = await host.prepare(consumer);
      assert.ok(
        (await consumer.records()).includes(
          initiallyPresent ? "present" : "absent",
        ),
      );
      if (initiallyPresent) host.deactivate(provider.expectedPluginId);
      else await host.activate(provider);
      assert.throws(() => prepared.commit(allowPreparedCommit), {
        code: "plugin_dependency_changed_during_activation",
      });
      await prepared.abort();
    } finally {
      await host.close();
    }
  }
});

test("a retained borrow keeps its captured optional port until actual disposal", async (t) => {
  let read: (() => object | undefined) | undefined;
  const host = new PluginNodeHost({
    services: [
      { service: "host.optional", apiVersion: "1", value: { value: 1 } },
      {
        service: "host.capture",
        apiVersion: "1",
        value: {
          save: (value: typeof read) => {
            read = value;
          },
        },
      },
    ],
  });
  const pkg = await preparedPackage(t, {
    requires: [
      optional("host.optional"),
      { service: "host.capture", apiVersion: "1", optional: false },
    ],
    setup:
      "ctx.services.get('host.capture','1').save(()=>ctx.services.getOptional('host.optional','1'));",
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  host.deactivate(pkg.expectedPluginId);
  assert.deepEqual(read!(), { value: 1 });
  lease.release();
  await host.drain();
  assert.throws(() => read!(), { code: "plugin_instance_unavailable" });
  await host.close();
});

test("absent optional lookup cannot conceal an actual cleanup-failed instance", async (t) => {
  let read: (() => object | undefined) | undefined;
  const host = new PluginNodeHost({
    services: [
      {
        service: "host.capture",
        apiVersion: "1",
        value: {
          save: (value: typeof read) => {
            read = value;
          },
        },
      },
    ],
  });
  const pkg = await preparedPackage(t, {
    requires: [
      optional("host.absent"),
      { service: "host.capture", apiVersion: "1", optional: false },
    ],
    setup:
      "ctx.services.get('host.capture','1').save(()=>ctx.services.getOptional('host.absent','1'));",
    dispose: "throw new Error('fixture-cleanup-failure');",
  });
  await host.activate(pkg);
  assert.equal(read!(), undefined);
  await assert.rejects(host.close(), /plugin_cleanup_failed/u);
  assert.equal(host.snapshot()[0]!.phase, "cleanupFailed");
  assert.throws(() => read!(), { code: "plugin_instance_unavailable" });
});
