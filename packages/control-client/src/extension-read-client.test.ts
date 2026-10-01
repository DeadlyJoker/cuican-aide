import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EXTENSION_CATALOG_RESPONSE_BYTES,
  MAX_EXTENSION_READ_RESPONSE_BYTES,
  type ExtensionRuntimeQuery,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const pluginId = "crewon.comfyui-krea2";
const objectSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
const catalog = {
  extensions: [
    {
      pluginId,
      pluginVersion: "1.0.0",
      title: "ComfyUI",
      description: "Image generation",
      inputSchema: objectSchema,
      configurationSchema: objectSchema,
      credentialSlots: [],
      resultViews: ["externalResult"],
    },
  ],
};
const query = { agentVersionId: "plugin/agent", configurationRevision: 2 };
const runtime = {
  pluginId,
  ...query,
  readiness: {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  },
};
const task = {
  runId: "run:1",
  threadId: "thread-1",
  pluginId,
  pluginVersion: "1.0.0",
  configurationRevision: 2,
  runStatus: "queued",
  sourceRunId: null,
  operations: [],
  truncated: false,
};

test("plugin reads use the original session transport with exact encoded selected identities and no body", async () => {
  const controller = new AbortController();
  const requests: { url: string; init: RequestInit }[] = [];
  const responses = [catalog, runtime, { task }];
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "token",
    origin: "https://ui.test",
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift());
    },
  });
  assert.deepEqual(
    await client.listExtensions({ signal: controller.signal }),
    catalog,
  );
  assert.deepEqual(
    await client.getExtensionRuntime(pluginId, query, {
      signal: controller.signal,
    }),
    runtime,
  );
  assert.deepEqual(
    await client.getExtensionTask(pluginId, task.runId, {
      signal: controller.signal,
    }),
    { task },
  );
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://control.test/api/v1/extensions",
      "https://control.test/api/v1/extensions/crewon.comfyui-krea2/runtime?agentVersionId=plugin%2Fagent&configurationRevision=2",
      "https://control.test/api/v1/extensions/crewon.comfyui-krea2/tasks/run%3A1",
    ],
  );
  for (const { init } of requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "include");
    assert.equal(init.body, undefined);
    assert.equal(init.signal, controller.signal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(headers.get("x-csrf-token"), null);
    assert.equal(headers.get("idempotency-key"), null);
  }
});

test("catalog rejects private manifest fields and does not infer availability from metadata", async () => {
  for (const response of [
    { ...catalog, readiness: "ready" },
    { extensions: [{ ...catalog.extensions[0], instructions: "private" }] },
    {
      extensions: [
        { ...catalog.extensions[0], implementationDigest: "claimed" },
      ],
    },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () => Response.json(response),
    });
    await assert.rejects(client.listExtensions(), {
      code: "control_client_extension_catalog_invalid",
    });
  }
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () => Response.json({ extensions: [] }),
  });
  assert.deepEqual(await client.listExtensions(), { extensions: [] });
});

test("runtime reads reject mismatched plugin, selected version and configuration revision echoes", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const target = {
    executionAuthority: "crewonKernel",
    agentVersionId: query.agentVersionId,
    agentVersionContentDigest: digest,
    materializationDigest: digest,
    authorityId: "authority",
    runtimeGeneration: "ts-v0",
    policySnapshotId: "plugin-policy",
    workspaceBindingId: null,
  };
  for (const response of [
    { ...runtime, pluginId: "other.plugin" },
    { ...runtime, agentVersionId: "other-agent" },
    { ...runtime, configurationRevision: 1 },
    {
      ...runtime,
      readiness: {
        outcome: "ready",
        target: { ...target, executionAuthority: "providerAgent" },
      },
    },
    {
      ...runtime,
      readiness: {
        outcome: "ready",
        target: { ...target, agentVersionId: "other-agent" },
      },
    },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () => Response.json(response),
    });
    await assert.rejects(client.getExtensionRuntime(pluginId, query), {
      code: "control_client_extension_runtime_invalid",
    });
  }
  const ready = { ...runtime, readiness: { outcome: "ready", target } };
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () => Response.json(ready),
  });
  assert.deepEqual(await client.getExtensionRuntime(pluginId, query), ready);
});

test("task result reads cannot substitute another plugin or Run and remain immutable", async () => {
  for (const response of [
    { task: { ...task, pluginId: "other.plugin" } },
    { task: { ...task, runId: "other-run" } },
    { task: { ...task, runStatus: "done" } },
    { task: { ...task, privateField: "private" } },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () => Response.json(response),
    });
    await assert.rejects(client.getExtensionTask(pluginId, task.runId), {
      code: "control_client_extension_task_invalid",
    });
  }
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () => Response.json({ task }),
  });
  const parsed = await client.getExtensionTask(pluginId, task.runId);
  assert.ok(Object.isFrozen(parsed.task));
  assert.ok(Object.isFrozen(parsed.task.operations));
});

test("read queries reject ambient scope, invalid revisions and accessor identities before network I/O", async () => {
  let calls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const malformed of [
    { ...query, configurationRevision: 0 },
    { ...query, configurationRevision: "2" },
    { ...query, tenantId: "other" },
    { ...query, agentVersionId: "" },
    {
      configurationRevision: 2,
      get agentVersionId() {
        return assert.fail("getter invoked");
      },
    },
  ])
    await assert.rejects(
      client.getExtensionRuntime(pluginId, malformed as ExtensionRuntimeQuery),
    );
  await assert.rejects(client.getExtensionTask(pluginId, "x".repeat(129)));
  assert.equal(calls, 0);
});

test("plugin read limits cancel oversized streams for catalog, runtime and task routes", async () => {
  for (const kind of ["catalog", "runtime", "task"] as const) {
    let canceled = false,
      reads = 0;
    const chunkSize = 16 * 1024;
    const maximum =
      kind === "catalog"
        ? MAX_EXTENSION_CATALOG_RESPONSE_BYTES
        : MAX_EXTENSION_READ_RESPONSE_BYTES;
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(chunkSize).fill(32));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const pending =
      kind === "catalog"
        ? client.listExtensions()
        : kind === "runtime"
          ? client.getExtensionRuntime(pluginId, query)
          : client.getExtensionTask(pluginId, task.runId);
    await assert.rejects(pending, ControlApiProtocolError);
    assert.equal(canceled, true);
    assert.ok(reads <= maximum / chunkSize + 2);
  }
});

test("disabled read routes retain the original safe error envelope without invented fallback metadata", async () => {
  let calls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch: async () => {
      calls++;
      return Response.json(
        {
          error: {
            category: "notFound",
            code: "route_not_found",
            requestId: "request-1",
          },
        },
        { status: 404 },
      );
    },
  });
  await assert.rejects(
    client.listExtensions(),
    (error: unknown) =>
      error instanceof ControlApiClientError &&
      error.status === 404 &&
      error.code === "route_not_found",
  );
  assert.equal(calls, 1);
});
