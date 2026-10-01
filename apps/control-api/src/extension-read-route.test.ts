import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import {
  ExtensionReadApplicationService,
  ExtensionTaskApplicationService,
} from "@crewon/application";
import {
  createExtensionRunBinding,
  extensionCanonicalJson,
  parseExtensionManifest,
} from "@crewon/domain";
import { extensionManifestFixture } from "../../../packages/domain/src/extension-manifest.test-support.ts";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import {
  digest,
  timestamp,
} from "../../../packages/store/src/extension-store.test-support.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { errorResponse } from "./control-api-errors.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { registerExtensionReadRoutes } from "./extension-read-route.ts";
import { projectExtensionTask } from "./extension-task-projection.ts";

const pluginId = saveCommand.pluginId;
const baseUrl = "https://comfy.example.com:8443/";
const headers = { authorization: "Bearer read-test" };
const operationId = "11111111-2222-3333-4444-555555555555";

async function fixture(t: TestContext) {
  const f = await configurationServiceFixture(t, "sqlite");
  const manifest = parseExtensionManifest({
    ...extensionManifestFixture(pluginId),
    configurationSchema: {
      type: "object",
      properties: { baseUrl: { type: "string", maxLength: 2048, enum: null } },
      required: ["baseUrl"],
      additionalProperties: false,
    },
  });
  const registration = {
    manifest,
    manifestDigest: f.dependencies.digester.sha256(
      extensionCanonicalJson(manifest),
    ),
    implementationDigest: digest,
  };
  const dependencies = {
    ...f.dependencies,
    catalog: { list: () => [registration], resolve: () => registration },
  };
  const { ExtensionConfigurationApplicationService } = await import(
    "@crewon/application"
  );
  const configurationService = new ExtensionConfigurationApplicationService({
    ...dependencies,
    store: f.first.store,
  });
  await f.seedDeployment();
  await configurationService.saveConfiguration(actor, {
    ...saveCommand,
    parameters: { baseUrl },
  });
  await configurationService.setActivation(actor, activateCommand);
  await seedThread(f.first.parent, { ...actor, threadId: "read-thread" });
  const tasks = new ExtensionTaskApplicationService({
    ...dependencies,
    store: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    ids: { nextId: () => randomUUID() },
  });
  const admitted = await tasks.createTask(actor, {
    pluginId,
    threadId: "read-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "generate-1",
    intent: { kind: "generate", input: { prompt: "A concept image." } },
  });
  const operations = f.first.parent.externalOperationStore();
  await operations.migrate();
  const reads = new ExtensionReadApplicationService({
    ...dependencies,
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions: f.first.store,
    operations,
  });
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) => {
    const mapped = errorResponse(error, request.id);
    return reply.code(mapped.statusCode).send(mapped.body);
  });
  registerExtensionReadRoutes(app, {
    extensionReads: reads,
    identity: {
      async resolveActor(context) {
        if (context.headers.authorization !== headers.authorization)
          throw new ControlApiIdentityError("authentication", "token_required");
        return context.headers["x-foreign-space"]
          ? { ...actor, spaceId: "other-space" }
          : actor;
      },
    },
  });
  const reserve = async (id = operationId) =>
    operations.reserveExternalOperation({
      tenantId: actor.tenantId,
      runId: admitted.binding.runId,
      bindingDigest: admitted.binding.bindingDigest,
      operationId: id,
      executionId: "tool-1",
      idempotencyKey: `submit-${id}`,
      actionDigest: digest,
      requestDigest: digest,
      correlationId: id,
      createdAt: timestamp,
    });
  return {
    ...f,
    app,
    reads,
    tasks,
    operations,
    admitted,
    reserve,
    configurationService,
    dependencies,
  };
}

test("extension read routes authenticate, validate exact queries and omit execution instructions", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.app.inject({ url: "/api/v1/extensions" })).statusCode,
    401,
  );
  const catalog = await f.app.inject({ url: "/api/v1/extensions", headers });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(catalog.json().extensions[0].pluginId, pluginId);
  assert.equal(catalog.body.includes("instructions"), false);
  assert.equal(catalog.body.includes("implementationDigest"), false);
  assert.equal(catalog.body.includes("credential-1"), false);
  const runtimeUrl = `/api/v1/extensions/${pluginId}/runtime?agentVersionId=agent-1&configurationRevision=1`;
  const ready = await f.app.inject({ url: runtimeUrl, headers });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().readiness.outcome, "ready");
  f.state.readiness = {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  };
  assert.equal(
    (await f.app.inject({ url: runtimeUrl, headers })).json().readiness.outcome,
    "unavailable",
  );
  for (const url of [
    "/api/v1/extensions?tenantId=other",
    `${runtimeUrl}&configurationRevision=2`,
    `${runtimeUrl}&extra=1`,
    `/api/v1/extensions/${pluginId}/runtime?configurationRevision=1`,
    `/api/v1/extensions/${pluginId}/tasks/${f.admitted.binding.runId}?revision=1`,
  ])
    assert.equal((await f.app.inject({ url, headers })).statusCode, 400, url);
  f.state.denied = "agentVersion:read";
  assert.equal(
    (await f.app.inject({ url: runtimeUrl, headers })).statusCode,
    403,
  );
  f.state.denied = "extension:read";
  assert.equal(
    (await f.app.inject({ url: "/api/v1/extensions", headers })).statusCode,
    403,
  );
});

test("durable external status and safe image references are independent of the Run status", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const url = `/api/v1/extensions/${pluginId}/tasks/${f.admitted.binding.runId}`;
  const initial = await f.app.inject({ url, headers });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().task.runStatus, "queued");
  assert.equal(initial.json().task.operations[0].status, "submitting");
  const image = { filename: "concept.png", subfolder: "", type: "output" };
  await f.operations.advanceExternalOperation({
    tenantId: actor.tenantId,
    runId: f.admitted.binding.runId,
    bindingDigest: f.admitted.binding.bindingDigest,
    operationId,
    expectedRevision: 1,
    providerOperationId: operationId,
    status: "succeeded",
    resultJson: JSON.stringify({
      images: [
        {
          ...image,
          url: new URL(`/view?${new URLSearchParams(image)}`, baseUrl).href,
        },
      ],
    }),
    updatedAt: timestamp,
  });
  const completed = await f.app.inject({ url, headers });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().task.runStatus, "queued");
  assert.equal(completed.json().task.operations[0].status, "succeeded");
  assert.equal(
    completed.json().task.operations[0].images[0].filename,
    "concept.png",
  );
  for (const key of [
    "providerOperationId",
    "resultJson",
    "bindingDigest",
    "credential-1",
  ])
    assert.equal(completed.body.includes(key), false, key);
  assert.equal(
    (
      await f.app.inject({
        url,
        headers: { ...headers, "x-foreign-space": "1" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: url.replace(pluginId, "other.plugin"),
        headers,
      })
    ).statusCode,
    404,
  );
  f.state.denied = "run:read";
  assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
  f.state.denied = null;
  await f.configurationService.setActivation(actor, {
    ...activateCommand,
    state: "disabled",
    agentVersionId: null,
    expectedRevision: 1,
    idempotencyKey: "disable-1",
  });
  assert.equal((await f.app.inject({ url, headers })).statusCode, 200);
  await f.configurationService.setActivation(actor, {
    ...activateCommand,
    state: "revoked",
    agentVersionId: null,
    expectedRevision: 2,
    idempotencyKey: "revoke-1",
  });
  assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
});

test("query Run projection returns only its authorized original operation", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await f.reserve("99999999-2222-3333-4444-555555555555");
  await seedThread(f.first.parent, { ...actor, threadId: "query-thread" });
  const query = await f.tasks.createTask(actor, {
    pluginId,
    threadId: "query-thread",
    expectedThreadRevision: 1,
    idempotencyKey: "query-1",
    intent: {
      kind: "query",
      sourceRunId: f.admitted.binding.runId,
      operationId,
    },
  });
  const response = await f.app.inject({
    url: `/api/v1/extensions/${pluginId}/tasks/${query.binding.runId}`,
    headers,
  });
  assert.equal(response.statusCode, 200, response.body);
  const task = response.json().task;
  assert.equal(task.sourceRunId, f.admitted.binding.runId);
  assert.equal(task.operations.length, 1);
  assert.equal(task.operations[0].sourceRunId, f.admitted.binding.runId);
  assert.equal(task.operations[0].operationId, operationId);
  assert.equal(await f.count("extension_external_operations"), 2);
});

test("read readiness rechecks current permissions after the Worker await", async (t) => {
  const f = await fixture(t);
  const reads = new ExtensionReadApplicationService({
    ...f.dependencies,
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions: f.first.store,
    operations: f.operations,
    host: {
      ...f.dependencies.host,
      async evaluate() {
        f.state.denied = "extension:read";
        return f.state.readiness;
      },
    },
  });
  await assert.rejects(
    reads.getRuntime(actor, {
      pluginId,
      agentVersionId: "agent-1",
      configurationRevision: 1,
    }),
    /authorization_denied/u,
  );
});

test("cached reads recheck revocation after awaiting external operation storage", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const reads = new ExtensionReadApplicationService({
    ...f.dependencies,
    runs: f.first.parent,
    agentVersions: f.first.parent,
    extensions: f.first.store,
    operations: {
      loadExternalOperation: (input) =>
        f.operations.loadExternalOperation(input),
      async listExternalOperations(input) {
        const page = await f.operations.listExternalOperations(input);
        await f.configurationService.setActivation(actor, {
          ...activateCommand,
          state: "revoked",
          agentVersionId: null,
          expectedRevision: 1,
          idempotencyKey: "revoke-during-read",
        });
        return page;
      },
    },
  });
  await assert.rejects(
    reads.getTask(actor, { pluginId, runId: f.admitted.binding.runId }),
    /extension_access_revoked/u,
  );
});

test("result projection rejects foreign origins, rewritten view queries and unsafe filenames", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const value = await f.reads.getTask(actor, {
    pluginId,
    runId: f.admitted.binding.runId,
  });
  const image = {
    filename: "concept.png",
    subfolder: "",
    type: "output",
    url: `${baseUrl}view?filename=concept.png&subfolder=&type=output`,
  };
  const withImage = (entry: unknown) => ({
    ...value,
    operations: [
      {
        ...value.operations[0]!,
        status: "succeeded" as const,
        resultJson: JSON.stringify({ images: [entry] }),
      },
    ],
  });
  assert.equal(
    projectExtensionTask(withImage(image)).task.operations[0]?.images.length,
    1,
  );
  for (const entry of [
    {
      ...image,
      url: "https://other.example.com/view?filename=concept.png&subfolder=&type=output",
    },
    { ...image, url: image.url + "&token=secret" },
    { ...image, filename: "../concept.png" },
    { ...image, subfolder: "../private" },
    { ...image, type: "input" },
    { ...image, url: "https://user:password@comfy.example.com:8443/view" },
    { ...image, providerOperationId: operationId },
  ])
    assert.throws(
      () => projectExtensionTask(withImage(entry)),
      /extension_result_invalid/u,
    );
  assert.equal(await f.count("extension_external_operations"), 1);
});

test("Worker readiness cannot impersonate a missing Control deployment", async (t) => {
  const f = await fixture(t);
  const reads = new ExtensionReadApplicationService({
    ...f.dependencies,
    runs: f.first.parent,
    agentVersions: {
      loadAgentVersion: (input) => f.first.parent.loadAgentVersion(input),
      async loadAgentVersionDeployment() {
        return null;
      },
    },
    extensions: f.first.store,
    operations: f.operations,
  });
  const response = await reads.getRuntime(actor, {
    pluginId,
    agentVersionId: "agent-1",
    configurationRevision: 1,
  });
  assert.deepEqual(response.readiness, {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
});

test("cached task reads reject a foreign activation scope and a mismatched durable owner", async (t) => {
  const f = await fixture(t);
  const extensions = (override: Record<string, () => Promise<unknown>>) =>
    new Proxy(f.first.store, {
      get(target, property) {
        if (typeof property === "string" && Object.hasOwn(override, property))
          return override[property];
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const activation = await f.first.store.loadExtensionActivation({
    ...actor,
    pluginId,
  });
  const reads = (store: typeof f.first.store) =>
    new ExtensionReadApplicationService({
      ...f.dependencies,
      runs: f.first.parent,
      agentVersions: f.first.parent,
      extensions: store,
      operations: f.operations,
    });
  await assert.rejects(
    reads(
      extensions({
        async loadExtensionActivation() {
          return { ...activation!, spaceId: "foreign-space" };
        },
      }),
    ).getTask(actor, { pluginId, runId: f.admitted.binding.runId }),
    /extension_activation_scope_mismatch/u,
  );
  const binding = createExtensionRunBinding(
    { ...f.admitted.binding, actorId: "other-owner" },
    f.dependencies.digester,
  );
  await assert.rejects(
    reads(
      extensions({
        async loadExtensionRunBinding() {
          return binding;
        },
      }),
    ).getTask(actor, { pluginId, runId: f.admitted.binding.runId }),
    /extension_run_binding_mismatch/u,
  );
});
