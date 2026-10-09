import { createExtensionRunBinding } from "@crewon/domain";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { pluginExecutionPackageFailureOwner } from "@crewon/plugin-host";
import { InstalledPluginQueryHost } from "./plugins/installed-plugin-query-host.ts";
import {
  actor,
  scope,
  digester,
  businessExecutionFixture,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { businessPackageFixture } from "./installed-plugin-business.test-support.ts";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";

/** Actual installed ESM and SQLite provenance; these policies are test-owned, not production permission. */
async function lifecycleFixture(t: TestContext) {
  const key = `query_lifecycle_${randomUUID().replaceAll("-", "")}`;
  const control = { setups: 0, disposes: 0, creates: 0, failCleanup: false };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = control;
  t.after(() => {
    delete globals[key];
  });
  const artifact = await businessPackageFixture(t, {
    node: `const f=globalThis[${JSON.stringify(key)}];
export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.professional',setup(host){
f.setups++;
const registration=host.services.get('crewon.execution','1').register({create(){f.creates++;throw new Error('readiness_must_not_create_runtime')}});
host.onDispose(()=>registration.dispose());
return {dispose(){f.disposes++;if(f.failCleanup)throw new Error('fixture_actual_cleanup_failure')}};
}};`,
  });
  const f = await businessExecutionFixture(t, "sqlite", {
    packageDirectory: artifact.installed.directory,
  });
  const requested = await f.prepareTask("query-lifecycle-source");
  const original = await requested.create();
  const admission = await f.extensions.loadPluginTaskAdmission(
    original.binding,
  );
  assert.ok(admission);
  const operations = f.store.externalOperationStore();
  const operationId = randomUUID();
  await startExternalOperationFixtureRun(f.store, original.binding);
  await operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: original.binding.runId,
    bindingDigest: original.binding.bindingDigest,
    operationId,
    executionId: "query-lifecycle-source-op",
    idempotencyKey: "query-lifecycle-source-op",
    actionDigest: digester.sha256("fixture-action"),
    requestDigest: digester.sha256("fixture-request"),
    correlationId: operationId,
    createdAt: new Date().toISOString(),
  });
  const before = control.setups;
  assert.ok(
    before > 0,
    "original source readiness actually loaded its Node package",
  );
  let denyAfterSetup = true;
  const host = new InstalledPluginQueryHost({
    scope,
    installRoot: f.pkg.input.installRoot,
    extensions: f.extensions,
    runs: f.store,
    operations,
    installations: f.installations,
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    runtimeResolver: f.resolver,
    deployments: f.store,
    resolveActor: async () => actor,
    resolveProfile: async () => scope,
    authorizePackage: async ({ candidate, purpose }) => {
      assert.equal(candidate.packageDigest, admission.packageDigest);
      assert.equal(purpose, "observe");
      return denyAfterSetup && control.setups > before ? "deny" : "allow";
    },
  });
  const source = { admission, binding: original.binding, operationId };
  const registration = await host.resolveRegistration({ actor, source });
  assert.ok(registration);
  const evaluate = () =>
    host.evaluate({
      actor,
      source,
      registration,
      configuration: f.entry.configuration,
      expectedTarget: original.binding.target,
    });
  return {
    f,
    host,
    control,
    before,
    original,
    evaluate,
    restorePermission() {
      denyAfterSetup = false;
    },
  };
}

test("actual clean query package startup denial can retry after permission returns on the same Host", async (t) => {
  const f = await lifecycleFixture(t);
  t.after(() => f.host.close());
  await assert.rejects(f.evaluate(), (error: unknown) => {
    assert.match(String(error), /installed_plugin_query_package_denied/u);
    assert.equal(pluginExecutionPackageFailureOwner(error), null);
    return true;
  });
  assert.equal(f.control.setups, f.before + 1);
  assert.equal(f.control.disposes, 1);
  f.restorePermission();
  assert.deepEqual(await f.evaluate(), {
    outcome: "ready",
    target: f.original.binding.target,
  });
  assert.equal(f.control.setups, f.before + 2);
  // Successful registration is borrowed again; no third setup or synthetic runtime.
  assert.equal((await f.evaluate()).outcome, "ready");
  assert.equal(f.control.setups, f.before + 2);
  assert.equal(f.control.creates, 0);
  assert.equal(f.f.controls.quotes, 1);
  assert.equal(await f.f.count("run_snapshots"), 1);
});

test("actual query package cleanup failure retains its owner and rejected slot after permission returns", async (t) => {
  const f = await lifecycleFixture(t);
  let originalError: unknown;
  f.control.failCleanup = true;
  await assert.rejects(f.evaluate(), (error: unknown) => {
    originalError = error;
    assert.ok(pluginExecutionPackageFailureOwner(error));
    return true;
  });
  assert.equal(f.control.setups, f.before + 1);
  assert.ok(f.control.disposes > 0);
  const cleanupAttempts = f.control.disposes;
  f.restorePermission();
  f.control.failCleanup = false;
  await assert.rejects(
    f.evaluate(),
    (error: unknown) => error === originalError,
  );
  await assert.rejects(
    f.evaluate(),
    (error: unknown) => error === originalError,
  );
  assert.equal(f.control.setups, f.before + 1);
  assert.equal(f.control.disposes, cleanupAttempts);
  assert.equal(f.control.creates, 0);
  // A returned failed cleanup is still quarantined, never claimed physically disposed by a retry.
  await assert.rejects(
    f.host.close(),
    /installed_plugin_query_cleanup_failed/u,
  );
  assert.equal(f.control.setups, f.before + 1);
  assert.equal(f.f.controls.quotes, 1);
  assert.equal(await f.f.count("run_snapshots"), 1);
});

test("query readiness refuses composed sources before loading or executing a private package", async (t) => {
  const f = await lifecycleFixture(t);
  t.after(() => f.host.close());
  const admission = await f.f.extensions.loadPluginTaskAdmission(
    f.original.binding,
  );
  assert.ok(admission);
  const binding = createExtensionRunBinding(
    {
      ...f.original.binding,
      schemaVersion: "crewon.extension-run-binding.v1",
      composition: {
        profileId: admission.profileId,
        authorityEpoch: admission.authorityEpoch,
        revision: 1,
        lockDigest: digester.sha256("composition"),
      },
    },
    digester,
  );
  const before = f.control.setups;
  assert.throws(
    () =>
      f.host.resolveRegistration({
        actor,
        source: {
          admission: {
            ...admission,
            extensionBindingDigest: binding.bindingDigest,
          },
          binding,
          operationId: randomUUID(),
        },
      }),
    /installed_plugin_composition_query_unavailable/,
  );
  assert.equal(f.control.setups, before);
  assert.equal(f.control.creates, 0);
});
