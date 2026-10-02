import assert from "node:assert/strict";
import { parsePluginPackageDescriptor } from "@crewon/plugin-sdk/contracts";
import { parsePluginNodeDefinition } from "@crewon/plugin-sdk/node";
import { parsePluginUiDefinition } from "@crewon/plugin-sdk/ui";
import plugin, { events } from "./dist/external-node.js";
import ui from "./dist/external-ui.js";

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
