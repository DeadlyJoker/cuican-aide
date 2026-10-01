import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { createExtensionConfiguration } from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { parseExtensionHostResponse } from "@crewon/contracts";
import { processAgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { compileRuntimeAgentVersion } from "./standalone-composition.ts";
import type { RuntimeBindingConfig } from "./runtime-binding-config.ts";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import { resolveRuntimeExtensionEnvironment } from "./extensions/extension-process-environment.ts";
import {
  composeRuntimeExtensions,
  extensionCompositionDeployments,
  type RuntimeExtensionCompositionConfig,
} from "./extensions/extension-runtime-composition.ts";

type Binding = RuntimeBindingConfig["bindings"][number];
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};

function fixture(t: TestContext, backend: "sqlite" | "postgres") {
  const f = compositionFixture(t, backend);
  const baseConfig = {
    ...f.config,
    transport: { ...f.config.transport, adapterName: "direct-responses" },
  };
  const version = compileComfyAgentVersion({
    base: {
      executionAuthority: "crewonKernel",
      version: compileRuntimeAgentVersion(baseConfig),
    },
    agentVersionId: "comfy-plugin-version",
    runtimeGeneration: f.config.route.runtimeGeneration,
    policySnapshotId: "comfy-plugin-policy",
    digester,
  });
  const registration = bundledComfyRegistration();
  const configuration = createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: f.config.runtimeTenantId,
      spaceId: "space-1",
      pluginId: registration.manifest.pluginId,
      pluginVersion: registration.manifest.version,
      revision: 1,
      manifestDigest: registration.manifestDigest,
      implementationDigest: registration.implementationDigest,
      parameters: { baseUrl: "https://comfy.example/" },
      credentialBindings: [],
      createdByActorId: "actor-1",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    digester,
  );
  const extensionPath = join(f.root, "comfy-extension.json");
  writeFileSync(
    extensionPath,
    JSON.stringify({
      schemaVersion: "crewon.extension-runtime-config.v0",
      configuration,
      approvalRequirement: "none",
    }),
  );
  const binding: Binding = {
    tenantId: f.config.runtimeTenantId,
    agentVersionId: version.agentVersionId,
    contentDigest: version.contentDigest,
    authorityId: "comfy-authority",
    workspaceBindingId: null,
    provider: {
      kind: "directResponses",
      endpoint: "https://provider.example/v1/responses",
      apiKeyEnvironment: null,
      storeResponses: false,
      requestProfile: "standard",
      idleTimeoutMs: 60_000,
      sequencePolicy: "required",
    },
    mcpStdioConfigPath: null,
    deviceToolConfigPath: null,
    remoteMcpConfigPath: null,
    extensionConfigPath: extensionPath,
  };
  const path = join(f.root, "runtime-bindings.json");
  const writeBindings = (bindings: readonly Binding[]) => {
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings,
      }),
    );
  };
  writeBindings([binding]);
  const extensionRuntime: RuntimeExtensionCompositionConfig = {
    runtimeBindingsPath: path,
    environment: {},
    authorization: { authorize: async () => ({ outcome: "allow" }) },
    resolveActor: async (owner) => ({ ...owner, principalId: "principal-1" }),
  };
  const boundary = {
    config: extensionRuntime,
    tenantId: f.config.runtimeTenantId,
    defaultAgentVersionId: f.config.route.agentVersionId,
  };
  const ordinaryBinding = (compiled: CompiledAgentVersion): Binding => {
    const { extensionConfigPath: _, ...ordinary } = binding;
    return {
      ...ordinary,
      agentVersionId: compiled.agentVersionId,
      contentDigest: compiled.contentDigest,
      authorityId: f.config.route.authorityId,
    };
  };
  const additionalBinding = ordinaryBinding(
    compileRuntimeAgentVersion({
      ...baseConfig,
      route: { ...baseConfig.route, agentVersionId: "another-agent-version" },
    }),
  );
  const openStore = async () => {
    if (backend === "sqlite")
      return new SqliteRunStore(join(f.root, "control.sqlite"));
    const connectionString = process.env.CREWON_TEST_POSTGRES_URL!;
    const schema = `extension_composition_${createHash("sha256")
      .update(f.root)
      .digest("hex")
      .slice(0, 32)}`;
    t.after(async () => {
      const admin = new Pool({ connectionString, max: 1 });
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    return await PostgresDomainStore.open({
      connectionString,
      schema,
      maxPoolSize: 2,
    });
  };
  return {
    ...f,
    version,
    binding,
    configuration,
    registration,
    additionalBinding,
    extensionRuntime,
    boundary,
    writeBindings,
    ordinaryBinding,
    openStore,
    deployments: () => extensionCompositionDeployments(boundary),
    activateExtensions: () =>
      f.activate({
        additionalAgentVersions: [version],
        agentVersionDeployments: extensionCompositionDeployments(boundary),
      }),
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15_000,
  };
  test(
    `${backend}: metadata host serves catalog before plugin publication without changing the default Agent`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      const token = "composition-metadata-host-token-at-least-32-bytes";
      const parsed = resolveRuntimeExtensionEnvironment(
        {
          CREWON_EXTENSIONS_ENABLED: "1",
          CREWON_EXTENSION_HOST_PORT: "0",
          CREWON_EXTENSION_HOST_TOKEN: token,
          CREWON_PRINCIPAL_ID: "principal-1",
          CREWON_ACTOR_ID: "actor-1",
          CREWON_TENANT_ID: f.config.runtimeTenantId,
          CREWON_SPACE_ID: "space-1",
        },
        "standalone",
      );
      assert.ok(parsed);
      await f.activate();
      f.observeStoreClose();
      const runtime = await f.create({ extensionHost: parsed.host });
      t.after(() => runtime.close());
      assert.deepEqual(
        runtime.agentVersion,
        compileRuntimeAgentVersion(f.config),
      );
      assert.ok(runtime.extensionHostOrigin);
      const post = async (body: unknown) => {
        const response = await fetch(
          `${runtime.extensionHostOrigin}/private/v0/extensions`,
          {
            method: "POST",
            headers: {
              "authorization": `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              protocol: "crewon.extension-host-request.v0",
              actor: parsed.actor,
              ...(body as object),
            }),
          },
        );
        assert.equal(response.status, 200);
        return parseExtensionHostResponse(await response.json());
      };
      const catalog = await post({ operation: "catalog" });
      assert.equal(catalog.operation, "catalog");
      if (catalog.operation === "catalog")
        assert.equal(
          catalog.registrations[0]!.manifestDigest,
          f.registration.manifestDigest,
        );
      const readiness = await post({
        operation: "readiness",
        registration: {
          pluginId: f.registration.manifest.pluginId,
          pluginVersion: f.registration.manifest.version,
          manifestDigest: f.registration.manifestDigest,
          implementationDigest: f.registration.implementationDigest,
        },
        configuration: f.configuration,
        agentVersionId: f.version.agentVersionId,
      });
      assert.equal(readiness.operation, "readiness");
      if (readiness.operation === "readiness")
        assert.deepEqual(readiness.result, {
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        });
      await runtime.close();
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );
  test(
    `${backend}: separate base bindings combine with the plugin without altering bootstrap`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      const bootstrap = compileRuntimeAgentVersion(f.config);
      const basePath = join(f.root, "ordinary-runtime-bindings.json");
      writeFileSync(
        basePath,
        JSON.stringify({
          schemaVersion: "crewon.agent-version-runtime-bindings.v0",
          bindings: [f.ordinaryBinding(bootstrap)],
        }),
      );
      const config = {
        ...f.extensionRuntime,
        additionalRuntimeBindingsPaths: [basePath],
      };
      const deployments = extensionCompositionDeployments({
        ...f.boundary,
        config,
      });
      await f.activate({
        additionalAgentVersions: [f.version],
        agentVersionDeployments: deployments,
      });
      const runtime = await f.create({
        extensionRuntime: config,
        additionalAgentVersions: [f.version],
      });
      t.after(() => runtime.close());
      assert.deepEqual(runtime.agentVersion, bootstrap);
      assert.deepEqual(
        deployments.map((item) => item.agentVersionId),
        [f.version.agentVersionId],
      );
      assert.throws(
        () =>
          extensionCompositionDeployments({
            ...f.boundary,
            config: {
              ...config,
              additionalRuntimeBindingsPaths: [
                f.extensionRuntime.runtimeBindingsPath,
              ],
            },
          }),
        /extension_runtime_bindings_invalid/u,
      );
      writeFileSync(
        basePath,
        JSON.stringify({
          schemaVersion: "crewon.agent-version-runtime-bindings.v0",
          bindings: [f.binding],
        }),
      );
      assert.throws(() =>
        extensionCompositionDeployments({ ...f.boundary, config }),
      );
    },
  );
  test(
    `${backend}: two private host owners are rejected before opening storage`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      f.observeStoreClose();
      await assert.rejects(
        f.create({
          extensionHost: {
            port: 0,
            token: "composition-owner-token-at-least-32-bytes",
            authorization: f.extensionRuntime.authorization,
            resolveActor: f.extensionRuntime.resolveActor,
          },
          extensionRuntime: {
            ...f.extensionRuntime,
            privateHost: {
              port: 0,
              token: "composition-owner-token-at-least-32-bytes",
            },
          },
        }),
        /extension_host_configuration_conflict/u,
      );
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
    },
  );
  for (const scenario of [
    "default override",
    "foreign tenant",
    "missing plugin",
  ] as const) {
    test(
      `${backend}: extension opt-in rejects ${scenario} before storage and closes transferred inputs once`,
      options,
      async (t) => {
        const f = fixture(t, backend);
        if (scenario === "default override")
          f.writeBindings([
            { ...f.binding, agentVersionId: f.config.route.agentVersionId },
          ]);
        else if (scenario === "foreign tenant")
          f.writeBindings([
            f.binding,
            { ...f.additionalBinding, tenantId: "other-tenant" },
          ]);
        else f.writeBindings([f.additionalBinding]);
        f.observeStoreClose();
        const code =
          scenario === "default override"
            ? "extension_default_agent_override_forbidden"
            : scenario === "foreign tenant"
              ? "runtime_deployment_tenant_mismatch"
              : "extension_runtime_bindings_invalid";
        await assert.rejects(
          f.create({ extensionRuntime: f.extensionRuntime }),
          (error) => error instanceof Error && error.message === code,
        );
        assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
      },
    );
  }

  for (const conflict of ["factory", "deployments"] as const) {
    test(
      `${backend}: opt-in rejects an existing ${conflict} configuration`,
      options,
      async (t) => {
        const f = fixture(t, backend);
        f.observeStoreClose();
        const legacy =
          conflict === "factory"
            ? {
                agentVersionRuntimeFactory: {
                  create: async () =>
                    assert.fail("legacy factory must not run"),
                },
              }
            : { agentVersionDeployments: [] };
        await assert.rejects(
          f.create({ extensionRuntime: f.extensionRuntime, ...legacy }),
          /extension_runtime_factory_configuration_conflict/u,
        );
        assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 0 });
      },
    );
  }

  test(
    `${backend}: failure after explicit plugin release activation closes owned resources once`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      await f.activateExtensions();
      f.observeStoreClose();
      const capacity = processAgentRuntimeCapacity.snapshot();
      await assert.rejects(
        f.create({
          extensionRuntime: f.extensionRuntime,
          additionalAgentVersions: [f.version],
          leaseDurationMs: 0,
        }),
        /worker_lease_duration_invalid/u,
      );
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
      assert.deepEqual(processAgentRuntimeCapacity.snapshot(), capacity);
    },
  );

  test(
    `${backend}: an ordinary default binding preserves bootstrap behavior and explicit plugin release`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      const bootstrap = compileRuntimeAgentVersion(f.config);
      f.writeBindings([f.binding, f.ordinaryBinding(bootstrap)]);
      assert.deepEqual(
        f.deployments().map((deployment) => deployment.agentVersionId),
        [f.version.agentVersionId],
      );
      await f.activateExtensions();
      f.observeStoreClose();
      const runtime = await f.create({
        extensionRuntime: f.extensionRuntime,
        additionalAgentVersions: [f.version],
      });
      t.after(() => runtime.close());
      assert.deepEqual(runtime.agentVersion, bootstrap);
      assert.equal(
        runtime.agentVersionRegistry.resolve({
          tenantId: f.config.runtimeTenantId,
          agentVersionId: bootstrap.agentVersionId,
        })?.extensions,
        undefined,
      );
      await runtime.close();
      await runtime.close();
      assert.deepEqual(f.counts, { tools: 1, models: 1, stores: 1 });
    },
  );

  for (const change of [
    "extra binding",
    "foreign tenant",
    "default plugin",
  ] as const) {
    test(
      `${backend}: metadata-to-factory boundary rejects ${change} inserted into the deployment file`,
      options,
      async (t) => {
        const f = fixture(t, backend);
        const expectedDeployments = f.deployments();
        if (change === "default plugin") {
          const { schemaVersion: _, contentDigest: __, ...body } = f.version;
          const attempted = compileAgentVersion(
            {
              ...body,
              schemaVersion: "crewon.agent-version-source.v0",
              agentVersionId: f.config.route.agentVersionId,
            },
            digester,
          );
          f.writeBindings([
            f.binding,
            {
              ...f.binding,
              agentVersionId: attempted.agentVersionId,
              contentDigest: attempted.contentDigest,
            },
          ]);
        } else
          f.writeBindings([
            f.binding,
            {
              ...f.additionalBinding,
              tenantId:
                change === "foreign tenant"
                  ? "other-tenant"
                  : f.config.runtimeTenantId,
            },
          ]);
        const store = await f.openStore();
        try {
          const code =
            change === "extra binding"
              ? "agent_version_runtime_materialization_drift"
              : change === "foreign tenant"
                ? "runtime_deployment_tenant_mismatch"
                : "extension_default_agent_override_forbidden";
          await assert.rejects(
            composeRuntimeExtensions({
              ...f.boundary,
              store,
              expectedDeployments,
            }),
            (error) => error instanceof Error && error.message === code,
          );
        } finally {
          await store.close();
        }
      },
    );
  }

  test(
    `${backend}: factory construction uses the checked binding snapshot across migration awaits`,
    options,
    async (t) => {
      const f = fixture(t, backend);
      const expectedDeployments = f.deployments();
      const store = await f.openStore();
      try {
        const operations = store.externalOperationStore();
        const migrate = operations.migrate.bind(operations);
        t.mock.method(operations, "migrate", async () => {
          await migrate();
          f.writeBindings([
            f.binding,
            { ...f.additionalBinding, tenantId: "other-tenant" },
          ]);
        });
        t.mock.method(store, "externalOperationStore", () => operations);
        const factory = await composeRuntimeExtensions({
          ...f.boundary,
          store,
          expectedDeployments,
        });
        assert.deepEqual(
          factory.deploymentBindings(f.config.runtimeTenantId),
          expectedDeployments,
        );
        assert.deepEqual(factory.deploymentBindings("other-tenant"), []);
        assert.throws(f.deployments, /runtime_deployment_tenant_mismatch/u);
      } finally {
        await store.close();
      }
    },
  );
}
