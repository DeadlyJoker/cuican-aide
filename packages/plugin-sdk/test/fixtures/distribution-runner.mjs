import assert from "node:assert/strict";
import "./project-foundation-distribution-runner.mjs";
import "./project-source-uploads-distribution-runner.mjs";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import { parsePluginNodeDefinition } from "@crewon/plugin-sdk/node";
import { parsePluginUiDefinition } from "@crewon/plugin-sdk/ui";
import plugin, { events } from "./dist/external-node.js";
import ui from "./dist/external-ui.js";
import taskPlugin from "./dist/external-task-node.js";
import { createHistoricalQueryClient } from "./dist/external-project-historical-query-node.js";
import { createNativeHistoricalQueryClient } from "./dist/external-project-historical-query-ui.js";
import "./execution-distribution-runner.mjs";
import "./optional-distribution-runner.mjs";
import {
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
} from "@crewon/plugin-sdk/node";

const callbacks = [];
const provided = new Map();
const context = Object.freeze({
  identity: Object.freeze({
    pluginId: "example.external",
    version: "0.1.0",
    packageDigest: `sha256:${"a".repeat(64)}`,
  }),
  services: Object.freeze({
    get(service, apiVersion) {
      assert.equal(service, "example.greeting");
      assert.equal(apiVersion, "v1");
      return {
        greet() {
          return "hello from external installation";
        },
      };
    },
    provide(service, apiVersion, value) {
      assert.equal(apiVersion, "v1");
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
});
assert.equal(typeof parsePluginPackageDescriptor, "function");
const instance = await parsePluginNodeDefinition(plugin).setup(context);
assert.deepEqual(provided.get("example.echo").echo({ story: "one" }), {
  greeting: "hello from external installation",
  input: { story: "one" },
});
await instance.dispose();
for (const callback of callbacks.reverse()) await callback();
assert.equal(provided.size, 0);
assert.deepEqual(events, ["setup:example.external", "dispose", "cleanup"]);
// The UI entry is typechecked and structurally validated here; an actual DOM mount belongs to host integration tests.
assert.equal(parsePluginUiDefinition(ui).pluginId, "example.external");
console.log(
  "External installed SDK: Node setup, service ABI and cleanup passed; UI ABI compiled and validated.",
);

// Contract fixture only: this port does not claim real authority, credit admission or Run execution.
const taskCallbacks = [];
const taskServices = new Map();
const requests = [];
const receipt = Object.freeze({
  disposition: "committed",
  threadId: "fixture-thread",
  threadRevision: 2,
  runId: "fixture-run",
  messageId: "fixture-message",
  configurationRevision: 1,
});
await parsePluginNodeDefinition(taskPlugin).setup(
  Object.freeze({
    identity: Object.freeze({
      pluginId: "example.tasks",
      version: "0.1.0",
      packageDigest: `sha256:${"b".repeat(64)}`,
    }),
    services: Object.freeze({
      get(service, apiVersion) {
        assert.equal(service, CREWON_TASKS_SERVICE);
        assert.equal(apiVersion, CREWON_TASKS_API_VERSION);
        return {
          createTask: async (input) => {
            requests.push(input);
            return receipt;
          },
        };
      },
      provide(service, apiVersion, value) {
        assert.equal(service, "example.tasks");
        assert.equal(apiVersion, "1");
        taskServices.set(service, value);
        return {
          dispose() {
            taskServices.delete(service);
          },
        };
      },
    }),
    onDispose(callback) {
      taskCallbacks.push(callback);
    },
  }),
);
const actions = taskServices.get("example.tasks");
assert.deepEqual(actions.actions, [
  {
    contributionId: "workbench",
    action: "image.generate",
    kind: "generateTask",
  },
]);
assert.deepEqual(
  await actions.invoke({
    invocationRef: "fixture-invocation-reference",
    contributionId: "workbench",
    action: "image.generate",
    input: { prompt: "fixture" },
  }),
  receipt,
);
assert.deepEqual(requests, [
  {
    invocationRef: "fixture-invocation-reference",
    threadId: "fixture-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "fixture-task-key",
    input: { prompt: "fixture" },
  },
]);
for (const callback of taskCallbacks.reverse()) await callback();
assert.equal(taskServices.size, 0);
console.log(
  "Task and action ABI compiled and invoked through the isolated installed SDK contract fixture.",
);

const historicalInput = {
  reference: { projectId: "project", assetId: "asset", assetRevision: 1 },
  operationId: "4263a1da-d6fe-eac4-aaec-f05a1e4f7485",
  threadId: "fixture-thread",
  expectedThreadRevision: 1,
  idempotencyKey: "fixture-historical-query",
};
for (const createClient of [
  createHistoricalQueryClient,
  createNativeHistoricalQueryClient,
]) {
  const controller = new AbortController();
  let calls = 0;
  const client = createClient({
    async invoke(action, input, options) {
      calls++;
      assert.equal(
        action,
        "crewon.project-historical-queries.v1.queryConceptGeneration",
      );
      assert.deepEqual(input, historicalInput);
      assert.equal(options.signal, controller.signal);
      return receipt;
    },
  });
  assert.equal(Object.isFrozen(client), true);
  assert.deepEqual(
    await client.queryConceptGeneration(historicalInput, {
      signal: controller.signal,
    }),
    receipt,
  );
  const reason = new Error("external_historical_query_cancelled");
  controller.abort(reason);
  await assert.rejects(
    client.queryConceptGeneration(historicalInput, {
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    client.queryConceptGeneration(historicalInput, {
      signal: { aborted: false, reason: undefined, throwIfAborted() {} },
    }),
    { message: "plugin_project_historical_query_client_invalid" },
  );
  assert.equal(calls, 1);
}
console.log(
  "Historical query client compiled Node-only and with the actual SDK UI service; native cancellation remained enforced.",
);
