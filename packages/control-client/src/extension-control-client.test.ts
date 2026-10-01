import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError,
  type CreateExtensionTaskRequest,
  type SaveExtensionConfigurationRequest,
  type SetExtensionActivationRequest,
} from "@crewon/contracts";
import {
  ControlApiClient,
  ControlApiClientError,
  ControlApiProtocolError,
} from "./control-api-client.ts";

const pluginId = "crewon.comfyui-krea2";
const base = `https://control.test/api/v1/extensions/${pluginId}`;
const digest = `sha256:${"a".repeat(64)}`;
const configuration = {
  schemaVersion: "crewon.extension-configuration.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  pluginId,
  revision: 1,
  pluginVersion: "1.0.0",
  manifestDigest: digest,
  implementationDigest: digest,
  parameters: { baseUrl: "https://comfy.example/" },
  credentialBindings: [],
  createdByActorId: "actor-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  contentDigest: digest,
};
const target = {
  executionAuthority: "crewonKernel",
  agentVersionId: "comfy-agent-v1",
  agentVersionContentDigest: digest,
  materializationDigest: digest,
  authorityId: "plugin-authority",
  runtimeGeneration: "ts-v0",
  policySnapshotId: "plugin-policy-v1",
  workspaceBindingId: null,
};
const activation = {
  schemaVersion: "crewon.extension-activation.v0",
  tenantId: "tenant-1",
  spaceId: "space-1",
  pluginId,
  revision: 1,
  configurationRevision: 1,
  configurationDigest: digest,
  state: "enabled",
  target,
  updatedByActorId: "actor-1",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const save: SaveExtensionConfigurationRequest = {
  pluginVersion: "1.0.0",
  expectedRevision: 0,
  parameters: configuration.parameters,
  credentialBindings: [],
};
const enable: SetExtensionActivationRequest = {
  configurationRevision: 1,
  expectedRevision: 0,
  state: "enabled",
  agentVersionId: "comfy-agent-v1",
};
const generate: CreateExtensionTaskRequest = {
  threadId: "thread-1",
  expectedThreadRevision: 1,
  intent: { kind: "generate", input: { prompt: "An image", width: 1024 } },
};
const query: CreateExtensionTaskRequest = {
  threadId: "thread-1",
  expectedThreadRevision: 1,
  intent: {
    kind: "query",
    sourceRunId: "run-original",
    operationId: "12345678-1234-1234-1234-123456789abc",
  },
};
const task = {
  disposition: "committed",
  threadId: "thread-1",
  threadRevision: 2,
  runId: "run-1",
  messageId: "message-1",
  configurationRevision: 1,
};
type Operation =
  | "getConfiguration"
  | "saveConfiguration"
  | "getActivation"
  | "setActivation"
  | "createTask";
const operations: Operation[] = [
  "getConfiguration",
  "saveConfiguration",
  "getActivation",
  "setActivation",
  "createTask",
];
function invoke(client: ControlApiClient, operation: Operation) {
  switch (operation) {
    case "getConfiguration":
      return client.getExtensionConfiguration(pluginId, { revision: 1 });
    case "saveConfiguration":
      return client.saveExtensionConfiguration(pluginId, save, "save-key");
    case "getActivation":
      return client.getExtensionActivation(pluginId);
    case "setActivation":
      return client.setExtensionActivation(pluginId, enable, "enable-key");
    case "createTask":
      return client.createExtensionTask(pluginId, generate, "task-key");
  }
}
function response(operation: Operation) {
  switch (operation) {
    case "getConfiguration":
      return { configuration };
    case "saveConfiguration":
      return { disposition: "created", configuration };
    case "getActivation":
      return { activation };
    case "setActivation":
      return { disposition: "updated", activation };
    case "createTask":
      return task;
  }
}

test("extension methods reuse authenticated fetch, session, cancellation and exact mutation headers", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const replies = [
    { configuration },
    { configuration: null },
    { disposition: "created", configuration },
    { activation },
    { disposition: "updated", activation },
    task,
    { ...task, disposition: "replayed" },
  ];
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    accessToken: "token",
    csrfToken: "csrf",
    origin: "https://ui.test",
    fetch: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return Response.json(replies.shift());
    },
  });
  assert.deepEqual(
    await client.getExtensionConfiguration(pluginId, { revision: 1 }, options),
    { configuration },
  );
  assert.deepEqual(
    await client.getExtensionConfiguration(pluginId, {}, options),
    { configuration: null },
  );
  assert.equal(
    (
      await client.saveExtensionConfiguration(
        pluginId,
        save,
        "save-key",
        options,
      )
    ).disposition,
    "created",
  );
  assert.deepEqual(await client.getExtensionActivation(pluginId, options), {
    activation,
  });
  assert.equal(
    (
      await client.setExtensionActivation(
        pluginId,
        enable,
        "enable-key",
        options,
      )
    ).disposition,
    "updated",
  );
  assert.deepEqual(
    await client.createExtensionTask(
      pluginId,
      generate,
      "generate-key",
      options,
    ),
    task,
  );
  assert.equal(
    (await client.createExtensionTask(pluginId, query, "query-key", options))
      .disposition,
    "replayed",
  );
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      base + "/configuration?revision=1",
      base + "/configuration",
      base + "/configuration",
      base + "/activation",
      base + "/activation",
      base + "/tasks",
      base + "/tasks",
    ],
  );
  assert.deepEqual(
    requests.map(({ init }) => init.method),
    ["GET", "GET", "PUT", "GET", "PUT", "POST", "POST"],
  );
  for (const { init } of requests) {
    assert.equal(init.signal, controller.signal);
    assert.equal(init.credentials, "include");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("origin"), "https://ui.test");
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(
      headers.get("x-csrf-token"),
      init.method === "GET" ? null : "csrf",
    );
  }
  assert.equal(
    new Headers(requests[2]!.init.headers).get("idempotency-key"),
    "save-key",
  );
  assert.equal(
    new Headers(requests[4]!.init.headers).get("idempotency-key"),
    "enable-key",
  );
  assert.equal(
    new Headers(requests[5]!.init.headers).get("idempotency-key"),
    "generate-key",
  );
  assert.equal(
    new Headers(requests[6]!.init.headers).get("idempotency-key"),
    "query-key",
  );
  assert.deepEqual(JSON.parse(String(requests[2]!.init.body)), save);
  assert.deepEqual(JSON.parse(String(requests[4]!.init.body)), enable);
  assert.deepEqual(JSON.parse(String(requests[5]!.init.body)), generate);
  assert.deepEqual(JSON.parse(String(requests[6]!.init.body)), query);
  assert.equal(requests[0]!.init.body, undefined);
});

test("missing configurations and activations remain nullable and disable/revoke have no target", async () => {
  for (const state of ["disabled", "revoked"] as const) {
    const disabled = { ...activation, state, target: null };
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async (_, init) =>
        Response.json(
          init?.method === "PUT"
            ? { disposition: "replayed", activation: disabled }
            : { activation: null },
        ),
    });
    assert.deepEqual(await client.getExtensionActivation(pluginId), {
      activation: null,
    });
    assert.deepEqual(
      await client.setExtensionActivation(
        pluginId,
        { ...enable, state, agentVersionId: null },
        "key",
      ),
      { disposition: "replayed", activation: disabled },
    );
  }
});

test("mutation credentials are required before network I/O", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return Response.json({});
  };
  const noCsrf = new ControlApiClient({
    baseUrl: "https://control.test",
    fetch,
  });
  for (const operation of operations.filter(
    (value) => value !== "getConfiguration" && value !== "getActivation",
  ))
    await assert.rejects(invoke(noCsrf, operation), {
      code: "control_client_csrf_token_required",
    });
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    csrfToken: "csrf",
    fetch,
  });
  for (const call of [
    () =>
      client.saveExtensionConfiguration(
        pluginId,
        save,
        undefined as unknown as string,
      ),
    () =>
      client.setExtensionActivation(
        pluginId,
        enable,
        undefined as unknown as string,
      ),
    () =>
      client.createExtensionTask(
        pluginId,
        generate,
        undefined as unknown as string,
      ),
  ])
    await assert.rejects(call, {
      code: "control_client_idempotency_key_required",
    });
  for (const key of ["", "key\nheader", "x".repeat(129)])
    await assert.rejects(client.createExtensionTask(pluginId, generate, key), {
      code: "control_client_idempotency_key_invalid",
    });
  assert.equal(calls, 0);
});

test("request validators reject injected identity, malformed intent and invalid revision before fetch", async () => {
  let calls = 0;
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    csrfToken: "csrf",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  for (const call of [
    () => client.getExtensionConfiguration("plugin/escape"),
    () => client.getExtensionConfiguration(pluginId, { revision: 0 }),
    () =>
      client.getExtensionConfiguration(pluginId, {
        revision: 1,
        tenantId: "other",
      } as { revision: number }),
    () =>
      client.saveExtensionConfiguration(
        pluginId,
        { ...save, tenantId: "other" } as SaveExtensionConfigurationRequest,
        "key",
      ),
    () =>
      client.saveExtensionConfiguration(
        pluginId,
        { ...save, parameters: { huge: "x".repeat(16385) } },
        "key",
      ),
    () =>
      client.setExtensionActivation(
        pluginId,
        { ...enable, agentVersionId: null },
        "key",
      ),
    () =>
      client.createExtensionTask(
        pluginId,
        {
          ...generate,
          runtimeGeneration: "claimed",
        } as CreateExtensionTaskRequest,
        "key",
      ),
    () =>
      client.createExtensionTask(
        pluginId,
        {
          ...query,
          intent: {
            kind: "query",
            sourceRunId: "run-1",
            operationId: "not-uuid",
          },
        },
        "key",
      ),
    () => client.createExtensionTask(pluginId, generate, "key\nheader"),
  ])
    await assert.rejects(call);
  assert.equal(calls, 0);
});

test("configuration success responses must match the plugin and requested saved revision", async () => {
  for (const malformed of [
    { ...configuration, pluginId: "other.plugin" },
    { ...configuration, revision: 2 },
    { ...configuration, tenantId: "" },
    { ...configuration, contentDigest: "claimed" },
    { ...configuration, createdAt: "2026-10-01" },
    { ...configuration, injected: true },
    {
      ...configuration,
      credentialBindings: [{ slotId: "key", credentialBindingId: "" }],
    },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async (_, init) =>
        Response.json(
          init?.method === "GET"
            ? { configuration: malformed }
            : { disposition: "created", configuration: malformed },
        ),
    });
    await assert.rejects(
      client.getExtensionConfiguration(pluginId, { revision: 1 }),
      { code: "control_client_extension_configuration_invalid" },
    );
    await assert.rejects(
      client.saveExtensionConfiguration(pluginId, save, "key"),
      ControlApiProtocolError,
    );
  }
  const wrongVersion = new ControlApiClient({
    baseUrl: "https://control.test",
    csrfToken: "csrf",
    fetch: async () =>
      Response.json({
        disposition: "created",
        configuration: { ...configuration, pluginVersion: "2.0.0" },
      }),
  });
  await assert.rejects(
    wrongVersion.saveExtensionConfiguration(pluginId, save, "key"),
    ControlApiProtocolError,
  );
  for (const changed of [
    { ...configuration, parameters: { baseUrl: "https://other.example/" } },
    {
      ...configuration,
      credentialBindings: [
        { slotId: "key", credentialBindingId: "other-credential" },
      ],
    },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () =>
        Response.json({ disposition: "created", configuration: changed }),
    });
    await assert.rejects(
      client.saveExtensionConfiguration(pluginId, save, "key"),
      ControlApiProtocolError,
    );
  }
});

test("activation success responses retain explicit kernel authority and exact mutation identity", async () => {
  for (const malformed of [
    { ...activation, pluginId: "other.plugin" },
    { ...activation, state: "enabled", target: null },
    { ...activation, state: "disabled", target },
    {
      ...activation,
      target: { ...target, executionAuthority: "providerAgent" },
    },
    {
      ...activation,
      target: { ...target, agentVersionContentDigest: "claimed" },
    },
    { ...activation, target: { ...target, injected: true } },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async (_, init) =>
        Response.json(
          init?.method === "GET"
            ? { activation: malformed }
            : { disposition: "updated", activation: malformed },
        ),
    });
    await assert.rejects(client.getExtensionActivation(pluginId), {
      code: "control_client_extension_activation_invalid",
    });
    await assert.rejects(
      client.setExtensionActivation(pluginId, enable, "key"),
      ControlApiProtocolError,
    );
  }
  for (const malformed of [
    { ...activation, configurationRevision: 2 },
    { ...activation, revision: 2 },
    { ...activation, target: { ...target, agentVersionId: "other-agent" } },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () =>
        Response.json({ disposition: "updated", activation: malformed }),
    });
    await assert.rejects(
      client.setExtensionActivation(pluginId, enable, "key"),
      ControlApiProtocolError,
    );
  }
});

test("task receipts cannot rebind the requested thread or accept stale revisions", async () => {
  for (const malformed of [
    { ...task, threadId: "other-thread" },
    { ...task, threadRevision: 1 },
    { ...task, configurationRevision: 0 },
    { ...task, runId: "" },
    { ...task, disposition: "queued" },
    { ...task, runtimeGeneration: "claimed" },
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () => Response.json(malformed),
    });
    await assert.rejects(
      client.createExtensionTask(pluginId, generate, "key"),
      { code: "control_client_extension_task_invalid" },
    );
  }
});

test("remote conflict and disabled-route errors preserve existing typed envelopes without retry", async () => {
  for (const [status, category, code] of [
    [409, "conflict", "idempotency_payload_conflict"],
    [404, "notFound", "route_not_found"],
    [403, "authorization", "extension_run_denied"],
  ] as const) {
    let calls = 0;
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () => {
        calls++;
        return Response.json(
          { error: { category, code, requestId: "request-1" } },
          { status },
        );
      },
    });
    await assert.rejects(
      client.createExtensionTask(pluginId, generate, "key"),
      (error: unknown) =>
        error instanceof ControlApiClientError &&
        error.status === status &&
        error.category === category &&
        error.code === code &&
        error.requestId === "request-1",
    );
    assert.equal(calls, 1);
  }
});

test("all extension response routes cancel oversized streamed JSON", async () => {
  for (const operation of operations) {
    let canceled = false,
      reads = 0;
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      csrfToken: "csrf",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(8192).fill(32));
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await assert.rejects(invoke(client, operation), ControlApiProtocolError);
    assert.equal(canceled, true);
    assert.ok(reads <= 6);
  }
});

test("response content type, UTF-8, JSON and unexpected statuses use existing protocol errors", async () => {
  for (const makeResponse of [
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () => Response.json(response("getConfiguration"), { status: 201 }),
  ]) {
    const client = new ControlApiClient({
      baseUrl: "https://control.test",
      fetch: async () => makeResponse(),
    });
    await assert.rejects(
      client.getExtensionConfiguration(pluginId),
      ControlApiProtocolError,
    );
  }
});

test("request parsing copies task input and configuration parameters before transport observes them", async () => {
  const requests: unknown[] = [];
  const client = new ControlApiClient({
    baseUrl: "https://control.test",
    csrfToken: "csrf",
    fetch: async (_, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(
        init?.method === "PUT"
          ? { disposition: "created", configuration }
          : task,
      );
    },
  });
  const body: SaveExtensionConfigurationRequest = {
    ...save,
    parameters: { baseUrl: "https://comfy.example/" },
  };
  const pending = client.saveExtensionConfiguration(pluginId, body, "key");
  (body.parameters as { baseUrl: string }).baseUrl = "https://changed.example/";
  await pending;
  assert.equal(
    (requests[0] as SaveExtensionConfigurationRequest).parameters.baseUrl,
    "https://comfy.example/",
  );
  const withGetter = Object.defineProperty({ ...generate }, "intent", {
    get: () => {
      throw new Error("getter_called");
    },
  });
  await assert.rejects(
    client.createExtensionTask(pluginId, withGetter, "key"),
    ContractValidationError,
  );
  assert.equal(requests.length, 1);
});
