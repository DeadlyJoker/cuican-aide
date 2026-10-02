import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  ExtensionTaskApplicationService,
  type AuthorizationPort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { InstalledPluginQueryHost } from "./plugins/installed-plugin-query-host.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import {
  businessExecutionFixture,
  actor,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: installed query uses actual old package/runtime readiness after current upgrade and rechecks source access`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 60000,
    },
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const request = await f.prepareTask("query-source"),
        original = await request.create();
      const sourceAdmission = await f.extensions.loadPluginTaskAdmission(
        original.binding,
      );
      assert.ok(sourceAdmission);
      const operations = f.store.externalOperationStore(),
        operationId = randomUUID();
      // Persisted deterministic provider record only; no external provider or model is dispatched in this test.
      await operations.reserveExternalOperation({
        tenantId: actor.tenantId,
        runId: original.binding.runId,
        bindingDigest: original.binding.bindingDigest,
        operationId,
        executionId: "query-fixture-op",
        idempotencyKey: "query-fixture-op",
        actionDigest: digester.sha256("action"),
        requestDigest: digester.sha256("request"),
        correlationId: operationId,
        createdAt: new Date().toISOString(),
      });
      const newer = await f.upgrade();
      let sourceReadable = true;
      const authorization: AuthorizationPort = {
        async authorize(input) {
          assert.deepEqual(input.actor, actor);
          return input.action === "run:read" && !sourceReadable
            ? { outcome: "deny", reasonCode: "fixture_revoked" }
            : { outcome: "allow" };
        },
      };
      const queryHost = new InstalledPluginQueryHost({
        scope,
        installRoot: f.pkg.input.installRoot,
        extensions: f.extensions,
        runs: f.store,
        operations,
        installations: f.installations,
        authorization,
        runtimeResolver: f.resolver,
        deployments: f.store,
        resolveActor: async () => actor,
        resolveProfile: async () => scope,
        authorizePackage: async ({ candidate, purpose }) => {
          assert.equal(candidate.packageDigest, sourceAdmission.packageDigest);
          assert.equal(purpose, "observe");
          return "allow";
        },
      });
      t.after(() => queryHost.close());
      const source = {
        admission: sourceAdmission,
        binding: original.binding,
        operationId,
      };
      const registration = await queryHost.resolveRegistration({
        actor,
        source,
      });
      assert.ok(registration);
      assert.equal(
        registration.implementationDigest,
        f.entry.registration.implementationDigest,
      );
      assert.notEqual(
        registration.implementationDigest,
        newer.implementationDigest,
      );
      const ready = await queryHost.evaluate({
        actor,
        source,
        registration,
        configuration: f.entry.configuration,
        expectedTarget: original.binding.target,
      });
      assert.deepEqual(ready, {
        outcome: "ready",
        target: original.binding.target,
      });
      assert.equal(f.controls.factories.length, 0);
      assert.equal(f.controls.executes.length, 0);
      assert.equal(f.controls.models.length, 0);
      const selection = await f.installations.loadSelection({
        scope,
        pluginId: registration.manifest.pluginId,
      });
      assert.ok(selection);
      const pin = parsePluginTaskAdmissionPin({
        ...request.pin,
        ...newer.identity,
        selectionRevision: selection.revision,
        action: "report.query",
      });
      await seedThread(f.store, { ...actor, threadId: "actual-query-thread" });
      const tasks = new ExtensionTaskApplicationService({
        store: f.store,
        extensions: f.extensions,
        operations,
        catalog: { list: () => [registration], resolve: () => registration },
        host: f.host,
        pluginQueryHost: queryHost,
        authorization,
        clock: { now: () => new Date().toISOString() },
        ids: { nextId: () => randomUUID() },
        digester,
      });
      const command = {
        pluginId: registration.manifest.pluginId,
        threadId: "actual-query-thread",
        expectedThreadRevision: 1,
        idempotencyKey: "actual-query",
        intent: {
          kind: "query" as const,
          sourceRunId: source.binding.runId,
          operationId,
        },
      };
      const accepted = await tasks.createQueryTaskFromPlugin(
        actor,
        command,
        pin,
      );
      assert.equal(accepted.creditAdmission, undefined);
      assert.deepEqual(accepted.binding.target, original.binding.target);
      const query = await f.extensions.loadPluginQueryTaskAdmission(
        accepted.binding,
      );
      assert.equal(query?.packageDigest, newer.identity.packageDigest);
      assert.equal(query?.source.packageDigest, sourceAdmission.packageDigest);
      const reader = new InstalledPluginRunContext({
        extensions: f.extensions,
        runs: f.store,
        installations: f.installations,
        operations,
        authorization,
        resolveActor: async () => actor,
      });
      const snapshot = await reader.load({
        locator: {
          tenantId: accepted.binding.tenantId,
          spaceId: accepted.binding.spaceId,
          runId: accepted.binding.runId,
        },
        expectedTarget: original.binding.target,
        purpose: "observe",
        signal: new AbortController().signal,
      });
      assert.ok(snapshot);
      assert.equal(
        snapshot.context.identity.packageDigest,
        sourceAdmission.packageDigest,
      );
      assert.equal(
        snapshot.context.configuration.contentDigest,
        original.binding.configurationDigest,
      );
      assert.deepEqual(snapshot.context.run.source, accepted.binding.source);
      await f.select("disabled", newer.identity.packageDigest);
      await reader.assertCurrent(
        snapshot,
        "submit",
        new AbortController().signal,
      );
      await assert.rejects(
        queryHost.evaluate({
          actor,
          source,
          registration,
          configuration: f.entry.configuration,
          expectedTarget: {
            ...original.binding.target,
            agentVersionContentDigest: digester.sha256("other"),
          },
        }),
        /target_mismatch/u,
      );
      sourceReadable = false;
      await assert.rejects(
        reader.assertCurrent(snapshot, "observe", new AbortController().signal),
      );
      await assert.rejects(queryHost.resolveRegistration({ actor, source }));
      assert.equal(f.controls.executes.length, 0);
      assert.equal(f.controls.factories.length, 0);
      assert.equal(f.controls.models.length, 0);
      assert.equal(f.controls.quotes, 1);
    },
  );
