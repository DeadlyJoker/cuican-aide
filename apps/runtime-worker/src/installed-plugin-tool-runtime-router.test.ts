import assert from "node:assert/strict";
import test from "node:test";
import type { ToolRuntimePort } from "@crewon/tool-broker";
import { composeInstalledPluginToolRuntime as compose } from "./plugins/installed-plugin-tool-runtime-router.ts";
import {
  brokerFixture,
  catalog,
  committedResult,
  coreNames,
  deferred,
  definition,
  execution,
  lookup,
  ownedExecution,
  pluginName,
  signal,
  tick,
  trackedRuntime,
} from "./installed-plugin-tool-runtime-router.test-support.ts";

test("retains the original complete catalog order and routes policy, execution and recovery to their exact owner", async () => {
  const f = brokerFixture();
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  assert.deepEqual(router.definitions(), catalog);
  assert.equal(
    Reflect.set(router.definitions()[0]!, "description", "caller mutation"),
    true,
  );
  assert.deepEqual(router.definitions(), catalog);
  const context = { sandboxMode: "danger-full-access" as const };
  router.executionPolicy("function", pluginName, context);
  router.executionPolicy("function", coreNames[0], context);
  const pluginCommand = execution(pluginName);
  const baseCommand = execution(coreNames[0]);
  const plugin = await router.execute(pluginCommand, signal());
  const base = await router.execute(baseCommand, signal());
  assert.equal(plugin.status, "completed");
  assert.equal(base.status, "completed");
  await router.reconcile(pluginCommand, signal());
  await router.cancel(baseCommand, signal());
  assert.deepEqual(f.handlers, [
    `plugin:${pluginName}`,
    `base:${coreNames[0]}`,
  ]);
  assert.equal(f.calls.includes("base:reconcile"), false);
  assert.equal(f.calls.includes("plugin:cancel"), false);
  router.acknowledgeExecutionResult!(
    committedResult(pluginCommand, plugin.providerReceiptId),
  );
  router.acknowledgeExecutionResult!(
    committedResult(baseCommand, base.providerReceiptId),
  );
});

test("refuses duplicate, absent, ambiguous or broadened plugin bindings before execution", () => {
  const f = brokerFixture();
  const cases = [
    { ...f, pluginToolNames: [pluginName, pluginName] },
    { ...f, pluginToolNames: ["absent"] },
    {
      ...f,
      pluginToolNames: [pluginName],
      plugin: { ...f.plugin, definitions: () => catalog },
    },
    {
      ...f,
      pluginToolNames: [pluginName],
      plugin: {
        ...f.plugin,
        definitions: () => [
          { ...definition(pluginName), description: "drift" },
        ],
      },
    },
    {
      ...f,
      pluginToolNames: [pluginName],
      base: {
        ...f.base,
        definitions: () => [
          ...catalog,
          {
            schemaVersion: "crewon.tool-definition.v0" as const,
            kind: "custom" as const,
            name: pluginName,
            description: "ambiguous",
            execution: "serial" as const,
            inputFormat: "text" as const,
          },
        ],
      },
    },
  ];
  for (const value of cases)
    assert.throws(
      () => compose(value),
      /installed_plugin_tool_(?:names_invalid|catalog_mismatch)/u,
    );
  assert.deepEqual(f.handlers, []);
});

test("rejects unknown tools or conflicting action identity before delegating", () => {
  const f = brokerFixture();
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  assert.throws(
    () => router.executionPolicy("function", "unknown"),
    /route_not_found/u,
  );
  assert.throws(
    () =>
      router.execute(
        { ...execution(pluginName), name: coreNames[0] },
        signal(),
      ),
    /action_mismatch/u,
  );
  assert.throws(
    () => router.readRetainedExecutionResult!(lookup(execution("unknown"))),
    /route_not_found/u,
  );
  assert.deepEqual(f.handlers, []);
});

test("preserves absent optional capabilities and returns false for a routed owner without acknowledgement", async () => {
  const f = brokerFixture();
  const optional = [
    "reserveExecution",
    "acknowledgeExecutionResult",
    "readRetainedExecutionResult",
    "cancelRetainedExecution",
    "retainedExecutionResults",
    "scanRetainedExecutionResults",
    "canRetire",
  ] as const;
  const bareBase = trackedRuntime(f.baseRaw, "base", f.calls, optional);
  const barePlugin = {
    ...trackedRuntime(f.pluginRaw, "plugin", f.calls, optional),
    reserveExecution: undefined,
  };
  const bare = compose({
    base: bareBase,
    plugin: barePlugin,
    pluginToolNames: [pluginName],
  });
  for (const name of [...optional, "close"] as const)
    assert.equal(bare[name], undefined, name);
  const partial = compose({
    base: f.base,
    plugin: barePlugin,
    pluginToolNames: [pluginName],
  });
  assert.equal(
    partial.reserveExecution!(execution(pluginName), signal()),
    undefined,
  );
  assert.equal(
    partial.acknowledgeExecutionResult!(
      committedResult(execution(pluginName), null),
    ),
    false,
  );
  assert.equal(
    partial.readRetainedExecutionResult!(lookup(execution(pluginName))),
    null,
  );
  assert.equal(
    partial.cancelRetainedExecution!(lookup(execution(pluginName))),
    null,
  );
  assert.equal(partial.canRetire, undefined);
  const command = execution(coreNames[0]);
  const resolution = await partial.execute(command, signal());
  assert.equal(
    partial.acknowledgeExecutionResult!(
      committedResult(command, resolution.providerReceiptId),
    ),
    true,
  );
});

test("routes actual reservations without early execution and releases the reserved owner's capacity", async () => {
  const f = brokerFixture();
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  const reservation = router.reserveExecution!(
    execution(pluginName),
    signal(),
    { resultOwner: { tenantId: "tenant-1" } },
  );
  assert.ok(reservation);
  assert.equal(f.pluginRaw.canRetire(), false);
  assert.equal(f.baseRaw.canRetire(), true);
  assert.deepEqual(f.handlers, []);
  reservation.release();
  assert.equal(f.pluginRaw.canRetire(), true);
  assert.equal(router.canRetire!(), true);
  const command = execution(coreNames[0]);
  const resolution = await ownedExecution(router, command);
  assert.equal(f.baseRaw.canRetire(), false);
  assert.equal(f.pluginRaw.canRetire(), true);
  assert.equal(
    router.acknowledgeExecutionResult!(
      committedResult(command, resolution.providerReceiptId),
    ),
    true,
  );
  assert.equal(router.canRetire!(), true);
});

test("preserves pending physical work until it completes and receives the exact durable acknowledgement", async () => {
  const gate = deferred<{ output: string }>();
  const entered = deferred();
  const f = brokerFixture({
    pluginHandler: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  const command = execution(pluginName);
  const pending = ownedExecution(router, command);
  await entered.promise;
  assert.equal(router.canRetire!(), false);
  assert.equal(router.close, undefined);
  assert.equal(router.readRetainedExecutionResult!(lookup(command)), null);
  assert.deepEqual(
    router.retainedExecutionResults!({
      runId: command.runId,
      limit: 10,
      visibility: "includePending",
    }).map((row) => row.name),
    [pluginName],
  );
  gate.resolve({ output: "eventually completed" });
  const resolution = await pending;
  assert.equal(router.canRetire!(), false);
  assert.equal(
    router.readRetainedExecutionResult!(lookup(command))?.status,
    "completed",
  );
  assert.equal(
    router.acknowledgeExecutionResult!(
      committedResult(command, resolution.providerReceiptId),
    ),
    true,
  );
  assert.equal(router.canRetire!(), true);
  assert.equal(
    f.calls.some((call) => call.endsWith(":close")),
    false,
  );
});

test("retains a replaced tool's legacy base evidence with its original physical owner", async () => {
  const f = brokerFixture();
  const legacy = execution(pluginName, "legacy-base", "legacy-run");
  const old = await ownedExecution(f.base, legacy);
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  assert.deepEqual(
    router.retainedExecutionResults!({ runId: legacy.runId, limit: 10 }),
    [],
  );
  assert.deepEqual(router.scanRetainedExecutionResults!({ limit: 10 }), []);
  assert.equal(router.readRetainedExecutionResult!(lookup(legacy)), null);
  assert.equal(
    f.baseRaw.readRetainedExecutionResult(lookup(legacy))?.status,
    "completed",
  );
  assert.equal(router.canRetire!(), false);
  assert.equal(f.calls.includes("base:acknowledgeExecutionResult"), false);
  assert.equal(f.calls.includes("plugin:acknowledgeExecutionResult"), false);
  assert.equal(
    f.baseRaw.acknowledgeExecutionResult(
      committedResult(legacy, old.providerReceiptId),
    ),
    true,
  );
  assert.equal(router.canRetire!(), true);
});

test("rotates bounded scans and lists so base evidence cannot starve the installed owner", async () => {
  const f = brokerFixture();
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  const commands = [
    execution(coreNames[0]),
    execution(pluginName),
    execution(coreNames[1]),
  ];
  const resolutions = await Promise.all(
    commands.map((command) => ownedExecution(router, command)),
  );
  const scanned = new Set<string>();
  const listed = new Set<string>();
  for (let pass = 0; pass < 8; pass++) {
    for (const row of router.scanRetainedExecutionResults!({ limit: 1 }))
      scanned.add(row.name);
    for (const row of router.retainedExecutionResults!({
      runId: "run-1",
      limit: 1,
    }))
      listed.add(row.name);
  }
  assert.deepEqual([...scanned].sort(), [pluginName, ...coreNames].sort());
  assert.ok(listed.has(pluginName));
  assert.ok(listed.has(coreNames[0]) || listed.has(coreNames[1]));
  for (const [index, command] of commands.entries())
    router.acknowledgeExecutionResult!(
      committedResult(command, resolutions[index]!.providerReceiptId),
    );
  assert.equal(router.canRetire!(), true);
});

test("routes local cancellation to the exact pending owner without closing borrowers", async () => {
  const gate = deferred<{ output: string }>();
  const entered = deferred();
  const f = brokerFixture({
    pluginHandler: async () => {
      entered.resolve();
      return gate.promise;
    },
  });
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  const command = execution(pluginName);
  const pending = ownedExecution(router, command);
  await entered.promise;
  router.cancelRetainedExecution!(lookup(command));
  assert.equal(f.calls.includes("plugin:cancelRetainedExecution"), true);
  assert.equal(f.calls.includes("base:cancelRetainedExecution"), false);
  assert.equal(router.canRetire!(), false);
  const resolution = await pending;
  assert.equal(router.canRetire!(), false);
  assert.equal(
    router.acknowledgeExecutionResult!({
      ...lookup(command),
      status: resolution.status,
      providerReceiptId: resolution.providerReceiptId,
    }),
    false,
  );
  assert.equal(router.canRetire!(), false);
  gate.resolve({ output: "finished after cancellation" });
  await tick();
  assert.equal(router.canRetire!(), true);
  assert.equal(
    f.calls.some((call) => call.endsWith(":close")),
    false,
  );
});

test("rejects unbounded and accessor result pages without acknowledging or releasing source evidence", () => {
  const f = brokerFixture();
  const router = compose({ ...f, pluginToolNames: [pluginName] });
  for (const limit of [0, 129, NaN]) {
    assert.throws(
      () => router.scanRetainedExecutionResults!({ limit }),
      /limit_invalid/u,
    );
    assert.throws(
      () => router.retainedExecutionResults!({ runId: "run-1", limit }),
      /limit_invalid/u,
    );
  }
  let getters = 0;
  const page = [
    Object.defineProperty({}, "name", {
      enumerable: true,
      get() {
        getters++;
        return pluginName;
      },
    }),
  ];
  const bad: ToolRuntimePort = {
    ...f.plugin,
    scanRetainedExecutionResults: () => page as never,
  };
  const guarded = compose({
    base: trackedRuntime(f.baseRaw, "base", f.calls, [
      "scanRetainedExecutionResults",
    ]),
    plugin: bad,
    pluginToolNames: [pluginName],
  });
  assert.throws(() => guarded.scanRetainedExecutionResults!({ limit: 1 }));
  assert.equal(getters, 0);
  assert.equal(
    f.calls.some(
      (call) =>
        call.endsWith(":close") || call.endsWith(":acknowledgeExecutionResult"),
    ),
    false,
  );
});

test("does not run method getters or infer retirement from an unknown proof", async () => {
  const f = brokerFixture();
  let getters = 0;
  const bad = Object.defineProperty({ ...f.plugin }, "canRetire", {
    get() {
      getters++;
      return () => true;
    },
  });
  assert.throws(
    () => compose({ base: f.base, plugin: bad, pluginToolNames: [pluginName] }),
    /runtime_invalid/u,
  );
  assert.equal(getters, 0);
  const router = compose({
    base: f.base,
    plugin: { ...f.plugin, canRetire: () => undefined as never },
    pluginToolNames: [pluginName],
  });
  await tick();
  assert.equal(router.canRetire!(), false);
  assert.equal(router.close, undefined);
});
