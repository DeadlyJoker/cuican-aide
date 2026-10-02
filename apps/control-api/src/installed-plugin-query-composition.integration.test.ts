import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryArtifactStore } from "@crewon/artifacts";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  type AuthorizationPort,
  type PluginQueryHostPort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  actor,
  businessExecutionFixture,
  digester,
  scope,
} from "../../runtime-worker/src/installed-plugin-business-execution.integration.test-support.ts";
import { RuntimeExtensionHostService } from "../../runtime-worker/src/extensions/extension-host-service.ts";
import { startRuntimeExtensionHostServer } from "../../runtime-worker/src/extensions/extension-host-server.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import {
  createStandaloneControlApi,
  createStandaloneControlApiWithExtensions,
  createPostgresControlApi,
  type StandaloneControlApiConfig,
} from "./standalone-composition.ts";

const browserOrigin = "http://127.0.0.1:5175";
const sessionToken = "installed-query-composition-session-0001";
const csrfToken = "installed-query-composition-csrf-00001";
const workerToken = "installed-query-composition-worker-0001";
const authorization: AuthorizationPort = {
  authorize: async () => ({ outcome: "allow" }),
};
function baseConfig(databasePath: string): StandaloneControlApiConfig {
  return {
    databasePath,
    actor,
    defaultAgentVersionId: "business-base-agent",
    sessionToken,
    csrfToken,
    allowedOrigins: [browserOrigin],
    heartbeatIntervalMs: null,
    outboxScanIntervalMs: null,
    automationScanIntervalMs: null,
    artifactStore: new InMemoryArtifactStore(),
    artifactEncryptionKeyId: "query-composition-key",
  };
}
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend}: Control explicitly captures the borrowed installed query authority while retaining today's catalog`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 60000,
    },
    async (t) => {
      const f = await businessExecutionFixture(t, backend),
        request = await f.prepareTask("composed-query-original"),
        original = await request.create(),
        admission = await f.extensions.loadPluginTaskAdmission(
          original.binding,
        ),
        operationId = randomUUID();
      assert.ok(admission);
      // Source operation is deterministic persisted provider evidence, never a provider invocation.
      await f.operations.reserveExternalOperation({
        tenantId: actor.tenantId,
        runId: original.binding.runId,
        bindingDigest: original.binding.bindingDigest,
        operationId,
        executionId: "composed-query-op",
        idempotencyKey: "composed-query-op",
        actionDigest: digester.sha256("action"),
        requestDigest: digester.sha256("request"),
        correlationId: operationId,
        createdAt: new Date().toISOString(),
      });
      const newer = await f.upgrade(),
        runtime = await f.openWorker({
          installedPluginExecution: {
            installRoot: f.pkg.input.installRoot,
            authorization,
            resolveActor: async () => actor,
            authorizePackage: async ({ candidate, purpose }) => {
              assert.equal(candidate.packageDigest, admission.packageDigest);
              assert.equal(purpose, "observe");
              return "allow";
            },
            historicalQuery: { scope, resolveProfile: async () => scope },
          },
        });
      const host = runtime.pluginQueryHost;
      assert.ok(host);
      const calls: string[] = [];
      const port: PluginQueryHostPort = {
        async resolveRegistration(input) {
          assert.equal(this, port);
          calls.push("registration");
          return host.resolveRegistration(input);
        },
        async evaluate(input) {
          assert.equal(this, port);
          calls.push("evaluate");
          return host.evaluate(input);
        },
      };
      let entered!: () => void, release!: () => void;
      const catalogEntered = new Promise<void>((yes) => {
          entered = yes;
        }),
        gate = new Promise<void>((yes) => {
          release = yes;
        });
      const service = new RuntimeExtensionHostService({
        resolveActor: async () => actor,
        authorization,
        runtimeResolver: f.resolver,
        deployments: f.store,
        // Actual package metadata on the authenticated private catalog. Readiness is never synthesized.
        registration: () => newer,
      });
      const server = await startRuntimeExtensionHostServer({
        port: 0,
        token: workerToken,
        service: {
          async handle(input, signal) {
            entered();
            await gate;
            return service.handle(input, signal);
          },
        },
      });
      t.after(() => server.close());
      const config = {
        ...baseConfig(f.databasePath),
        pluginQueryHost: port,
        extensionWorker: { origin: server.origin, token: workerToken },
      };
      const creating =
        backend === "sqlite"
          ? createStandaloneControlApiWithExtensions(config)
          : createPostgresControlApi({
              ...config,
              connectionString: f.connectionString!,
              schema: f.schema,
              maxPoolSize: 4,
            });
      await catalogEntered;
      port.resolveRegistration = async () => {
        throw new Error("mutated-query-registration");
      };
      port.evaluate = async () => {
        throw new Error("mutated-query-evaluator");
      };
      release();
      const control = await creating;
      t.after(() => control.app.close());
      const headers = {
        "authorization": `Bearer ${sessionToken}`,
        "origin": browserOrigin,
        "x-csrf-token": csrfToken,
        "idempotency-key": "capture-composed-query-service",
      };
      const catalog = await control.app.inject({
        method: "GET",
        url: "/api/v1/extensions",
        headers,
      });
      assert.equal(catalog.statusCode, 200, catalog.body);
      assert.deepEqual(
        catalog
          .json()
          .extensions.map(
            (item: { pluginVersion: string }) => item.pluginVersion,
          ),
        [newer.manifest.version],
      );

      // Capture the actual composed service through its existing HTTP call site.
      // Host-issued pin issuance stays internal; the public v0 command shape is unchanged.
      let tasks: ExtensionTaskApplicationService | null = null;
      t.mock.method(
        ExtensionTaskApplicationService.prototype,
        "createTask",
        async function (this: ExtensionTaskApplicationService) {
          tasks = this;
          throw new ApplicationError(
            "conflict",
            "composition_service_captured",
          );
        },
      );
      const capture = await control.app.inject({
        method: "POST",
        url: `/api/v1/extensions/${newer.identity.pluginId}/tasks`,
        headers,
        payload: {
          threadId: "capture-only-thread",
          expectedThreadRevision: 1,
          intent: {
            kind: "query",
            sourceRunId: original.binding.runId,
            operationId,
          },
        },
      });
      assert.equal(capture.statusCode, 409, capture.body);
      assert.equal(capture.json().error.code, "composition_service_captured");
      t.mock.restoreAll();
      assert.ok(tasks);
      const selection = await f.installations.loadSelection({
        scope,
        pluginId: newer.identity.pluginId,
      });
      assert.ok(selection);
      const pin = parsePluginTaskAdmissionPin({
        ...request.pin,
        ...newer.identity,
        selectionRevision: selection.revision,
        action: "report.query",
      });
      await seedThread(f.store, {
        ...actor,
        threadId: "composed-internal-query",
      });
      const result = await (
        tasks as ExtensionTaskApplicationService
      ).createQueryTaskFromPlugin(
        actor,
        {
          pluginId: newer.identity.pluginId,
          threadId: "composed-internal-query",
          expectedThreadRevision: 1,
          idempotencyKey: "composed-internal-query",
          intent: {
            kind: "query",
            sourceRunId: original.binding.runId,
            operationId,
          },
        },
        pin,
      );
      assert.deepEqual(result.binding.target, original.binding.target);
      assert.equal(
        result.binding.configurationDigest,
        original.binding.configurationDigest,
      );
      assert.equal(result.creditAdmission, undefined);
      const saved = await f.extensions.loadPluginQueryTaskAdmission(
        result.binding,
      );
      assert.equal(saved?.source.packageDigest, admission.packageDigest);
      assert.equal(saved?.packageDigest, newer.identity.packageDigest);
      assert.deepEqual(calls, ["registration", "evaluate"]);
      assert.equal(f.controls.quotes, 1);
      assert.equal(f.controls.models.length, 0);
      assert.equal(f.controls.executes.length, 0);
      await control.app.close();
      // Borrowed host remains live until its Worker owner closes it.
      assert.ok(
        await host.resolveRegistration({
          actor,
          source: {
            admission,
            binding: original.binding,
            operationId,
          },
        }),
      );
      await f.closeWorker();
    },
  );

test("Control rejects an installed query port without explicit extension composition before opening storage", async () => {
  const pluginQueryHost: PluginQueryHostPort = {
    resolveRegistration: async () => {
      throw new Error("unexpected-query-dispatch");
    },
    evaluate: async () => {
      throw new Error("unexpected-query-dispatch");
    },
  };
  assert.throws(
    () =>
      createStandaloneControlApi({
        ...baseConfig("/missing-parent/should-not-be-opened.sqlite"),
        pluginQueryHost,
      }),
    /installed_plugin_query_requires_extensions/u,
  );
  await assert.rejects(
    createPostgresControlApi({
      ...baseConfig("unused"),
      connectionString: "postgres://invalid-should-not-be-opened",
      pluginQueryHost,
    }),
    /installed_plugin_query_requires_extensions/u,
  );
});

test("Control rejects a partial installed query authority before reading a private catalog", async () => {
  await assert.rejects(
    createStandaloneControlApiWithExtensions({
      ...baseConfig("/missing-parent/should-not-be-opened.sqlite"),
      extensionWorker: { origin: "http://127.0.0.1:1", token: workerToken },
      pluginQueryHost: {
        resolveRegistration: async () => null,
      } as unknown as PluginQueryHostPort,
    }),
    /installed_plugin_query_configuration_invalid/u,
  );
});
