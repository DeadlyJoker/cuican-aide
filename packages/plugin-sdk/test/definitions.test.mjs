import assert from "node:assert/strict";
import test from "node:test";
import {
  definePlugin,
  parsePluginNodeDefinition,
  PluginSdkContractError,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
} from "../dist/node.js";
import {
  defineUiPlugin,
  parsePluginUiDefinition,
  PluginSdkContractError as UiError,
} from "../dist/ui.js";
import {
  parsePluginPackageDescriptor,
  CREWON_TASKS_SERVICE as ContractsTaskService,
  CREWON_TASKS_API_VERSION as ContractsTaskVersion,
} from "../dist/contracts.js";

test("Node and pure contract entries export the same explicit task service protocol", () => {
  assert.equal(CREWON_TASKS_SERVICE, "crewon.tasks");
  assert.equal(CREWON_TASKS_API_VERSION, "1");
  assert.equal(ContractsTaskService, CREWON_TASKS_SERVICE);
  assert.equal(ContractsTaskVersion, CREWON_TASKS_API_VERSION);
});

test("compiled entry helpers freeze detached exact definitions without calling plugin code", () => {
  let calls = 0;
  const setup = () => {
    calls++;
  };
  const mount = () => {
    calls++;
    return { update() {}, dispose() {} };
  };
  const input = {
    apiVersion: "crewon.plugin-host.v1",
    pluginId: "example.plugin",
    setup,
  };
  const node = definePlugin(input);
  const ui = defineUiPlugin({
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: "example.plugin",
    mount,
  });
  assert.equal(calls, 0);
  assert.notEqual(node, input);
  assert.ok(Object.isFrozen(node));
  assert.ok(Object.isFrozen(ui));
  assert.equal(node.setup, setup);
  input.pluginId = "mutated.plugin";
  assert.equal(node.pluginId, "example.plugin");
  assert.equal(PluginSdkContractError, UiError);
  assert.equal(typeof parsePluginPackageDescriptor, "function");
});

test("Node and UI validation reject protocol drift, malformed identities, extra authorities and missing hooks", () => {
  const node = {
    apiVersion: "crewon.plugin-host.v1",
    pluginId: "example.plugin",
    setup() {},
  };
  const ui = {
    apiVersion: "crewon.plugin-ui.v1",
    pluginId: "example.plugin",
    mount() {},
  };
  for (const invalid of [
    null,
    [],
    { ...node, apiVersion: "crewon.plugin-host.v0" },
    { ...node, pluginId: "bad id" },
    { ...node, pluginId: "a".repeat(129) },
    { ...node, setup: null },
    { ...node, actorId: "client-owner" },
    { ...node, requires: [] },
    { ...node, providedDescriptor: {} },
    { ...node, setup: undefined },
  ])
    assert.throws(
      () => parsePluginNodeDefinition(invalid),
      PluginSdkContractError,
    );
  for (const invalid of [
    { ...ui, apiVersion: "crewon.plugin-host.v1" },
    { ...ui, mount: "script" },
    { ...ui, globalSession: {} },
  ])
    assert.throws(
      () => parsePluginUiDefinition(invalid),
      PluginSdkContractError,
    );
});

test("definition validation never invokes accessors, iterators or toJSON and rejects hidden or inherited fields", () => {
  let calls = 0;
  const hook = () => {
    calls++;
    throw new Error("must not execute");
  };
  const node = {
    apiVersion: "crewon.plugin-host.v1",
    pluginId: "example.plugin",
    setup() {},
  };
  const getter = { ...node };
  Object.defineProperty(getter, "setup", { enumerable: true, get: hook });
  const hidden = { ...node };
  Object.defineProperty(hidden, "pluginId", {
    value: "example.plugin",
    enumerable: false,
  });
  for (const value of [
    getter,
    hidden,
    { ...node, toJSON: hook },
    { ...node, [Symbol.iterator]: hook },
    Object.assign(Object.create({ setup: hook }), node),
  ])
    assert.throws(
      () => parsePluginNodeDefinition(value),
      PluginSdkContractError,
    );
  const ui = { apiVersion: "crewon.plugin-ui.v1", pluginId: "example.plugin" };
  Object.defineProperty(ui, "mount", { enumerable: true, get: hook });
  assert.throws(() => parsePluginUiDefinition(ui), PluginSdkContractError);
  assert.equal(calls, 0);
  assert.equal(
    parsePluginNodeDefinition(Object.assign(Object.create(null), node))
      .pluginId,
    "example.plugin",
  );
});

test("compiled Node definitions support async setup and the host-owned cleanup ABI", async () => {
  const callbacks = [];
  const log = [];
  const value = { greet: () => "hello" };
  const provided = new Map();
  const context = Object.freeze({
    identity: Object.freeze({
      pluginId: "example.plugin",
      version: "0.1.0",
      packageDigest: `sha256:${"a".repeat(64)}`,
    }),
    services: Object.freeze({
      get(service, apiVersion) {
        assert.equal(service, "example.greeting");
        assert.equal(apiVersion, "v1");
        return value;
      },
      provide(service, apiVersion, implementation) {
        assert.equal(service, "example.echo");
        assert.equal(apiVersion, "v1");
        provided.set(service, implementation);
        return {
          dispose() {
            provided.delete(service);
            log.push("unregister");
          },
        };
      },
    }),
    onDispose(callback) {
      callbacks.push(callback);
    },
  });
  const plugin = definePlugin({
    apiVersion: "crewon.plugin-host.v1",
    pluginId: "example.plugin",
    async setup(ctx) {
      assert.equal(ctx.identity.pluginId, "example.plugin");
      const greeting = ctx.services.get("example.greeting", "v1");
      const registration = ctx.services.provide("example.echo", "v1", {
        reply: greeting.greet,
      });
      ctx.onDispose(() => registration.dispose());
      return {
        async dispose() {
          log.push("plugin-dispose");
        },
      };
    },
  });
  const disposable = await plugin.setup(context);
  assert.equal(provided.get("example.echo").reply(), "hello");
  await disposable.dispose();
  for (const callback of callbacks.reverse()) await callback();
  assert.deepEqual(log, ["plugin-dispose", "unregister"]);
  assert.equal(provided.size, 0);
});
