import assert from "node:assert/strict";
import { parsePluginNodeDefinition } from "@crewon/plugin-sdk/node";
import plugin, { legacyServices } from "./dist/external-optional-node.js";

const identity = Object.freeze({
  pluginId: "example.optional",
  version: "0.1.0",
  packageDigest: `sha256:${"d".repeat(64)}`,
});
const invoke = Object.freeze({
  invocationRef: "fixture-host-invocation",
  contributionId: "workbench",
  action: "generate",
  input: { subject: "fixture" },
});
const receipt = Object.freeze({
  disposition: "committed",
  threadId: "fixture-thread",
  threadRevision: 2,
  runId: "fixture-run",
  messageId: "fixture-message",
  configurationRevision: 1,
});

assert.equal("getOptional" in legacyServices, false);
assert.throws(
  () =>
    parsePluginNodeDefinition(plugin).setup({
      identity,
      services: legacyServices,
      onDispose() {
        assert.fail("unsupported host must fail before resource acquisition");
      },
    }),
  /plugin_optional_service_api_unavailable/u,
);

for (const role of ["tasks", "execution"]) {
  const callbacks = [];
  const provided = new Map();
  const requests = [];
  const factories = [];
  let disposedFactories = 0;
  const available = new Map([
    role === "tasks"
      ? [
          "crewon.tasks",
          {
            createTask: async (request) => {
              requests.push(request);
              return receipt;
            },
          },
        ]
      : [
          "crewon.execution",
          {
            register: (factory) => {
              factories.push(factory);
              return {
                dispose() {
                  disposedFactories++;
                },
              };
            },
          },
        ],
  ]);
  await parsePluginNodeDefinition(plugin).setup(
    Object.freeze({
      identity,
      services: Object.freeze({
        get() {
          assert.fail("optional ABI fixture must not fall back to strict get");
        },
        getOptional(service, version) {
          assert.ok(["crewon.tasks", "crewon.execution"].includes(service));
          assert.equal(version, "1");
          return available.get(service);
        },
        provide(service, version, value) {
          assert.equal(service, identity.pluginId);
          assert.equal(version, "1");
          provided.set(service, value);
          return {
            dispose() {
              provided.delete(service);
            },
          };
        },
      }),
      onDispose(callback) {
        callbacks.push(callback);
      },
    }),
  );
  const actions = provided.get(identity.pluginId);
  assert.ok(actions);
  if (role === "tasks") {
    assert.equal(actions.actions.length, 1);
    assert.deepEqual(await actions.invoke(invoke), receipt);
    assert.deepEqual(requests, [
      {
        invocationRef: invoke.invocationRef,
        threadId: "fixture-thread",
        expectedThreadRevision: 1,
        idempotencyKey: "fixture-optional-task",
        input: invoke.input,
      },
    ]);
    assert.equal(factories.length, 0);
  } else {
    assert.deepEqual(actions.actions, []);
    await assert.rejects(actions.invoke(invoke), /plugin_tasks_unavailable/u);
    assert.equal(requests.length, 0);
    assert.equal(factories.length, 1);
    assert.equal(typeof factories[0].create, "function");
  }
  for (const callback of callbacks.reverse()) await callback();
  assert.equal(provided.size, 0);
  assert.equal(disposedFactories, role === "execution" ? 1 : 0);
}
console.log(
  "Optional service ABI compiled Node-only and invoked in both contexts; old host rejected explicitly.",
);
