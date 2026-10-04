import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  PLUGIN_UI_RECOVERY_VERSION,
} from "@crewon/contracts/plugins";
import { SqliteRunStore } from "@crewon/store";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import {
  assertDesktopPluginUiRecoveryConfiguration,
  prepareDesktopPluginUiRecovery,
} from "./desktop-plugin-ui-recovery.ts";
import {
  assertInstalledPluginTaskRuntimeCoreBinding,
  createInstalledPluginTaskRuntimeCore,
  type InstalledPluginTaskRuntimeCore,
} from "./installed-plugin-task-runtime-core.ts";
import {
  actor,
  taskRuntimeCoreFixture,
} from "./installed-plugin-task-runtime-core.test-support.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";
import type { PluginUiRecoveryConfiguration } from "./plugin-ui-recovery-composition.ts";

// Genuine shared owners, installed bytes, SQLite and session scopes. Offline policy,
// peer and personal quote fixtures prove composition only, never Native Main readiness.
async function fixture(t: TestContext, mode: "generation" | "query") {
  const f = await taskRuntimeCoreFixture(t, { mode });
  assert.ok(f.creativeProjects);
  const store = f.storage.first.parent;
  assert.ok(store instanceof SqliteRunStore);
  const action =
    mode === "generation"
      ? ("crewon.project-generations.v1.generateConcept" as const)
      : ("crewon.project-generation-queries.v1.queryConceptGeneration" as const);
  const configuration: PluginUiRecoveryConfiguration = {
    version: PLUGIN_UI_RECOVERY_VERSION,
    publications: [
      {
        pluginId: f.source.descriptor.pluginId,
        packageDigest: f.source.packageDigest,
        contributionId: "workbench",
        actions: [action],
      },
    ],
  };
  const input = {
    configuration,
    publications: f.coreInput.publications,
    selectionUi: undefined,
    ...(f.creativeProjects.pluginGenerations === undefined
      ? {}
      : {
          pluginGenerations: {
            publications: f.creativeProjects.pluginGenerations.publications,
          },
        }),
    ...(f.creativeProjects.pluginQueries === undefined
      ? {}
      : {
          pluginQueries: {
            publications: f.creativeProjects.pluginQueries.publications,
          },
        }),
    store,
    requests: f.requests,
    selection: undefined,
    tasks: f.core,
    clock: { now: () => timestamp },
    digester: extensionStoreDigester,
    onDiagnostic() {
      assert.fail("unexpected recovery diagnostic");
    },
  };
  const availability = {
    scope: f.storage.profile,
    candidate: {
      descriptor: f.source.descriptor,
      packageDigest: f.source.packageDigest,
    },
    requirement: {
      service: CREWON_PLUGIN_UI_RECOVERY_SERVICE,
      apiVersion: CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
      optional: false,
    },
  };
  return { ...f, input, availability };
}

for (const mode of ["generation", "query"] as const) {
  test(`Native ${mode} recovery accepts only its independently approved exact source mapping`, async (t) => {
    const f = await fixture(t, mode);
    assert.deepEqual(
      assertDesktopPluginUiRecoveryConfiguration(f.input),
      f.input.configuration,
    );
    const publication = f.input.configuration.publications[0]!;
    for (const patch of [
      { pluginId: "other.business" },
      { packageDigest: `sha256:${"f".repeat(64)}` },
      { contributionId: "other-module" },
      {
        actions: [
          mode === "generation"
            ? "crewon.project-generation-queries.v1.queryConceptGeneration"
            : "crewon.project-generations.v1.generateConcept",
        ],
      },
    ])
      assert.throws(
        () =>
          assertDesktopPluginUiRecoveryConfiguration({
            ...f.input,
            configuration: {
              ...f.input.configuration,
              publications: [{ ...publication, ...patch }],
            } as typeof f.input.configuration,
          }),
        /desktop_plugin_ui_recovery_configuration_invalid/u,
      );
    assert.throws(
      () =>
        assertDesktopPluginUiRecoveryConfiguration({
          ...f.input,
          pluginGenerations: undefined,
          pluginQueries: undefined,
        }),
      /desktop_plugin_ui_recovery_configuration_invalid/u,
    );
  });

  test(`Native ${mode} journal qualification borrows the actual core without creating a task, Node setup or quote`, async (t) => {
    const f = await fixture(t, mode);
    const before = await f.effects();
    const setups = f.nodeState.setups;
    const recovery = await prepareDesktopPluginUiRecovery(f.input);
    assert.ok(recovery);
    t.after(() => recovery.close());
    assert.equal(recovery.hostUiServices.isAvailable(f.availability), true);
    assert.deepEqual(await f.effects(), before);
    assert.equal(f.nodeState.setups, setups);
    assert.equal(f.state.quoteCalls, 0);
    await recovery.close();
    assert.equal(recovery.hostUiServices.isAvailable(f.availability), false);
    assertInstalledPluginTaskRuntimeCoreBinding(f.core, {
      store: f.storage.first.parent,
      requests: f.requests,
    });
    await f.requests.run(
      { request: f.request(), actor, preparation: "configuration" },
      async () => {
        await f.requests.assertCurrent();
      },
    );
  });

  test(`Native ${mode} rejects a core clone and foreign request/store before acquiring the journal`, async (t) => {
    const f = await fixture(t, mode);
    const other = await taskRuntimeCoreFixture(t);
    const foreignStore = other.storage.first.parent;
    assert.ok(foreignStore instanceof SqliteRunStore);
    let calls = 0;
    t.mock.method(f.storage.first.parent, "pluginUiIntentJournalStore", () => {
      calls++;
      assert.fail("invalid recovery acquired journal");
    });
    t.mock.method(
      other.storage.first.parent,
      "pluginUiIntentJournalStore",
      () => {
        calls++;
        assert.fail("foreign recovery acquired journal");
      },
    );
    for (const patch of [
      { tasks: undefined },
      { tasks: { ...f.core } as InstalledPluginTaskRuntimeCore },
      { tasks: other.core },
      { requests: other.requests },
      { store: foreignStore },
    ])
      await assert.rejects(
        prepareDesktopPluginUiRecovery({ ...f.input, ...patch }),
        /desktop_plugin_ui_recovery_configuration_invalid/u,
      );
    assert.equal(calls, 0);
  });

  test(`Native ${mode} recovery cannot substitute a generic fallback for the declared lane requirement`, async (t) => {
    const f = await fixture(t, mode);
    const recovery = await prepareDesktopPluginUiRecovery({
      ...f.input,
      fallback: { isAvailable: () => true },
    });
    assert.ok(recovery);
    t.after(() => recovery.close());
    const service =
      mode === "generation"
        ? "crewon.project-generations"
        : "crewon.project-generation-queries";
    assert.equal(
      recovery.hostUiServices.isAvailable({
        ...f.availability,
        candidate: {
          ...f.availability.candidate,
          descriptor: {
            ...f.source.descriptor,
            requires: f.source.descriptor.requires.filter(
              (item) => item.service !== service,
            ),
          },
        },
      }),
      false,
    );
    await f.core.close();
    assert.equal(recovery.hostUiServices.isAvailable(f.availability), false);
    await assert.rejects(async () =>
      recovery.run(f.request(), actor, undefined, async () => {
        assert.fail("closed core entered recovery work");
      }),
    );
  });
}

test("Native execution recovery rejects a closed genuine core before journal allocation", async (t) => {
  const f = await fixture(t, "generation");
  await f.core.close();
  let calls = 0;
  t.mock.method(f.storage.first.parent, "pluginUiIntentJournalStore", () => {
    calls++;
    assert.fail("closed core acquired journal");
  });
  await assert.rejects(
    prepareDesktopPluginUiRecovery(f.input),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  assert.equal(calls, 0);
});

test("Native recovery rejects a genuine same-store core without the configured lane before journal allocation", async (t) => {
  const f = await fixture(t, "generation");
  const { creativeProjects: _projects, ...plainInput } = f.coreInput;
  const plain = await createInstalledPluginTaskRuntimeCore(plainInput);
  t.after(() => plain.close());
  let calls = 0;
  t.mock.method(f.storage.first.parent, "pluginUiIntentJournalStore", () => {
    calls++;
    assert.fail("missing lane acquired journal");
  });
  assertInstalledPluginTaskRuntimeCoreBinding(plain, {
    store: f.storage.first.parent,
    requests: f.requests,
  });
  await assert.rejects(
    prepareDesktopPluginUiRecovery({ ...f.input, tasks: plain }),
    /desktop_plugin_ui_recovery_configuration_invalid/u,
  );
  assert.equal(calls, 0);
});

test("Native recovery close waits for its physical request without closing the borrowed parent or core", async (t) => {
  const f = await fixture(t, "generation");
  const recovery = await prepareDesktopPluginUiRecovery(f.input);
  assert.ok(recovery);
  t.after(() => recovery.close());
  const entered = deferred();
  const resume = deferred();
  t.after(() => resume.resolve());
  const pending = recovery.run(f.request(), actor, undefined, async () => {
    entered.resolve();
    await resume.promise;
  });
  try {
    await entered.promise;
    let closed = false;
    const closing = recovery.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    assert.equal(closed, false);
    resume.resolve();
    await Promise.all([pending, closing]);
  } finally {
    resume.resolve();
    await pending.catch(() => {});
    await recovery.close();
  }
  assertInstalledPluginTaskRuntimeCoreBinding(f.core, {
    store: f.storage.first.parent,
    requests: f.requests,
  });
  const command = f.command.input as { threadId: string };
  assert.ok(
    await f.storage.first.parent.loadThread({
      ...actor,
      threadId: command.threadId,
    }),
  );
});
