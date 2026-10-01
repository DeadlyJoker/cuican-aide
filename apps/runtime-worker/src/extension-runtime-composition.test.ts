import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Pool } from "pg";
import {
  compileAgentVersion,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import {
  ExtensionConfigurationApplicationService,
  ExtensionTaskApplicationService,
  TurnApplicationService,
  type ExtensionHostPort,
} from "@crewon/application";
import {
  createExtensionConfiguration,
  createExtensionRunBinding,
  parseExtensionExecutionTarget,
} from "@crewon/domain";
import { PostgresDomainStore, SqliteRunStore } from "@crewon/store";
import { parseExtensionHostResponse } from "@crewon/contracts";
import { processAgentRuntimeCapacity } from "./agent-runtime-capacity.ts";
import { compileRuntimeAgentVersion } from "./standalone-composition.ts";
import type { RuntimeBindingConfig } from "./runtime-binding-config.ts";
import { compositionFixture } from "./runtime-composition.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { compileComfyAgentVersion } from "./extensions/comfyui-agent-version.ts";
import { bundledComfyRegistration } from "./extensions/comfyui-bundled-registration.ts";
import { resolveRuntimeExtensionEnvironment } from "./extensions/extension-process-environment.ts";
import {
  COMFY_OBSERVE_TOOL,
  COMFY_SUBMIT_TOOL,
} from "./extensions/comfyui-tool-catalog.ts";
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

test(
  "actual historical composition resumes an accepted bound Run, leaves unbound and other-implementation Runs untouched, then current mode executes ordinary work",
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t, "sqlite");
    const modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const last = body.input
        .filter(
          (item: { type: string }) => item.type === "function_call_output",
        )
        .at(-1);
      const output =
        last === undefined
          ? [
              {
                type: "function_call",
                id: "fc-submit",
                call_id: "submit",
                name: COMFY_SUBMIT_TOOL,
                arguments: JSON.stringify({ prompt: "A ceramic teapot" }),
              },
            ]
          : last.call_id === "submit"
            ? [
                {
                  type: "function_call",
                  id: "fc-observe",
                  call_id: "observe",
                  name: COMFY_OBSERVE_TOOL,
                  arguments: JSON.stringify({
                    operationId: JSON.parse(last.output).operationId,
                  }),
                },
              ]
            : [];
      const id = randomUUID();
      const events: Record<string, unknown>[] = [
        { type: "response.created", response: { id, status: "in_progress" } },
      ];
      for (const item of output)
        events.push({ type: "response.output_item.done", item });
      const finalText =
        output.length === 0
          ? `图片已生成：${JSON.parse(last.output).images[0].url}`
          : null;
      if (finalText !== null)
        events.push({
          type: "response.output_text.delta",
          delta: finalText,
        });
      events.push({
        type: "response.completed",
        response: {
          id,
          status: "completed",
          output:
            finalText === null
              ? output
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [{ type: "output_text", text: finalText }],
                  },
                ],
        },
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        events
          .map(
            (event, sequence_number) =>
              `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
          )
          .join(""),
      );
    });
    await new Promise<void>((resolve) =>
      modelServer.listen(0, "127.0.0.1", resolve),
    );
    t.after(async () => {
      await new Promise<void>((resolve) => {
        modelServer.close(() => resolve());
        modelServer.closeAllConnections();
      });
    });
    const address = modelServer.address();
    assert.ok(address !== null && typeof address !== "string");
    assert.equal(f.binding.provider.kind, "directResponses");
    if (f.binding.provider.kind !== "directResponses")
      throw new Error("unexpected provider");
    f.writeBindings([
      {
        ...f.binding,
        provider: {
          ...f.binding.provider,
          endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
        },
      },
    ]);
    const actor = {
      tenantId: f.config.runtimeTenantId,
      spaceId: f.configuration.spaceId,
      actorId: "actor-1",
      principalId: "principal-1",
    };
    const token = "historical-composition-private-token-at-least-32-bytes";
    const requests: string[] = [];
    const extensionRuntime = {
      ...f.extensionRuntime,
      privateHost: { port: 0, token },
      dns: {
        resolveAll: async () => [{ address: "8.8.8.8", family: 4 as const }],
      },
      transport: {
        request: async (input: {
          method: string;
          body?: Uint8Array;
          target: { endpoint: URL };
        }) => {
          const path = input.target.endpoint.pathname;
          requests.push(`${input.method} ${path}`);
          const id =
            input.method === "POST"
              ? JSON.parse(Buffer.from(input.body!).toString()).prompt_id
              : path.split("/").at(-1)!;
          const result =
            input.method === "POST"
              ? { prompt_id: id }
              : {
                  [id]: {
                    status: { completed: true, status_str: "success" },
                    outputs: {
                      "29": {
                        images: [
                          {
                            filename: `${id}.png`,
                            subfolder: "",
                            type: "output",
                          },
                        ],
                      },
                    },
                  },
                };
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(JSON.stringify(result)),
          };
        },
      },
    };
    await f.activate({
      additionalAgentVersions: [f.version],
      agentVersionDeployments: extensionCompositionDeployments({
        ...f.boundary,
        config: extensionRuntime,
      }),
    });
    const store = await f.openStore();
    t.after(() => store.close());
    const extensions = store.extensionStore();
    await extensions.migrate();
    await extensions.saveExtensionConfiguration({
      configuration: f.configuration,
      expectedRevision: 0,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "configuration",
        requestDigest: digester.sha256("configuration"),
      },
    });
    const ordinaryTransport = {
      ...f.config.transport,
      async *stream() {
        yield { type: "output.delta" as const, delta: "ordinary completed" };
        yield { type: "completed" as const, checkpoint: null };
      },
    };
    const openWorker = (mode: "current" | "historical", crash: boolean) =>
      f.create({
        transport: ordinaryTransport,
        extensionRuntime,
        extensionExecutionMode: mode,
        additionalAgentVersions: [f.version],
        retryAfterMs: 0,
        afterToolProviderResolved: async () => {
          if (crash) throw new Error("lost_after_acceptance");
        },
      });
    const current = await openWorker("current", true);
    t.after(() => current.close());
    // Readiness is returned by the actual authenticated host and compiled runtime proof.
    const post = async (
      operation: "validateConfiguration" | "readiness",
      input: Parameters<ExtensionHostPort["evaluate"]>[0],
    ) => {
      const response = await fetch(
        `${current.extensionHostOrigin}/private/v0/extensions`,
        {
          method: "POST",
          headers: {
            "authorization": `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocol: "crewon.extension-host-request.v0",
            actor: input.actor,
            operation,
            registration: {
              pluginId: input.registration.manifest.pluginId,
              pluginVersion: input.registration.manifest.version,
              manifestDigest: input.registration.manifestDigest,
              implementationDigest: input.registration.implementationDigest,
            },
            configuration: input.configuration,
            ...(operation === "readiness"
              ? { agentVersionId: input.agentVersionId }
              : {}),
          }),
        },
      );
      assert.equal(response.status, 200);
      return parseExtensionHostResponse(await response.json());
    };
    const host: ExtensionHostPort = {
      validateConfiguration: async (input) => {
        await post("validateConfiguration", {
          ...input,
          agentVersionId: f.version.agentVersionId,
        });
      },
      evaluate: async (input) => {
        const response = await post("readiness", input);
        assert.equal(response.operation, "readiness");
        if (response.operation !== "readiness")
          throw new Error("wrong operation");
        return response.result.outcome === "ready"
          ? {
              outcome: "ready",
              target: parseExtensionExecutionTarget(response.result.target),
            }
          : response.result;
      },
    };
    const catalog = {
      list: () => [f.registration],
      resolve: () => f.registration,
    };
    const clock = { now: () => new Date().toISOString() };
    const authorization = f.extensionRuntime.authorization;
    const services = {
      store: extensions,
      host,
      catalog,
      clock,
      digester,
      authorization,
    };
    const configurationService = new ExtensionConfigurationApplicationService(
      services,
    );
    const enabled = await configurationService.setActivation(actor, {
      pluginId: f.configuration.pluginId,
      configurationRevision: 1,
      expectedRevision: 0,
      idempotencyKey: "activation",
      state: "enabled",
      agentVersionId: f.version.agentVersionId,
    });
    assert.ok(enabled.activation.target);
    const ids = { nextId: () => randomUUID() };
    const tasks = new ExtensionTaskApplicationService({
      ...services,
      store,
      extensions,
      operations: store.externalOperationStore(),
      ids,
    });
    await seedThread(store, { ...actor, threadId: "image-thread" });
    const { binding } = await tasks.createTask(actor, {
      pluginId: f.configuration.pluginId,
      threadId: "image-thread",
      expectedThreadRevision: 1,
      idempotencyKey: "generate",
      intent: { kind: "generate", input: { prompt: "生成一张茶壶照片" } },
    });
    assert.deepEqual(await current.worker.wake(), {
      kind: "retried",
      runId: binding.runId,
      code: "lost_after_acceptance",
    });
    const cursor = (await store.listRunEvents(binding, 0, 100)).at(
      -1,
    )!.sequence;
    await configurationService.setActivation(actor, {
      pluginId: f.configuration.pluginId,
      configurationRevision: 1,
      expectedRevision: 1,
      idempotencyKey: "disable",
      state: "disabled",
      agentVersionId: null,
    });
    await current.close();

    const turns = new TurnApplicationService({
      store,
      clock,
      ids,
      digester,
      authorization,
    });
    const ordinary = async (threadId: string) => {
      await seedThread(store, { ...actor, threadId });
      return turns.startTurn(actor, {
        kind: "turn.start",
        idempotencyKey: threadId,
        threadId,
        expectedThreadRevision: 1,
        content: "ordinary request",
        requestedAgentVersionId: f.config.route.agentVersionId,
        executionIntent: "none",
        route: f.config.route,
      });
    };
    const plain = await ordinary("ordinary-thread");
    const other = await ordinary("uninstalled-implementation-thread");
    // This unavailable historical record is persisted test data, never a claimed ready implementation.
    const otherConfiguration = createExtensionConfiguration(
      {
        ...f.configuration,
        revision: 2,
        implementationDigest: `sha256:${"f".repeat(64)}`,
      },
      digester,
    );
    await extensions.saveExtensionConfiguration({
      configuration: otherConfiguration,
      expectedRevision: 1,
      receipt: {
        actorId: actor.actorId,
        idempotencyKey: "other-config",
        requestDigest: digester.sha256("other-config"),
      },
    });
    const otherBinding = createExtensionRunBinding(
      {
        ...binding,
        runId: other.runState.runId,
        threadId: other.threadState.threadId,
        configurationRevision: 2,
        configurationDigest: otherConfiguration.contentDigest,
      },
      digester,
    );
    const sql = new DatabaseSync(join(f.root, "control.sqlite"));
    t.after(() => sql.close());
    sql
      .prepare("INSERT INTO extension_run_bindings VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        otherBinding.tenantId,
        otherBinding.spaceId,
        otherBinding.pluginId,
        otherBinding.runId,
        2,
        JSON.stringify(otherBinding),
      );
    const before = (runId: string) =>
      sql.prepare("SELECT * FROM work_items WHERE run_id=?").get(runId);
    const plainBefore = before(plain.runState.runId);
    const otherBefore = before(other.runState.runId);
    const historical = await openWorker("historical", false);
    t.after(() => historical.close());
    assert.deepEqual(await historical.worker.wake(), {
      kind: "completed",
      runId: binding.runId,
    });
    assert.deepEqual(await historical.worker.wake(), { kind: "idle" });
    assert.deepEqual(before(plain.runState.runId), plainBefore);
    assert.deepEqual(before(other.runState.runId), otherBefore);
    assert.equal(
      (await store.loadRun(otherBinding))?.status,
      other.runState.status,
    );
    assert.equal(
      requests.filter((request) => request === "POST /prompt").length,
      1,
    );
    const events = await store.listRunEvents(binding, cursor, 100);
    assert.ok(events.every((event) => event.sequence > cursor));
    assert.match(
      events
        .filter((event) => event.type === "model.output.delta")
        .map((event) => event.data.delta)
        .join(""),
      /图片已生成：https:\/\/comfy.example\/view/u,
    );
    await historical.close();
    const resumedCurrent = await openWorker("current", false);
    t.after(() => resumedCurrent.close());
    assert.deepEqual(await resumedCurrent.worker.wake(), {
      kind: "completed",
      runId: plain.runState.runId,
    });
    assert.deepEqual(await resumedCurrent.worker.wake(), { kind: "idle" });
    assert.deepEqual(before(other.runState.runId), otherBefore);
  },
);

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
