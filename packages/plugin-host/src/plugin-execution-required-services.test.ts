import assert from "node:assert/strict";
import test from "node:test";
import type { PluginExecutionServices } from "@crewon/plugin-sdk/node";
import { PluginExecutionRegistry } from "./plugin-execution-registry.ts";
import { PluginNodeHost } from "./plugin-node-host.ts";
import { preparedBorrow } from "./plugin-node-preparation.test-support.ts";
import {
  executionContext,
  executionPackage,
  runtimeSource,
} from "./plugin-execution-registry.test-support.ts";

const unusedMethod = async () => {
  throw new Error("test-service-must-not-dispatch");
};
const services: PluginExecutionServices = Object.freeze({
  approvalRequirement: "none",
  externalOperations: Object.freeze({
    reserve: unusedMethod,
    load: unusedMethod,
    advance: unusedMethod,
  }),
  jsonHttp: Object.freeze({ request: unusedMethod }),
});

test("actual installed registry freezes declared requirements and rejects missing methods before the original business factory", async (t) => {
  const registry = new PluginExecutionRegistry(),
    host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    setup: `const required=['externalOperations','jsonHttp'];const original={requiredServices:required,create(input,services){if(this!==original)throw new Error('receiver-lost');record('business-create');return ${runtimeSource}}};
ctx.services.get('crewon.execution','1').register(original);
required.reverse();required.push('undeclared');original.requiredServices=['jsonHttp'];original.create=()=>{throw new Error('mutated-create')};`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  try {
    const factory = registry.acquire(lease),
      context = executionContext(lease.identity);
    assert.deepEqual(factory.requiredServices, [
      "externalOperations",
      "jsonHttp",
    ]);
    assert.equal(Object.isFrozen(factory), true);
    assert.equal(Object.isFrozen(factory.requiredServices), true);
    assert.throws(
      () => (factory.requiredServices as string[]).push("jsonHttp"),
      TypeError,
    );
    assert.equal(Reflect.set(factory, "requiredServices", []), false);
    assert.equal(
      registry.acquire(lease).requiredServices,
      factory.requiredServices,
    );
    for (const incomplete of [
      undefined,
      { approvalRequirement: "none" },
      { ...services, externalOperations: undefined },
      { ...services, jsonHttp: undefined },
      ...["reserve", "load", "advance"].map((method) => ({
        ...services,
        externalOperations: { ...services.externalOperations, [method]: null },
      })),
      { ...services, jsonHttp: { request: true } },
    ])
      assert.throws(
        () =>
          factory.create(
            context,
            incomplete as PluginExecutionServices | undefined,
          ),
        { code: "plugin_execution_required_services_unavailable" },
      );
    let getters = 0;
    const getterPort = Object.defineProperty(
      { approvalRequirement: "none", jsonHttp: services.jsonHttp },
      "externalOperations",
      {
        get() {
          getters++;
          return services.externalOperations;
        },
      },
    );
    const getterMethod = Object.defineProperty(
      { reserve: unusedMethod, load: unusedMethod },
      "advance",
      {
        get() {
          getters++;
          return unusedMethod;
        },
      },
    );
    assert.throws(
      () => factory.create(context, getterPort as PluginExecutionServices),
      { code: "plugin_execution_required_services_unavailable" },
    );
    assert.throws(
      () =>
        factory.create(context, {
          ...services,
          externalOperations: getterMethod,
        } as unknown as PluginExecutionServices),
      { code: "plugin_execution_required_services_unavailable" },
    );
    assert.equal(getters, 0);
    assert.deepEqual(await pkg.records(), ["load", "setup"]);
    const runtime = await factory.create(context, services);
    assert.deepEqual(await pkg.records(), ["load", "setup", "business-create"]);
    await runtime.close?.();
  } finally {
    lease.release();
  }
});

test("a declared single service accepts actual class data methods without requiring the other service", async (t) => {
  const registry = new PluginExecutionRegistry(),
    host = new PluginNodeHost({ services: [registry.hostService()] });
  t.after(() => host.close());
  const pkg = await executionPackage(t, {
    setup: `ctx.services.get('crewon.execution','1').register({requiredServices:['jsonHttp'],create(){record('business-create');return ${runtimeSource}}});`,
  });
  await host.activate(pkg);
  const lease = host.acquire(
    preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
  );
  class JsonHttp {
    async request(): Promise<never> {
      throw new Error("test-service-must-not-dispatch");
    }
  }
  try {
    const factory = registry.acquire(lease);
    assert.deepEqual(factory.requiredServices, ["jsonHttp"]);
    const runtime = await factory.create(executionContext(lease.identity), {
      approvalRequirement: "none",
      jsonHttp: new JsonHttp(),
    });
    assert.deepEqual(await pkg.records(), ["load", "setup", "business-create"]);
    await runtime.close?.();
  } finally {
    lease.release();
  }
});

test("legacy omission and an explicit empty requirement list keep no-services creation compatible", async (t) => {
  for (const [index, requirement] of ["", "requiredServices:[],"].entries()) {
    const registry = new PluginExecutionRegistry(),
      host = new PluginNodeHost({ services: [registry.hostService()] });
    t.after(() => host.close());
    const pkg = await executionPackage(t, {
      pluginId: `example.compatible-requirement-${index}`,
      setup: `ctx.services.get('crewon.execution','1').register({${requirement}create(){record('legacy-create');return ${runtimeSource}}});`,
    });
    await host.activate(pkg);
    const lease = host.acquire(
      preparedBorrow(pkg.expectedPluginId, pkg.expectedPackageDigest),
    );
    try {
      const factory = registry.acquire(lease);
      assert.deepEqual(factory.requiredServices, index === 0 ? undefined : []);
      const runtime = await factory.create(executionContext(lease.identity));
      assert.deepEqual(await pkg.records(), ["load", "setup", "legacy-create"]);
      await runtime.close?.();
    } finally {
      lease.release();
    }
  }
});

const invalidRequirements = [
  [
    "getter",
    `{get requiredServices(){record('getter');return ['jsonHttp']},create(){return null}}`,
  ],
  [
    "hidden",
    `Object.defineProperty({create(){return null}},'requiredServices',{value:['jsonHttp']})`,
  ],
  ["undefined", `{requiredServices:undefined,create(){return null}}`],
  ["null", `{requiredServices:null,create(){return null}}`],
  ["unknown", `{requiredServices:['network'],create(){return null}}`],
  [
    "duplicate",
    `{requiredServices:['jsonHttp','jsonHttp'],create(){return null}}`,
  ],
  ["sparse", `{requiredServices:[,'jsonHttp'],create(){return null}}`],
  [
    "item getter",
    `{requiredServices:Object.defineProperty(['jsonHttp'],'0',{get(){record('item-getter');return 'jsonHttp'}}),create(){return null}}`,
  ],
  [
    "hidden item",
    `{requiredServices:Object.defineProperty(['jsonHttp'],'0',{value:'jsonHttp',enumerable:false}),create(){return null}}`,
  ],
  [
    "extra field",
    `{requiredServices:Object.assign(['jsonHttp'],{extra:true}),create(){return null}}`,
  ],
  [
    "hidden field",
    `{requiredServices:Object.defineProperty(['jsonHttp'],'hidden',{value:true}),create(){return null}}`,
  ],
  [
    "symbol hook",
    `{requiredServices:Object.assign(['jsonHttp'],{[Symbol.iterator](){record('iterator')}}),create(){return null}}`,
  ],
  [
    "custom prototype",
    `{requiredServices:Object.setPrototypeOf(['jsonHttp'],Object.create(Array.prototype)),create(){return null}}`,
  ],
  [
    "over bound",
    `{requiredServices:['externalOperations','jsonHttp','jsonHttp'],create(){return null}}`,
  ],
] as const;
for (const [index, [name, factory]] of invalidRequirements.entries())
  test(`actual installed registry rejects ${name} requirements without executing hooks or creating a runtime`, async (t) => {
    const registry = new PluginExecutionRegistry(),
      host = new PluginNodeHost({ services: [registry.hostService()] });
    t.after(() => host.close());
    const pkg = await executionPackage(t, {
      pluginId: `example.invalid-requirement-${index}`,
      setup: `ctx.services.get('crewon.execution','1').register(${factory});`,
    });
    await assert.rejects(host.activate(pkg), {
      code: "plugin_execution_factory_invalid",
    });
    assert.deepEqual(await pkg.records(), ["load", "setup"]);
    assert.deepEqual(host.snapshot(), []);
  });
