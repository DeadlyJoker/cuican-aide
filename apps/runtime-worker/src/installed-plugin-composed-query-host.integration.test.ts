import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExtensionTaskApplicationService } from "@crewon/application";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import {
  businessExecutionFixture,
  actor,
  scope,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE } from "@crewon/plugin-host";
import { InstalledPluginQueryHost } from "./plugins/installed-plugin-query-host.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual installed query host verifies the original composed source after an upgrade without creating a Tool runtime`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const request = await f.prepareTask("composed-query-host-source");
      const compositions = f.installations.compositionStore!();
      await compositions.migrate();
      const descriptor = f.pkg.installed.descriptor;
      const lock = createPluginCompositionLock(
        {
          schemaVersion: "crewon.plugin-composition-lock.v1",
          scope: { ...scope, authorityEpoch: request.pin.authorityEpoch },
          revision: 1,
          nodes: [
            {
              ...f.entry.registration.identity,
              selectionRevision: request.pin.selectionRevision,
              hostApi: descriptor.hostApi,
              requires: descriptor.requires,
              provides: descriptor.provides,
            },
          ],
          hostServices: [PLUGIN_EXECUTION_REGISTRY_COMPOSITION_SERVICE],
        },
        digester,
      );
      await compositions.commit({
        scope: lock.scope,
        actor,
        lock,
        expectedRevision: null,
      });
      const tasks = new ExtensionTaskApplicationService({
        store: f.store,
        extensions: f.extensions,
        operations: f.operations,
        catalog: {
          list: () => [f.entry.registration],
          resolve: () => f.entry.registration,
        },
        host: f.host,
        authorization: { authorize: async () => ({ outcome: "allow" }) },
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
        pluginCompositions: compositions,
        creditQuotes: {
          quoteGeneration: async () => ({
            poolId: f.creditScope.poolId,
            priceRevision: 1,
            quotedCredits: "30",
          }),
        },
      });
      const original = await tasks.createTaskFromPlugin(
        actor,
        request.command,
        request.pin,
      );
      const admission = await f.extensions.loadPluginTaskAdmission(
        original.binding,
      );
      assert.ok(admission);
      await startExternalOperationFixtureRun(f.store, original.binding);
      const operationId = randomUUID();
      await f.operations.reserveExternalOperation({
        tenantId: actor.tenantId,
        runId: original.binding.runId,
        bindingDigest: original.binding.bindingDigest,
        operationId,
        executionId: "composed-preflight-operation",
        idempotencyKey: "composed-preflight-operation",
        actionDigest: digester.sha256("action"),
        requestDigest: digester.sha256("request"),
        correlationId: operationId,
        createdAt: new Date().toISOString(),
      });
      const newer = await f.upgrade();
      let readable = true;
      let ownerActive = true;
      const host = new InstalledPluginQueryHost({
        scope,
        installRoot: f.pkg.input.installRoot,
        extensions: f.extensions,
        runs: f.store,
        operations: f.operations,
        installations: f.installations,
        compositions,
        compositionAuthority() {
          if (!ownerActive) throw new Error("named-owner-withdrawn");
          return { ...scope, authorityEpoch: "current-query-owner-epoch" };
        },
        authorization: {
          authorize: async ({ action }) =>
            action === "run:read" && !readable
              ? { outcome: "deny", reasonCode: "named-read-revoked" }
              : { outcome: "allow" },
        },
        runtimeResolver: f.resolver,
        deployments: f.store,
        resolveActor: async () => actor,
        resolveProfile: async () => scope,
        authorizePackage: async ({ candidate, purpose }) => {
          assert.equal(candidate.packageDigest, admission.packageDigest);
          assert.equal(purpose, "observe");
          return "allow";
        },
      });
      t.after(() => host.close());
      const source = { admission, binding: original.binding, operationId };
      const registration = await host.resolveRegistration({ actor, source });
      assert.ok(registration);
      assert.equal(
        registration.implementationDigest,
        f.entry.registration.implementationDigest,
      );
      assert.notEqual(
        registration.implementationDigest,
        newer.implementationDigest,
      );
      assert.deepEqual(
        await host.evaluate({
          actor,
          source,
          registration,
          configuration: f.entry.configuration,
          expectedTarget: original.binding.target,
        }),
        { outcome: "ready", target: original.binding.target },
      );
      assert.equal(f.controls.factories.length, 0);
      assert.equal(f.controls.executes.length, 0);
      assert.equal(f.controls.models.length, 0);
      ownerActive = false;
      await assert.rejects(
        host.resolveRegistration({ actor, source }),
        /named-owner-withdrawn/u,
      );
      ownerActive = true;
      readable = false;
      await assert.rejects(host.resolveRegistration({ actor, source }));
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
    },
  );
}
