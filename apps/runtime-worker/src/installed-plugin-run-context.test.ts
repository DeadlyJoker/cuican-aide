import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionRunBinding, type RunState } from "@crewon/domain";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunSnapshot,
} from "./plugins/installed-plugin-run-context.ts";
import {
  actor,
  target,
  signal,
  installedRunContextFixture,
} from "./installed-plugin-run-context.test-support.ts";

test("installed Run context reads the real paid task, exact original package/config and survives a database reopen without writes", async (t) => {
  const f = await installedRunContextFixture(t);
  const before = await f.counts();
  const snapshot = await f.load();
  assert.ok(snapshot);
  assert.equal(snapshot.context.identity.packageDigest, f.pin.packageDigest);
  assert.deepEqual(snapshot.context.scope, f.profile);
  assert.equal(snapshot.context.run.runId, f.task.binding.runId);
  assert.equal(
    snapshot.context.run.bindingDigest,
    f.task.binding.bindingDigest,
  );
  assert.equal(
    snapshot.context.configuration.revision,
    f.task.binding.configurationRevision,
  );
  assert.equal(
    snapshot.context.configuration.contentDigest,
    f.task.binding.configurationDigest,
  );
  assert.deepEqual(snapshot.context.configuration.parameters, {
    format: "mp4",
  });
  assert.deepEqual(snapshot.context.target, target);
  assert.ok(Object.isFrozen(snapshot.context.configuration.parameters));
  assert.deepEqual(
    f.controls.requests.map((request) => request.action),
    ["run:execute", "extension:run"],
  );
  const reopened = await f.open();
  const reader = new InstalledPluginRunContext({
    ...f.dependencies,
    extensions: reopened.store,
    runs: reopened.parent,
    installations: reopened.parent.pluginInstallationStore(),
  });
  assert.deepEqual(await f.load("observe", reader), snapshot);
  await f.reader.assertCurrent(snapshot, "observe", signal());
  assert.deepEqual(await f.counts(), before);
  assert.equal(
    (await f.credits.getAccount(f.creditScope))?.reservedCredits,
    "30",
  );
});

test("an actual v0 task with no installed pin returns null while unsupported adapters fail closed", async (t) => {
  const f = await installedRunContextFixture(t);
  const threadId = "installed-context-v0-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const legacy = await f.tasks.createTask(actor, {
    pluginId: f.pin.pluginId,
    threadId,
    expectedThreadRevision: 1,
    idempotencyKey: "legacy-context",
    intent: { kind: "generate", input: { prompt: "old v0 path" } },
  });
  const before = f.controls.requests.length;
  assert.equal(
    await f.reader.load({
      locator: {
        tenantId: legacy.binding.tenantId,
        spaceId: legacy.binding.spaceId,
        runId: legacy.binding.runId,
      },
      expectedTarget: target,
      purpose: "submit",
      signal: signal(),
    }),
    null,
  );
  assert.equal(f.controls.requests.length, before);
  const unsupported = new Proxy(f.first.store, {
    get(source, key) {
      if (key === "pluginAdmissionVersion") return undefined;
      const value = Reflect.get(source, key, source) as unknown;
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
  assert.throws(
    () =>
      new InstalledPluginRunContext({
        ...f.dependencies,
        extensions: unsupported,
      }),
    /installed_plugin_context_port_unavailable/,
  );
});

test("a newer selected package never substitutes for the old admitted package or changes the pin", async (t) => {
  const f = await installedRunContextFixture(t);
  const original = await f.load();
  assert.ok(original);
  const recipe = installationRecipe("installed-context-v2", {
    scope: f.profile,
    actor,
    pluginId: f.pin.pluginId,
    version: "0.2.0",
    expectedSelectionRevision: f.enabled.selection.revision,
  });
  const next = await f.installations.recordInstalledPackage(recipe);
  await f.installations.commitSelection(
    selectionRecipe(next.selection, "installed-context-select-v2", {
      actor,
      packageDigest: recipe.package.packageDigest,
    }),
  );
  assert.deepEqual(await f.load("observe"), original);
  await f.reader.assertCurrent(original, "observe", signal());
  assert.equal(
    (await f.first.store.loadPluginTaskAdmission(f.task.binding))
      ?.packageDigest,
    f.pin.packageDigest,
  );
});

test("current owner identity must retain the original principal, actor and tenant/space", async (t) => {
  const f = await installedRunContextFixture(t);
  const snapshot = await f.load();
  assert.ok(snapshot);
  for (const changed of [
    null,
    { ...actor, principalId: "other-principal" },
    { ...actor, actorId: "other-actor" },
    { ...actor, tenantId: "other-tenant" },
    { ...actor, spaceId: "other-space" },
  ]) {
    f.controls.actor = changed;
    await assert.rejects(
      f.load("observe"),
      /installed_plugin_execution_identity_unavailable/,
    );
    await assert.rejects(
      f.reader.assertCurrent(snapshot, "observe", signal()),
      /installed_plugin_execution_identity_unavailable/,
    );
  }
});

test("each operation rechecks run execution and the actual submit/observe permission", async (t) => {
  const f = await installedRunContextFixture(t);
  const snapshot = await f.load();
  assert.ok(snapshot);
  for (const [action, purpose] of [
    ["run:execute", "observe"],
    ["extension:run", "submit"],
    ["extension:query", "observe"],
  ] as const) {
    f.controls.denied = action;
    await assert.rejects(
      f.reader.assertCurrent(snapshot, purpose, signal()),
      /installed_plugin_execution_access_denied/,
    );
  }
});

test("disabled configuration blocks new submissions, permits authorized observation and revoked blocks both", async (t) => {
  const f = await installedRunContextFixture(t);
  const snapshot = await f.load();
  assert.ok(snapshot);
  await f.state("disabled");
  await assert.rejects(f.load(), /installed_plugin_generation_disabled/);
  await assert.rejects(
    f.reader.assertCurrent(snapshot, "submit", signal()),
    /installed_plugin_generation_disabled/,
  );
  assert.ok(await f.load("observe"));
  await f.reader.assertCurrent(snapshot, "observe", signal());
  await f.state("revoked");
  for (const purpose of ["submit", "observe"] as const)
    await assert.rejects(
      f.reader.assertCurrent(snapshot, purpose, signal()),
      /installed_plugin_access_revoked/,
    );
});

test("a current permission await cannot retain access after activation or principal changes", async (t) => {
  const f = await installedRunContextFixture(t);
  f.controls.authorizeHook = async (request) => {
    if (request.action === "extension:run") await f.state("revoked");
  };
  await assert.rejects(f.load(), /installed_plugin_access_revoked/);
  await f.state("enabled");
  f.controls.authorizeHook = async (request) => {
    if (request.action === "extension:run")
      f.controls.actor = { ...actor, principalId: "new-principal" };
  };
  await assert.rejects(
    f.load(),
    /installed_plugin_execution_identity_unavailable/,
  );
});

test("the explicit verified base target must match every immutable saved target field", async (t) => {
  const f = await installedRunContextFixture(t);
  for (const changed of [
    {
      ...target,
      agentVersionContentDigest: extensionStoreDigester.sha256("changed agent"),
    },
    {
      ...target,
      materializationDigest: extensionStoreDigester.sha256("changed runtime"),
    },
    { ...target, agentVersionId: "other-agent" },
    { ...target, authorityId: "other-authority" },
    { ...target, runtimeGeneration: "other-generation" },
    { ...target, policySnapshotId: "other-policy" },
    { ...target, workspaceBindingId: "other-workspace" },
  ])
    await assert.rejects(
      f.reader.load({
        locator: f.locator,
        expectedTarget: changed,
        purpose: "observe",
        signal: signal(),
      }),
      /installed_plugin_target_mismatch/,
    );
  for (const scope of [
    { ...f.locator, tenantId: "other-tenant" },
    { ...f.locator, spaceId: "other-space" },
  ])
    assert.equal(
      await f.reader.load({
        locator: scope,
        expectedTarget: target,
        purpose: "observe",
        signal: signal(),
      }),
      null,
    );
});

for (const changed of ["authorityId", "createdByActorId", "purpose"] as const) {
  test(`actual persisted Run ${changed} drift is rejected before execution`, async (t) => {
    const f = await installedRunContextFixture(t);
    const run = await f.first.parent.loadRunInSpace(f.task.binding);
    assert.ok(run);
    await f.updateJson("run_snapshots", "state_json", {
      ...run,
      [changed]: changed === "purpose" ? "manualCompaction" : "different-owner",
    });
    await assert.rejects(f.load("observe"));
  });
}

test("the original task receipt key/digest and immutable binding are crosschecked", async (t) => {
  const f = await installedRunContextFixture(t);
  await f.sql(
    `UPDATE extension_mutation_receipts SET request_digest='${extensionStoreDigester.sha256("wrong request")}' WHERE kind='task'`,
  );
  await assert.rejects(f.load(), /extension_idempotency_conflict/);
});

test("a well-formed receipt for a different immutable binding cannot supply this Run's context", async (t) => {
  const f = await installedRunContextFixture(t);
  const changed = createExtensionRunBinding(
    {
      ...f.task.binding,
      inputDigest: extensionStoreDigester.sha256("different input"),
    },
    extensionStoreDigester,
  );
  await f.updateJson("extension_mutation_receipts", "result_json", {
    ...f.task,
    binding: changed,
  });
  await assert.rejects(
    f.load(),
    /extension_credit_admission_identity_mismatch/,
  );
});

test("a corrupted persisted pin cannot claim another package version or receipt key", async (t) => {
  const f = await installedRunContextFixture(t);
  // Administrative corruption fixture: immutable history is normally protected by this trigger.
  await f.sql("DROP TRIGGER plugin_task_admissions_no_update");
  await f.updateJson("plugin_task_admissions", "admission_json", {
    ...f.admission,
    version: "9.0.0",
  });
  await assert.rejects(f.load());
  await f.updateJson("plugin_task_admissions", "admission_json", {
    ...f.admission,
    idempotencyKey: "missing-original-key",
  });
  await assert.rejects(f.load(), /installed_plugin_task_receipt_missing/);
});

test("v1 source query metadata is rejected explicitly instead of silently using a generation runtime", async (t) => {
  const f = await installedRunContextFixture(t);
  const source = {
    runId: "original-source-run",
    operationId: "source-operation",
    bindingDigest: extensionStoreDigester.sha256("source"),
  };
  const binding = createExtensionRunBinding(
    { ...f.task.binding, source },
    extensionStoreDigester,
  );
  await f.sql(
    `UPDATE extension_run_bindings SET binding_json='${JSON.stringify(binding)}'`,
  );
  await f.sql("DROP TRIGGER plugin_task_admissions_no_update");
  const admission = {
    ...f.admission,
    extensionBindingDigest: binding.bindingDigest,
  };
  await f.sql(
    `UPDATE plugin_task_admissions SET extension_binding_digest='${binding.bindingDigest}',admission_json='${JSON.stringify(admission)}'`,
  );
  await assert.rejects(
    f.load("observe"),
    /plugin_task_admission_binding_mismatch/,
  );
});

test("only issued snapshots work, input/Store getters never execute and an aborted native signal performs no writes", async (t) => {
  const f = await installedRunContextFixture(t);
  const snapshot = await f.load();
  assert.ok(snapshot);
  await assert.rejects(
    f.reader.assertCurrent(
      { context: snapshot.context } as InstalledPluginRunSnapshot,
      "submit",
      signal(),
    ),
    /installed_plugin_context_snapshot_invalid/,
  );
  let hooks = 0;
  const input = {
    locator: f.locator,
    expectedTarget: target,
    purpose: "submit" as const,
    signal: signal(),
  };
  Object.defineProperty(input, "expectedTarget", {
    enumerable: true,
    get() {
      hooks++;
      return target;
    },
  });
  await assert.rejects(
    f.reader.load(input),
    /installed_plugin_context_fields_invalid/,
  );
  const run = await f.first.parent.loadRunInSpace(f.task.binding);
  assert.ok(run);
  const poisoned = { ...run };
  Object.defineProperty(poisoned, "authorityId", {
    enumerable: true,
    get() {
      hooks++;
      return target.authorityId;
    },
  });
  // The actual SQLite read still occurs; this proxy injects a bad returned record, not a fake Run store.
  const runs = new Proxy(f.first.parent, {
    get(source, key) {
      if (key === "loadRunInSpace")
        return async (
          locator: Parameters<typeof source.loadRunInSpace>[0],
        ): Promise<RunState | null> => {
          await source.loadRunInSpace(locator);
          return poisoned;
        };
      const value = Reflect.get(source, key, source) as unknown;
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
  const reader = new InstalledPluginRunContext({ ...f.dependencies, runs });
  await assert.rejects(
    f.load("submit", reader),
    /installed_plugin_run_authority_mismatch/,
  );
  assert.equal(hooks, 0);
  const before = await f.counts();
  const controller = new AbortController();
  const reason = new Error("fixture-current-lease-lost");
  controller.abort(reason);
  await assert.rejects(
    f.reader.load({
      locator: f.locator,
      expectedTarget: target,
      purpose: "submit",
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
  assert.deepEqual(await f.counts(), before);
});
