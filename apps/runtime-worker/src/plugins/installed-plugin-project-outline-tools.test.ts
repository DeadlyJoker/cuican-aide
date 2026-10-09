import assert from "node:assert/strict";
import test from "node:test";
import {
  captureInstalledPluginProjectOutlineToolsConfig,
  composeInstalledPluginProjectOutlineToolsDependencies,
  createInstalledPluginProjectOutlineToolsOwner,
  type InstalledPluginProjectOutlineToolsConfig,
} from "./installed-plugin-project-outline-tools.ts";
import { captureInstalledPluginExecutionConfig } from "./installed-plugin-runtime-composition.ts";
import { createInstalledPluginProjectServices } from "./installed-plugin-project-services.ts";
import { outlineToolsOwnerFixture } from "./project-outline-tools-service-owner.test-support.ts";

test("outline deployment is explicit, data-only and bound to the original parent store", async (t) => {
  const f = await outlineToolsOwnerFixture(t);
  let creates = 0;
  const config: InstalledPluginProjectOutlineToolsConfig = {
    version: "crewon.project-outline-tools.v2",
    createOutlines({ store }) {
      assert.equal(store, f.parent);
      creates++;
      return f.dependencies.outlines;
    },
    authorization: f.dependencies.authorization,
    async authorizeService(admission, signal) {
      assert.equal(admission, f.dependencies.admission);
      await f.dependencies.authorizeOutlineService(signal);
    },
  };
  const captured = captureInstalledPluginProjectOutlineToolsConfig(config);
  assert.equal(creates, 0);
  for (const invalid of [
    { ...config, version: "crewon.project-tools.v1" },
    { ...config, version: "crewon.project-foundation-tools.v1" },
    { ...config, guide: "write outline" },
    {
      version: config.version,
      createOutlines: config.createOutlines,
      authorization: config.authorization,
    },
  ])
    assert.throws(() =>
      captureInstalledPluginProjectOutlineToolsConfig(invalid as never),
    );
  let getters = 0;
  assert.throws(() =>
    captureInstalledPluginProjectOutlineToolsConfig({
      ...config,
      get authorizeService() {
        getters++;
        return config.authorizeService;
      },
    }),
  );
  assert.equal(getters, 0);
  const dependencies = composeInstalledPluginProjectOutlineToolsDependencies({
    store: f.parent,
    config: captured,
    resolveActor: f.dependencies.resolveActor,
  });
  assert.equal(creates, 1);
  assert.equal(dependencies.outlines, f.dependencies.outlines);
  await dependencies.authorizeService(
    f.dependencies.admission,
    f.signal.signal,
  );
  f.controls.service = false;
  await assert.rejects(
    dependencies.authorizeService(f.dependencies.admission, f.signal.signal),
  );
  const execution = {
    installRoot: "/named-installed-root",
    authorization: {
      async authorize() {
        return { outcome: "allow" as const };
      },
    },
    resolveActor: f.dependencies.resolveActor,
    async authorizePackage() {
      return "allow" as const;
    },
  };
  assert.equal(
    captureInstalledPluginExecutionConfig(execution).projectOutlineTools,
    undefined,
  );
  assert.equal(
    captureInstalledPluginExecutionConfig({
      ...execution,
      projectOutlineTools: config,
    }).projectOutlineTools?.version,
    config.version,
  );
  assert.throws(() =>
    captureInstalledPluginExecutionConfig({
      ...execution,
      get projectOutlineTools() {
        getters++;
        return config;
      },
    }),
  );
  assert.equal(getters, 0);
});

test("outline owner publication requires actual outline stage and independent deployment", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    d = f.dependencies;
  const input = {
    dependencies: {
      ...d,
      authorizeService: async (
        _admission: typeof d.admission,
        signal: AbortSignal,
      ) => d.authorizeOutlineService(signal),
    },
    context: d.context,
    stageAdmission: d.stageAdmission,
    admission: d.admission,
    scope: d.context.scope,
    tools: d.tools,
    candidate: () => null,
    authorizeCurrent: d.authorizeCurrent,
    async authorizePackage() {
      return "allow" as const;
    },
    assertActive: d.assertActive,
  };
  assert.throws(
    () =>
      createInstalledPluginProjectOutlineToolsOwner({
        ...input,
        dependencies: undefined,
      }),
    /services_unavailable/,
  );
  assert.equal(
    createInstalledPluginProjectOutlineToolsOwner({
      ...input,
      stageAdmission: null,
    }),
    null,
  );
  const owner = createInstalledPluginProjectOutlineToolsOwner(input);
  assert.ok(owner);
  t.after(() => owner.close());
  const host = owner.hostService();
  let dispose: (() => void | Promise<void>) | undefined;
  const lifetime = {
    onDispose(callback: () => void | Promise<void>) {
      dispose = callback;
    },
  };
  assert.throws(() =>
    host.bindForPlugin!({ ...d.context.identity, version: "other" }, lifetime),
  );
  assert.equal(host.bindForPlugin!(d.context.identity, lifetime), host.value);
  assert.ok(dispose);
  await dispose();
  assert.ok(owner.canRetire());
});

test("installed outline service composes independently without entering the legacy write guard", async (t) => {
  const f = await outlineToolsOwnerFixture(t),
    d = f.dependencies;
  const input = {
    dependencies: undefined,
    mediaInputDependencies: undefined,
    mediaInputStage: null,
    outlineDependencies: {
      ...d,
      authorizeService: async (
        _admission: typeof d.admission,
        signal: AbortSignal,
      ) => d.authorizeOutlineService(signal),
    },
    context: d.context,
    stageAdmission: d.stageAdmission,
    admission: d.admission,
    scope: d.context.scope,
    tools: d.tools,
    candidate: () => null,
    authorizeCurrent: d.authorizeCurrent,
    async authorizePackage() {
      return "allow" as const;
    },
    assertActive: d.assertActive,
  };
  const services = createInstalledPluginProjectServices(input);
  assert.ok(services);
  t.after(() => services.close());
  assert.deepEqual(
    services.hostServices().map((host) => host.service),
    ["crewon.project-outline-tools"],
  );
  assert.ok(services.canRetire());
  const legacy = createInstalledPluginProjectServices({
    ...input,
    stageAdmission: null,
    tools: [],
    outlineDependencies: undefined,
  });
  assert.equal(legacy, null);
});
