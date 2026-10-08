import assert from "node:assert/strict";
import test from "node:test";
import {
  captureInstalledPluginProjectFoundationToolsConfig,
  composeInstalledPluginProjectFoundationToolsDependencies,
  createInstalledPluginProjectFoundationToolsOwner,
  type InstalledPluginProjectFoundationToolsConfig,
} from "./installed-plugin-project-foundation-tools.ts";
import { foundationToolsOwnerFixture } from "./project-foundation-tools-service-owner.test-support.ts";

test("independent Foundation deployment config requires explicit service policy and never treats a guide or old grant as readiness", async (t) => {
  const f = await foundationToolsOwnerFixture(t);
  let policy = true,
    creates = 0;
  const config: InstalledPluginProjectFoundationToolsConfig = {
    version: "crewon.project-foundation-tools.v1",
    createFoundations: ({ store }) => {
      assert.equal(store, f.parent);
      creates++;
      return f.foundations;
    },
    authorization: f.dependencies.authorization,
    authorizeService: async (admission, signal) => {
      assert.deepEqual(admission, f.taskAdmission);
      signal.throwIfAborted();
      if (!policy)
        throw new Error("named_independent_foundation_deployment_denied");
    },
  };
  const captured = captureInstalledPluginProjectFoundationToolsConfig(config);
  assert.equal(creates, 0);
  const { authorizeService: _service, ...oldGrant } = config;
  assert.throws(
    () =>
      captureInstalledPluginProjectFoundationToolsConfig(
        oldGrant as InstalledPluginProjectFoundationToolsConfig,
      ),
    /authority_denied/,
  );
  assert.throws(
    () =>
      captureInstalledPluginProjectFoundationToolsConfig({
        ...config,
        guidance: "save a proposal",
      } as InstalledPluginProjectFoundationToolsConfig),
    /authority_denied/,
  );
  let getter = 0;
  assert.throws(
    () =>
      captureInstalledPluginProjectFoundationToolsConfig({
        ...config,
        get authorizeService() {
          getter++;
          return config.authorizeService;
        },
      }),
    /authority_denied/,
  );
  assert.equal(getter, 0);
  const dependencies = composeInstalledPluginProjectFoundationToolsDependencies(
    {
      store: f.parent,
      config: captured,
      resolveActor: f.dependencies.resolveActor,
    },
  );
  assert.equal(creates, 1);
  await dependencies.authorizeService(
    f.taskAdmission,
    new AbortController().signal,
  );
  policy = false;
  await assert.rejects(
    dependencies.authorizeService(
      f.taskAdmission,
      new AbortController().signal,
    ),
    /independent_foundation_deployment_denied/,
  );
});

test("actual admitted Foundation owner fails closed without deployment, and binds the exact installed identity/lifetime", async (t) => {
  const f = await foundationToolsOwnerFixture(t),
    scope = {
      tenantId: f.taskAdmission.tenantId,
      spaceId: f.taskAdmission.spaceId,
      profileId: f.taskAdmission.profileId,
    },
    input = {
      dependencies: {
        ...f.dependencies,
        authorizeService: async (
          _admission: typeof f.taskAdmission,
          signal: AbortSignal,
        ) => f.dependencies.authorizeFoundationService(signal),
      },
      context: f.context,
      stageAdmission: f.stage,
      foundationAdmission: f.admission,
      admission: f.taskAdmission,
      scope,
      tools: f.tools,
      candidate: () => null,
      authorizeCurrent: f.dependencies.authorizeCurrent,
      authorizePackage: async () => "allow" as const,
      assertActive: f.dependencies.assertActive,
    };
  assert.throws(
    () =>
      createInstalledPluginProjectFoundationToolsOwner({
        ...input,
        dependencies: undefined,
      }),
    /services_unavailable/,
  );
  assert.throws(
    () =>
      createInstalledPluginProjectFoundationToolsOwner({
        ...input,
        stageAdmission: null,
      }),
    /services_unavailable/,
  );
  assert.equal(
    createInstalledPluginProjectFoundationToolsOwner({
      ...input,
      foundationAdmission: null,
    }),
    null,
  );
  const owner = createInstalledPluginProjectFoundationToolsOwner(input);
  assert.ok(owner);
  t.after(() => owner.close());
  const service = owner.hostService();
  let dispose: (() => void | Promise<void>) | undefined;
  const lifetime = {
    onDispose: (callback: () => void | Promise<void>) => {
      dispose = callback;
    },
  };
  assert.throws(
    () =>
      service.bindForPlugin!(
        { ...f.context.identity, version: "9.9.9" },
        lifetime,
      ),
    /authority_denied/,
  );
  assert.equal(
    service.bindForPlugin!(f.context.identity, lifetime),
    service.value,
  );
  assert.ok(dispose);
  const op = await f.prepare("readScope", {}),
    actual = f.service(owner),
    result = await f.invoke(owner, op, (command) =>
      actual.readScope({ command, request: {} }),
    );
  assert.equal(result.scope.projectId, f.admission.projectId);
  await dispose();
  assert.equal(owner.canRetire(), true);
  await assert.rejects(
    f.invoke(owner, op, (command) =>
      actual.readScope({ command, request: {} }),
    ),
    /authority_denied/,
  );
});
