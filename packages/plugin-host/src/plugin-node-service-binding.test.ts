import assert from "node:assert/strict";
import test from "node:test";
import type { PluginIdentity } from "@crewon/plugin-sdk/node";
import { PluginNodeHost, type PluginHostService } from "./plugin-node-host.ts";
import {
  preparedPackage,
  preparedBorrow,
} from "./plugin-node-preparation.test-support.ts";

const requires = [
  { service: "crewon.tasks", apiVersion: "1", optional: false },
];
const setup = `const first=ctx.services.get('crewon.tasks','1'); const second=ctx.services.get('crewon.tasks','1');
ctx.services.provide(ctx.identity.pluginId,'1',{read:()=>first.read(),same:()=>first===second});`;
type BoundResult = { read(): PluginIdentity; same(): boolean };

test("host factories capture inherited methods and preserve their trusted receiver", async (t) => {
  class TaskHostService implements PluginHostService {
    readonly service = "crewon.tasks";
    readonly apiVersion = "1";
    readonly value = {
      read() {
        throw new Error("shared authority must never be used");
      },
    };
    calls = 0;
    bindForPlugin(identity: PluginIdentity): object {
      this.calls++;
      return { read: () => identity };
    }
  }
  const service = new TaskHostService();
  const host = new PluginNodeHost({ services: [service] });
  t.after(() => host.close());
  service.bindForPlugin = () => {
    throw new Error("factory changed after host snapshot");
  };
  const pkg = await preparedPackage(t, {
    requires,
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    const bound = lease.getService<BoundResult>(pkg.expectedPluginId, "1");
    assert.equal(bound.read(), lease.identity);
    assert.equal(bound.same(), true);
    assert.equal(service.calls, 1);
  } finally {
    lease.release();
  }
});

test("host factories bind once per real package instance, cache ports and never fall back to shared authority", async (t) => {
  const identities: PluginIdentity[] = [];
  const template = {
    read() {
      throw new Error("shared authority must never be used");
    },
  };
  const host = new PluginNodeHost({
    services: [
      {
        service: "crewon.tasks",
        apiVersion: "1",
        value: template,
        bindForPlugin: (identity) => {
          identities.push(identity);
          return Object.freeze({ read: () => identity });
        },
      },
      {
        service: "host.unused",
        apiVersion: "1",
        value: {},
        bindForPlugin: () => {
          throw new Error("undeclared factory invoked");
        },
      },
    ],
  });
  t.after(() => host.close());
  for (const pluginId of ["example.first", "example.second"]) {
    const pkg = await preparedPackage(t, {
      pluginId,
      requires,
      provides: [{ service: pluginId, apiVersion: "1" }],
      setup,
    });
    const identity = await host.activate(pkg);
    const repeated = await host.activate(pkg);
    assert.equal(repeated, identity);
    const lease = host.acquire(
      preparedBorrow(pluginId, pkg.expectedPackageDigest),
    );
    try {
      const value = lease.getService<BoundResult>(pluginId, "1");
      assert.equal(value.read(), lease.identity);
      assert.equal(value.same(), true);
      assert.equal(identities.at(-1), lease.identity);
      assert.ok(Object.isFrozen(lease.identity));
      assert.deepEqual(lease.identity, {
        pluginId,
        version: "1.0.0",
        packageDigest: pkg.expectedPackageDigest,
      });
    } finally {
      lease.release();
    }
  }
  assert.equal(identities.length, 2);
  assert.notEqual(identities[0], identities[1]);
});

test("upgrade and withdrawal preserve the old borrowed instance's bound port until its lease retires", async (t) => {
  const identities: PluginIdentity[] = [];
  const host = new PluginNodeHost({
    services: [
      {
        service: "crewon.tasks",
        apiVersion: "1",
        value: {},
        bindForPlugin: (identity) => {
          identities.push(identity);
          return { read: () => identity };
        },
      },
    ],
  });
  t.after(() => host.close());
  const first = await preparedPackage(t, {
    version: "1.0.0",
    requires,
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup,
  });
  const next = await preparedPackage(t, {
    version: "2.0.0",
    requires,
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup,
  });
  const original = await host.activate(first);
  const old = host.acquire(
    preparedBorrow(first.expectedPluginId, first.expectedPackageDigest),
  );
  try {
    const upgraded = await host.activate(next);
    const current = host.acquire(
      preparedBorrow(next.expectedPluginId, next.expectedPackageDigest),
    );
    try {
      assert.equal(
        old.getService<BoundResult>(first.expectedPluginId, "1").read(),
        original,
      );
      assert.equal(
        current.getService<BoundResult>(next.expectedPluginId, "1").read(),
        upgraded,
      );
      assert.notEqual(original, upgraded);
      const history = host.acquire({
        ...preparedBorrow(first.expectedPluginId, first.expectedPackageDigest),
        purpose: "historicalOperation",
      });
      try {
        assert.equal(
          history.getService<BoundResult>(first.expectedPluginId, "1").read(),
          original,
        );
      } finally {
        history.release();
      }
    } finally {
      current.release();
    }
    host.deactivate(next.expectedPluginId);
    assert.throws(
      () =>
        host.acquire(
          preparedBorrow(next.expectedPluginId, next.expectedPackageDigest),
        ),
      { code: "plugin_instance_unavailable" },
    );
    assert.equal(
      old.getService<BoundResult>(first.expectedPluginId, "1").read(),
      original,
    );
    assert.deepEqual(await first.records(), ["load", "setup"]);
  } finally {
    old.release();
  }
  await host.drain();
  assert.deepEqual(await first.records(), ["load", "setup", "dispose"]);
  assert.deepEqual(await next.records(), ["load", "setup", "dispose"]);
  assert.equal(identities.length, 2);
});

test("a caught factory failure still aborts the candidate, runs real cleanup and leaves the previous package published", async (t) => {
  let failedCalls = 0;
  const host = new PluginNodeHost({
    services: [
      {
        service: "crewon.tasks",
        apiVersion: "1",
        value: {},
        bindForPlugin: (identity) => {
          if (identity.version === "2.0.0") {
            failedCalls++;
            throw new Error("fixture binding failure");
          }
          return { read: () => identity };
        },
      },
    ],
  });
  t.after(() => host.close());
  const first = await preparedPackage(t, {
    requires,
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup,
  });
  const next = await preparedPackage(t, {
    version: "2.0.0",
    requires,
    provides: [{ service: "example.story", apiVersion: "1" }],
    setup: `ctx.onDispose(()=>record('cleanup'));
for(let i=0;i<2;i++){try{ctx.services.get('crewon.tasks','1')}catch{record('caught')}}
ctx.services.provide(ctx.identity.pluginId,'1',{read:()=>null});`,
  });
  const original = await host.activate(first);
  await assert.rejects(host.activate(next), {
    code: "plugin_host_service_binding_failed",
  });
  assert.equal(failedCalls, 1);
  assert.deepEqual(await next.records(), [
    "load",
    "setup",
    "caught",
    "caught",
    "dispose",
    "cleanup",
  ]);
  assert.equal(host.snapshot().length, 1);
  assert.equal(host.snapshot()[0]!.phase, "accepting");
  const lease = host.acquire(
    preparedBorrow(first.expectedPluginId, first.expectedPackageDigest),
  );
  try {
    assert.equal(
      lease.getService<BoundResult>(first.expectedPluginId, "1").read(),
      original,
    );
  } finally {
    lease.release();
  }
});

test("invalid or asynchronous factory results cannot publish a package or leak a rejected promise", async (t) => {
  for (const [index, bindForPlugin] of [
    () => null,
    () => 3,
    () => Promise.reject(new Error("fixture async failure")),
  ].entries()) {
    const host = new PluginNodeHost({
      services: [
        {
          service: "crewon.tasks",
          apiVersion: "1",
          value: {},
          bindForPlugin,
        } as unknown as PluginHostService,
      ],
    });
    t.after(() => host.close());
    const pkg = await preparedPackage(t, {
      pluginId: `example.invalid-${index}`,
      requires,
      setup:
        "ctx.onDispose(()=>record('cleanup')); ctx.services.get('crewon.tasks','1');",
    });
    await assert.rejects(host.activate(pkg), {
      code: "plugin_host_service_binding_failed",
    });
    assert.deepEqual(await pkg.records(), ["load", "setup", "cleanup"]);
    assert.deepEqual(host.snapshot(), []);
  }
  assert.throws(
    () =>
      new PluginNodeHost({
        services: [
          {
            service: "crewon.tasks",
            apiVersion: "1",
            value: {},
            bindForPlugin: "invalid",
          } as unknown as PluginHostService,
        ],
      }),
    { code: "plugin_host_service_binding_invalid" },
  );
});

test("unbound host services and plugin-provided values keep their original value semantics", async (t) => {
  const raw = Object.freeze({ marker: "ordinary" });
  const host = new PluginNodeHost({
    services: [{ service: "host.ordinary", apiVersion: "1", value: raw }],
  });
  t.after(() => host.close());
  const provider = await preparedPackage(t, {
    pluginId: "example.provider",
    provides: [{ service: "example.dependency", apiVersion: "1" }],
    setup:
      "ctx.services.provide('example.dependency','1',{read:()=> 'provided',bindForPlugin(){record('must-not-bind');throw new Error('not a host factory')}});",
  });
  await host.activate(provider);
  const consumer = await preparedPackage(t, {
    pluginId: "example.consumer",
    requires: [
      { service: "example.dependency", apiVersion: "1", optional: false },
      { service: "host.ordinary", apiVersion: "1", optional: false },
    ],
    provides: [{ service: "example.consumer", apiVersion: "1" }],
    setup:
      "const dep=ctx.services.get('example.dependency','1'); const first=ctx.services.get('host.ordinary','1'); const second=ctx.services.get('host.ordinary','1');ctx.services.provide('example.consumer','1',{read:()=>dep.read(),ordinary:()=>first,same:()=>first===second});",
  });
  await host.activate(consumer);
  const lease = host.acquire(
    preparedBorrow(consumer.expectedPluginId, consumer.expectedPackageDigest),
  );
  try {
    const value = lease.getService<{
      read(): string;
      ordinary(): object;
      same(): boolean;
    }>(consumer.expectedPluginId, "1");
    assert.equal(value.read(), "provided");
    assert.equal(value.ordinary(), raw);
    assert.equal(value.same(), true);
    assert.deepEqual(await provider.records(), ["load", "setup"]);
  } finally {
    lease.release();
  }
});
