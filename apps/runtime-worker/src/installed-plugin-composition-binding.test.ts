import assert from "node:assert/strict";
import test from "node:test";
import { composedTurnFixture } from "../../../packages/store/src/plugin-run-composition.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
/** A persisted graph must never be treated as the current private, single-package execution host. */
test("installed Run context refuses composed execution until a real original-lock assembly is supported", async (t) => {
  const f = await composedTurnFixture(t, "sqlite");
  await f.first.store.commitExtensionTurn(f.input);
  let authorizations = 0;
  const reader = new InstalledPluginRunContext({
    extensions: f.first.store,
    runs: f.first.parent,
    installations: f.installations,
    authorization: {
      async authorize() {
        authorizations++;
        return { outcome: "allow" };
      },
    },
    async resolveActor() {
      return f.actor;
    },
  });
  await assert.rejects(
    reader.load({
      locator: {
        tenantId: f.input.binding.tenantId,
        spaceId: f.input.binding.spaceId,
        runId: f.input.binding.runId,
      },
      expectedTarget: f.input.binding.target,
      purpose: "submit",
      signal: new AbortController().signal,
    }),
    /installed_plugin_composition_execution_unavailable/,
  );
  assert.equal(authorizations, 0);
  assert.equal(await f.count("plugin_credit_reservations"), 1);
});
