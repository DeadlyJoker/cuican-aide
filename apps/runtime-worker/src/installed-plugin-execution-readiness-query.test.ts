import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { businessPackageFixture } from "./installed-plugin-business.test-support.ts";
import {
  businessExecutionFixture,
  actor,
  scope,
  digester,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { InstalledPluginQueryHost } from "./plugins/installed-plugin-query-host.ts";
import { InstalledPluginExecutionReadinessOwner } from "./plugins/installed-plugin-execution-readiness.ts";
import type { InstalledPluginExecutionIoConfig } from "./plugins/installed-plugin-execution-io-config.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: actual installed query rechecks the exact Agent version permission after IO preflight`,
    {
      timeout: 30_000,
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    },
    async (t) => {
      const key = "query_readiness_" + randomUUID().replaceAll("-", "");
      const counters = { creates: 0 };
      const globals = globalThis as unknown as Record<string, unknown>;
      globals[key] = counters;
      t.after(() => {
        delete globals[key];
      });
      const pkg = await businessPackageFixture(t, {
        node: `export default {apiVersion:'crewon.plugin-host.v1',pluginId:'example.professional',setup(host){const registration=host.services.get('crewon.execution','1').register({requiredServices:['jsonHttp'],create(){globalThis[${JSON.stringify(key)}].creates++;throw new Error('readiness_must_not_create')}});host.onDispose(()=>registration.dispose());}};`,
      });
      let queryPhase = false,
        agentVersionReadable = true,
        preflights = 0,
        http = 0;
      const executionIo: InstalledPluginExecutionIoConfig = {
        resolveNetwork: async () =>
          assert.fail("readiness does not dispatch a Run"),
        resolveReadinessNetwork: async (metadata) => {
          preflights++;
          assert.deepEqual(metadata.scope, scope);
          assert.equal(
            metadata.identity.packageDigest,
            pkg.installed.packageDigest,
          );
          if (queryPhase) {
            assert.equal(metadata.purpose, "observe");
            agentVersionReadable = false;
          }
          return {
            baseUrlParameter: "organization",
            paths: [{ method: "GET", operationPathPrefix: "/reports/" }],
          };
        },
        dns: { resolveAll: async () => [{ address: "8.8.8.8", family: 4 }] },
        transport: {
          request: async () => {
            http++;
            return assert.fail("readiness must not send HTTP");
          },
        },
      };
      const f = await businessExecutionFixture(t, backend, {
        packageDirectory: pkg.installed.directory,
        configurationParameters: {
          organization: "https://query-readiness.example/",
        },
        executionIo,
      });
      const requested = await f.prepareTask("query-readiness"),
        original = await requested.create();
      const admission = await f.extensions.loadPluginTaskAdmission(
        original.binding,
      );
      assert.ok(admission);
      const operationId = randomUUID();
      // Named durable provider evidence only. This authorization test never executes a model or provider.
      await startExternalOperationFixtureRun(f.store, original.binding);
      await f.operations.reserveExternalOperation({
        ...original.binding,
        operationId,
        executionId: "query-readiness-operation",
        idempotencyKey: "query-readiness-operation",
        actionDigest: digester.sha256("action"),
        requestDigest: digester.sha256("request"),
        correlationId: operationId,
        createdAt: new Date().toISOString(),
      });
      const readiness = new InstalledPluginExecutionReadinessOwner({
        configuration: executionIo,
        operations: f.operations,
      });
      const actions: string[] = [];
      const host = new InstalledPluginQueryHost({
        scope,
        installRoot: f.pkg.input.installRoot,
        extensions: f.extensions,
        runs: f.store,
        operations: f.operations,
        installations: f.installations,
        authorization: {
          authorize: async (input) => {
            assert.deepEqual(input.actor, actor);
            actions.push(input.action);
            if (input.action === "agentVersion:read") {
              assert.deepEqual(input.resource, {
                kind: "agentVersion",
                tenantId: scope.tenantId,
                spaceId: scope.spaceId,
                agentVersionId: original.binding.target.agentVersionId,
              });
              if (!agentVersionReadable)
                return {
                  outcome: "deny",
                  reasonCode: "fixture_agent_version_revoked",
                };
            }
            return { outcome: "allow" };
          },
        },
        runtimeResolver: f.resolver,
        deployments: f.store,
        resolveActor: async () => actor,
        resolveProfile: async () => scope,
        authorizePackage: async () => "allow",
        executionReadiness: readiness,
      });
      try {
        const source = { admission, binding: original.binding, operationId };
        const registration = await host.resolveRegistration({ actor, source });
        assert.ok(registration);
        const before = preflights;
        queryPhase = true;
        await assert.rejects(
          host.evaluate({
            actor,
            source,
            registration,
            configuration: f.entry.configuration,
            expectedTarget: original.binding.target,
          }),
          /installed_plugin_query_forbidden/u,
        );
        assert.equal(preflights, before + 1);
        assert.equal(agentVersionReadable, false);
        assert.ok(
          actions.filter((action) => action === "agentVersion:read").length > 1,
        );
        assert.ok(actions.includes("run:read"));
        assert.ok(actions.includes("extension:query"));
        assert.equal(counters.creates, 0);
        assert.equal(http, 0);
        assert.equal(f.controls.models.length, 0);
        assert.equal(await f.count("run_snapshots"), 1);
        assert.equal(await f.count("plugin_query_task_admissions"), 0);
        assert.equal(f.controls.quotes, 1);
      } finally {
        await host.close();
        await readiness.close();
      }
    },
  );
