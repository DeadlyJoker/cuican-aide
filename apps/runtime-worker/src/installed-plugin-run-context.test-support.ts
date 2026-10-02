import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ExtensionTaskApplicationService,
  type ActorContext,
  type AuthorizationAction,
  type AuthorizationPort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  actor,
  saveCommand,
  activateCommand,
  configurationServiceFixture,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  scope,
  target,
  timestamp,
  receipt,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  InstalledPluginRunContext,
  type InstalledPluginRunContextDependencies,
} from "./plugins/installed-plugin-run-context.ts";

export { actor, target };
export const signal = () => new AbortController().signal;

/** Actual SQLite + original task service. Deployment and current authorization are explicit fixtures. */
export async function installedRunContextFixture(t: TestContext) {
  const f = await configurationServiceFixture(t, "sqlite");
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const threadId = "installed-context-thread";
  await seedThread(f.first.parent, { ...actor, threadId });
  const installations = f.first.parent.pluginInstallationStore();
  await installations.migrate();
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "installed-context-profile",
  };
  const recipe = installationRecipe("installed-context-package", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
    version: "0.1.0",
  });
  const installed = await installations.recordInstalledPackage(recipe);
  const enabled = await installations.commitSelection(
    selectionRecipe(installed.selection, "installed-context-enabled", {
      actor,
    }),
  );
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "installed-context-fixture",
  };
  const credits = f.first.parent.pluginCreditStore();
  // Fixture funding/quote only; not a product price or payment policy.
  await credits.grant({
    scope: creditScope,
    grantId: "installed-context-funding",
    credits: "100",
  });
  const tasks = new ExtensionTaskApplicationService({
    ...f.dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
    creditQuotes: {
      quoteGeneration: async () => ({
        poolId: creditScope.poolId,
        priceRevision: 1,
        quotedCredits: "30",
      }),
    },
  });
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...profile,
    pluginId: scope.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    contributionId: "workbench",
    action: "image.generate",
    authorityEpoch: "fixture-original-epoch",
  });
  const task = await tasks.createTaskFromPlugin(
    actor,
    {
      pluginId: scope.pluginId,
      threadId,
      expectedThreadRevision: 1,
      idempotencyKey: "installed-context-task",
      intent: {
        kind: "generate",
        input: { prompt: "Persisted installed context fixture." },
      },
    },
    pin,
  );
  const admission = await f.first.store.loadPluginTaskAdmission(task.binding);
  assert.ok(admission);
  const controls = {
    actor: actor as ActorContext | null,
    denied: null as AuthorizationAction | null,
    requests: [] as Parameters<AuthorizationPort["authorize"]>[0][],
    authorizeHook: null as
      | null
      | ((
          request: Parameters<AuthorizationPort["authorize"]>[0],
        ) => Promise<void>),
    resolveHook: null as null | (() => Promise<void>),
  };
  const dependencies: InstalledPluginRunContextDependencies = {
    extensions: f.first.store,
    runs: f.first.parent,
    installations,
    authorization: {
      async authorize(request) {
        controls.requests.push(request);
        await controls.authorizeHook?.(request);
        return request.action === controls.denied
          ? { outcome: "deny", reasonCode: "fixture_denied" }
          : { outcome: "allow" };
      },
    },
    async resolveActor() {
      await controls.resolveHook?.();
      return controls.actor;
    },
  };
  const reader = new InstalledPluginRunContext(dependencies);
  const locator = {
    tenantId: task.binding.tenantId,
    spaceId: task.binding.spaceId,
    runId: task.binding.runId,
  };
  const load = (purpose: "submit" | "observe" = "submit", selected = reader) =>
    selected.load({
      locator,
      expectedTarget: target,
      purpose,
      signal: signal(),
    });
  const state = async (value: "enabled" | "disabled" | "revoked") => {
    const current = await f.first.store.loadExtensionActivation(scope);
    assert.ok(current);
    await f.first.store.saveExtensionActivation({
      expectedRevision: current.revision,
      receipt: receipt(`installed-context-${value}-${current.revision}`),
      activation: {
        ...current,
        revision: current.revision + 1,
        state: value,
        updatedAt: timestamp,
      },
    });
  };
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "run_snapshots",
          "extension_run_bindings",
          "plugin_task_admissions",
          "plugin_credit_reservations",
          "messages",
          "work_items",
        ].map(async (table) => [table, await f.count(table)]),
      ),
    );
  const updateJson = async (
    table:
      | "run_snapshots"
      | "extension_mutation_receipts"
      | "plugin_task_admissions",
    column: "state_json" | "result_json" | "admission_json",
    value: unknown,
  ) => {
    const json = `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    const where =
      table === "extension_mutation_receipts"
        ? "kind='task'"
        : `run_id='${task.binding.runId}'`;
    await f.sql(`UPDATE ${table} SET ${column}=${json} WHERE ${where}`);
  };
  return {
    ...f,
    task,
    tasks,
    admission,
    pin,
    recipe,
    profile,
    enabled,
    installations,
    credits,
    creditScope,
    controls,
    dependencies,
    reader,
    locator,
    load,
    state,
    counts,
    updateJson,
  };
}
