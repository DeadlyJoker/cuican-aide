import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  PluginUiActionContext,
  PluginUiCommittedTaskOutcome,
  PluginUiCommittedTaskPort,
} from "@crewon/application";
import {
  pluginRouteActor,
  pluginRouteScope,
} from "./plugin-control-route.test-support.ts";
import { productionPluginUiFixture } from "./production-plugin-ui.test-support.ts";

test("production installed UI uses verified request actors and real HTTPS authority, while unbridged actions stay unavailable", async (t) => {
  const f = await productionPluginUiFixture(t);
  const catalog = await f.app.inject({
    method: "GET",
    url: "/api/v1/plugins/ui/catalog",
    headers: f.authentication.headers,
  });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().plugins.length, 1);
  const lease = await f.open();
  const asset = await f.app.inject({
    method: "GET",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui/entry.mjs`,
    headers: f.authentication.headers,
  });
  assert.equal(asset.statusCode, 200, asset.body);
  assert.equal(asset.body, f.pkg.content["ui/entry.mjs"]);
  assert.equal(asset.headers["cache-control"], "no-store");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  const privateNode = await f.app.inject({
    method: "GET",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/node.mjs`,
    headers: f.authentication.headers,
  });
  assert.equal(privateNode.statusCode, 404);
  const beforeEvents = [...f.source.events];
  const action = await f.app.inject({
    method: "POST",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    headers: f.authentication.headers,
    payload: { action: "counter.increment", input: { delta: 1 } },
  });
  assert.equal(action.statusCode, 409, action.body);
  assert.equal(action.json().error.code, "plugin_ui_actions_unavailable");
  assert.deepEqual(f.source.events, beforeEvents);
  assert.ok(f.authentication.reads() >= 5);
  const profiles = f.authority.state.requests.filter(
    ({ path }) => path === "/profile",
  );
  assert.ok(profiles.length >= 3);
  for (const { body } of profiles)
    assert.deepEqual(body, { actor: pluginRouteActor });
  for (const { body } of f.authority.state.requests.filter(
    ({ path }) => path === "/policy",
  )) {
    assert.deepEqual(body.actor, pluginRouteActor);
    const resource = body.resource as Record<string, unknown>;
    for (const [key, value] of Object.entries(pluginRouteScope))
      assert.equal(resource[key], value);
  }
});

test("production profile mismatch and injected actor headers fail closed without crossing the installed scope", async (t) => {
  const f = await productionPluginUiFixture(t);
  const reads = f.authentication.reads();
  const injected = await f.app.inject({
    method: "GET",
    url: "/api/v1/plugins/ui/catalog",
    headers: { ...f.authentication.headers, "x-crewon-tenant-id": "foreign" },
  });
  assert.equal(injected.statusCode, 403);
  assert.equal(f.authentication.reads(), reads);
  assert.equal(f.authority.state.requests.length, 0);
  f.authority.state.foreignProfile = true;
  const foreign = await f.app.inject({
    method: "GET",
    url: "/api/v1/plugins/ui/catalog",
    headers: f.authentication.headers,
  });
  assert.notEqual(foreign.statusCode, 200);
  assert.equal(
    f.authority.state.requests.filter(({ path }) => path === "/policy").length,
    0,
  );
  assert.ok(!foreign.body.includes(f.pkg.content["ui/entry.mjs"]));
});

test("current authority epochs withdraw prior leases and explicit actions receive the original authorized context", async (t) => {
  const calls: unknown[] = [];
  const f = await productionPluginUiFixture(t, {
    actions: {
      invoke: async (input) => {
        calls.push(input);
        return { accepted: true };
      },
    },
  });
  const lease = await f.open();
  const invoke = () =>
    f.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: f.authentication.headers,
      payload: { action: "allowed.fixture", input: { value: 1 } },
    });
  const first = await invoke();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { output: { accepted: true } });
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { actor: unknown }).actor, pluginRouteActor);
  assert.deepEqual((calls[0] as { scope: unknown }).scope, pluginRouteScope);
  f.authority.state.epoch = "fixture-ui-grant-v2";
  assert.equal((await invoke()).statusCode, 403);
  assert.equal(calls.length, 1);
});

test("approved asset declarations and installed byte pins are checked by the actual local reader", async (t) => {
  const missing = await productionPluginUiFixture(t, {
    publicAssets: ["ui/entry.mjs", "ui/not-declared.mjs"],
  });
  await assert.rejects(
    missing.runtime.service.openMount(pluginRouteActor, {
      pluginId: missing.pkg.expectedPluginId,
      contributionId: "counter",
      expectedPackageDigest: missing.pkg.expectedPackageDigest,
      expectedSelectionRevision: 2,
    }),
    /plugin_ui_publication_result_invalid/u,
  );
  const f = await productionPluginUiFixture(t);
  const lease = await f.open();
  const entry = join(
    f.configuration.installRoot,
    "packages",
    f.pkg.expectedPackageDigest.slice(7),
    "ui/entry.mjs",
  );
  await chmod(entry, 0o600);
  await writeFile(entry, "tampered");
  const asset = await f.app.inject({
    method: "GET",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/assets/ui/entry.mjs`,
    headers: f.authentication.headers,
  });
  assert.notEqual(asset.statusCode, 200);
  assert.ok(!asset.body.includes("tampered"));
});

test("close aborts real HTTPS authority work and prevents a late asset or future lease from succeeding", async (t) => {
  const f = await productionPluginUiFixture(t);
  const lease = await f.open();
  f.authority.state.holdProfile = true;
  const pending = f.runtime.service.readAsset(pluginRouteActor, {
    mountRef: lease.mountRef,
    path: "ui/entry.mjs",
  });
  const rejected = assert.rejects(pending, /plugin_ui_service_unavailable/u);
  await f.authority.held;
  f.runtime.close();
  await rejected;
  assert.ok(f.authority.state.aborts >= 1);
  await assert.rejects(
    f.runtime.service.catalog(pluginRouteActor, {
      afterPluginId: null,
      limit: 10,
    }),
    /plugin_ui_service_unavailable/u,
  );
  f.runtime.close();
});

test("close never returns a late injected action result as a successful public response", async (t) => {
  let entered!: () => void;
  let complete!: () => void;
  const invoked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const f = await productionPluginUiFixture(t, {
    actions: {
      invoke: async () => {
        entered();
        await held;
        return { accepted: true };
      },
    },
  });
  const lease = await f.open();
  const pending = f.app.inject({
    method: "POST",
    url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
    headers: f.authentication.headers,
    payload: { action: "allowed.fixture", input: {} },
  });
  await invoked;
  f.runtime.close();
  const response = await pending;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().error.code, "plugin_ui_service_unavailable");
  complete();
  await held;
});

for (const committed of [true, false])
  test(`production close ${committed ? "preserves verified accepted task output" : "fences ordinary JSON with a committed-task verifier configured"}`, async (t) => {
    let entered!: () => void;
    let complete!: () => void;
    const invoked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      complete = resolve;
    });
    // This fixture tests lifecycle composition of a trusted verifier. Real SQL receipt validation
    // lives in Application and the installed ESM + SQLite task bridge integration suite.
    const outcomes = new WeakMap<object, PluginUiActionContext>();
    const receipt = Object.freeze({
      disposition: "committed",
      threadId: "fixture-thread",
      threadRevision: 2,
      runId: "fixture-original-run",
      messageId: "fixture-message",
      configurationRevision: 1,
    });
    const verifier: PluginUiCommittedTaskPort = {
      isOutcome(input): input is PluginUiCommittedTaskOutcome {
        return (
          input !== null && typeof input === "object" && outcomes.has(input)
        );
      },
      verify(context, outcome) {
        assert.equal(outcomes.get(outcome), context);
        outcomes.delete(outcome);
        return receipt;
      },
    };
    const f = await productionPluginUiFixture(t, {
      committedTasks: verifier,
      actions: {
        async invoke(context) {
          const outcome = Object.freeze(
            Object.create(null),
          ) as PluginUiCommittedTaskOutcome;
          outcomes.set(outcome, context);
          entered();
          await held;
          return committed ? outcome : { accepted: true };
        },
      },
    });
    const lease = await f.open();
    const pending = f.app.inject({
      method: "POST",
      url: `/api/v1/plugins/ui/mounts/${lease.mountRef}/actions`,
      headers: f.authentication.headers,
      payload: { action: "allowed.fixture", input: {} },
    });
    await invoked;
    f.runtime.close();
    complete();
    const response = await pending;
    assert.equal(response.statusCode, committed ? 200 : 409, response.body);
    if (committed) assert.deepEqual(response.json(), { output: receipt });
    else
      assert.equal(response.json().error.code, "plugin_ui_service_unavailable");
  });
