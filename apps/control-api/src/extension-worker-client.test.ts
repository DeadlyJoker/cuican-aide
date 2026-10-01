import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionManifest,
} from "@crewon/domain";
import type { ExtensionHostRequest } from "@crewon/contracts";
import {
  LoopbackExtensionHostClient,
  ExtensionHostWorkerError,
} from "./extension-worker-client.ts";

const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const digester = {
  sha256: (value: string) =>
    `sha256:${createHash("sha256").update(value).digest("hex")}`,
};
const schema = {
  type: "object",
  properties: { prompt: { type: "string", maxLength: 2000, enum: null } },
  required: ["prompt"],
  additionalProperties: false,
};
const manifest = parseExtensionManifest({
  schemaVersion: "crewon.extension-manifest.v0",
  hostApi: "crewon.extensions.v0",
  pluginId: "example.video",
  version: "0.1.0",
  title: "Test plugin",
  description: "Synthetic test plugin",
  task: { instructions: "Report the external operation.", inputSchema: schema },
  configurationSchema: schema,
  credentialSlots: [],
  tools: [
    {
      operationId: "observe",
      adapterId: "example.video-api",
      description: "Observe the operation",
      inputSchema: schema,
      outputSchema: schema,
      execution: "serial",
      effect: "readOnly",
      recovery: "replaySafe",
      capability: "example.video.query",
    },
  ],
  resultViews: ["externalOperation"],
});
const registration = {
  manifest,
  manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
  implementationDigest: `sha256:${"a".repeat(64)}`,
};
const configuration = createExtensionConfiguration(
  {
    schemaVersion: "crewon.extension-configuration.v0",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    pluginId: manifest.pluginId,
    revision: 1,
    pluginVersion: manifest.version,
    manifestDigest: registration.manifestDigest,
    implementationDigest: registration.implementationDigest,
    parameters: { prompt: "configuration" },
    credentialBindings: [],
    createdByActorId: actor.actorId,
    createdAt: "2026-10-01T00:00:00.000Z",
  },
  digester,
);
const target = {
  executionAuthority: "crewonKernel",
  agentVersionId: "agent-1",
  agentVersionContentDigest: `sha256:${"b".repeat(64)}`,
  materializationDigest: `sha256:${"c".repeat(64)}`,
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
const config = {
  origin: "http://127.0.0.1:3201",
  token: "private-extension-host-token-at-least-32-bytes",
};
const input = {
  actor,
  registration,
  configuration,
  agentVersionId: target.agentVersionId,
};

function responseFor(request: ExtensionHostRequest): Record<string, unknown> {
  const common = {
    protocol: "crewon.extension-host-response.v0",
    operation: request.operation,
    actor: request.actor,
  };
  if (request.operation === "catalog")
    return { ...common, registrations: [registration] };
  const configured = {
    ...common,
    registration: request.registration,
    configurationDigest: configuration.contentDigest,
  };
  if (request.operation === "validateConfiguration") return configured;
  return {
    ...configured,
    agentVersionId: request.agentVersionId,
    result: { outcome: "ready", target },
  };
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof ExtensionHostWorkerError && error.code === expected;
}

test("uses the authenticated private path and freezes the negotiated catalog", async (context) => {
  const requests: Array<{
    url: string;
    init: RequestInit;
    request: ExtensionHostRequest;
  }> = [];
  const client = new LoopbackExtensionHostClient(config, {
    fetch: async (url, init = {}) => {
      const request = JSON.parse(String(init.body)) as ExtensionHostRequest;
      requests.push({ url: String(url), init, request });
      return json(responseFor(request));
    },
  });
  context.after(() => client.close());
  const catalog = await client.loadCatalog(actor);
  assert.deepEqual(catalog.list(), [registration]);
  assert.ok(Object.isFrozen(catalog.list()));
  assert.ok(Object.isFrozen(catalog.list()[0]!.manifest.tools));
  assert.equal(
    catalog.resolve({
      pluginId: manifest.pluginId,
      pluginVersion: manifest.version,
    }),
    catalog.list()[0],
  );
  assert.equal(
    catalog.resolve({ pluginId: manifest.pluginId, pluginVersion: "0.2.0" }),
    null,
  );
  await client.validateConfiguration(input);
  assert.deepEqual(await client.evaluate(input), { outcome: "ready", target });
  assert.deepEqual(
    requests.map((entry) => entry.request.operation),
    ["catalog", "validateConfiguration", "readiness"],
  );
  for (const { url, init, request } of requests) {
    assert.equal(url, `${config.origin}/private/v0/extensions`);
    assert.equal(init.redirect, "error");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      `Bearer ${config.token}`,
    );
    assert.deepEqual(request.actor, actor);
    if (request.operation !== "catalog")
      assert.equal("manifest" in request.registration, false);
  }
});

test("rejects nonliteral loopback origins, credentials, routes, token and deadline drift", () => {
  for (const origin of [
    "http://localhost:3201",
    "http://127.1:3201",
    "http://2130706433:3201",
    "http://[::1]:3201",
    "https://127.0.0.1:3201",
    "http://127.0.0.1:3201/",
    "http://127.0.0.1:3201/path",
    "http://secret@127.0.0.1:3201",
    "http://127.0.0.1:3201?x=1",
    "http://127.0.0.1:0",
  ])
    assert.throws(
      () => new LoopbackExtensionHostClient({ ...config, origin }),
      code("extension_host_origin_invalid"),
    );
  for (const token of [
    "short",
    "a".repeat(8193),
    `${config.token}\n`,
    `${config.token} `,
  ])
    assert.throws(
      () => new LoopbackExtensionHostClient({ ...config, token }),
      code("extension_host_token_invalid"),
    );
  for (const deadlineMs of [0, 999, 30001, 1.5])
    assert.throws(
      () => new LoopbackExtensionHostClient({ ...config, deadlineMs }),
      code("extension_host_deadline_invalid"),
    );
});

test("validates configuration scope, manifest and digests before crossing the boundary", async () => {
  let requests = 0;
  const client = new LoopbackExtensionHostClient(config, {
    fetch: async () => {
      requests += 1;
      return json({});
    },
  });
  for (const changed of [
    { ...input, actor: { ...actor, tenantId: "other" } },
    { ...input, actor: { ...actor, injectedPrincipal: "other" } },
    {
      ...input,
      configuration: {
        ...configuration,
        contentDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      ...input,
      registration: {
        ...registration,
        implementationDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      ...input,
      registration: {
        ...registration,
        manifestDigest: `sha256:${"d".repeat(64)}`,
      },
    },
  ])
    await assert.rejects(
      client.evaluate(changed),
      code("extension_host_request_invalid"),
    );
  assert.equal(requests, 0);
  await client.close();
});

test("rejects catalog substitution, duplicate versions and invalid manifest digests", async () => {
  for (const changed of [
    {
      registrations: [
        { ...registration, manifestDigest: `sha256:${"d".repeat(64)}` },
      ],
    },
    {
      registrations: [
        { ...registration, manifest: { ...manifest, executable: "forged" } },
      ],
    },
    { registrations: [registration, registration] },
    { actor: { ...actor, principalId: "other" } },
    {
      operation: "validateConfiguration",
      registration: {
        pluginId: manifest.pluginId,
        pluginVersion: manifest.version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      },
      configurationDigest: configuration.contentDigest,
    },
  ]) {
    const client = new LoopbackExtensionHostClient(config, {
      fetch: async (_url, init) =>
        json({ ...responseFor(JSON.parse(String(init?.body))), ...changed }),
    });
    await assert.rejects(
      client.loadCatalog(actor),
      code("extension_host_response_invalid"),
    );
    await client.close();
  }
});

test("checks every configuration, version and current actor echo and rejects providerAgent targets", async () => {
  for (const changed of [
    { actor: { ...actor, actorId: "other" } },
    { configurationDigest: `sha256:${"d".repeat(64)}` },
    { agentVersionId: "other" },
    {
      registration: {
        pluginId: manifest.pluginId,
        pluginVersion: "0.2.0",
        manifestDigest: registration.manifestDigest,
        implementationDigest: registration.implementationDigest,
      },
    },
    {
      registration: {
        pluginId: manifest.pluginId,
        pluginVersion: manifest.version,
        manifestDigest: registration.manifestDigest,
        implementationDigest: `sha256:${"d".repeat(64)}`,
      },
    },
    {
      result: {
        outcome: "ready",
        target: { ...target, executionAuthority: "providerAgent" },
      },
    },
    {
      result: {
        outcome: "ready",
        target: { ...target, agentVersionId: "other" },
      },
    },
    {
      result: {
        outcome: "ready",
        target: { ...target, materializationDigest: "invalid" },
      },
    },
    { result: { outcome: "unavailable", reasonCode: "untrusted" } },
    { rawBody: "private" },
  ]) {
    const client = new LoopbackExtensionHostClient(config, {
      fetch: async (_url, init) =>
        json({ ...responseFor(JSON.parse(String(init?.body))), ...changed }),
    });
    await assert.rejects(
      client.evaluate(input),
      code("extension_host_response_invalid"),
    );
    await client.close();
  }
  const client = new LoopbackExtensionHostClient(config, {
    fetch: async (_url, init) =>
      json({
        ...responseFor(JSON.parse(String(init?.body))),
        result: {
          outcome: "unavailable",
          reasonCode: "extension_runtime_unavailable",
        },
      }),
  });
  assert.deepEqual(await client.evaluate(input), {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
  await client.close();
});

test("rejects malformed, oversized and unauthenticated responses without exposing bodies", async () => {
  const encoder = new TextEncoder();
  for (const response of [
    json({ secret: "private" }, 401),
    new Response("redirect", {
      status: 302,
      headers: { location: "https://other.example" },
    }),
    new Response("not json", { headers: { "content-type": "text/plain" } }),
    new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "131073",
      },
    }),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(" ".repeat(131073)));
          controller.close();
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const client = new LoopbackExtensionHostClient(config, {
      fetch: async () => response,
    });
    await assert.rejects(
      client.loadCatalog(actor),
      (error: unknown) =>
        error instanceof ExtensionHostWorkerError &&
        !error.message.includes("private"),
    );
    await client.close();
  }
});

test("close aborts active fetch and stalled response reads and prohibits new requests", async () => {
  for (const stalledBody of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const client = new LoopbackExtensionHostClient(config, {
      fetch: async (_url, init) => {
        signal = init?.signal as AbortSignal;
        started();
        if (!stalledBody) return new Promise<Response>(() => {});
        return new Response(new ReadableStream({}), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const pending = client.loadCatalog(actor);
    const rejected = assert.rejects(pending, code("extension_host_closed"));
    await ready;
    if (stalledBody) await new Promise((resolve) => setImmediate(resolve));
    await client.close();
    await rejected;
    assert.equal(signal?.aborted, true);
    await assert.rejects(
      client.loadCatalog(actor),
      code("extension_host_closed"),
    );
  }
});

test("a real loopback listener receives exact operations and fails closed on bearer rejection", async (context) => {
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${config.token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    assert.equal(request.url, "/private/v0/extensions");
    let body = "";
    for await (const chunk of request) body += chunk;
    const value = JSON.parse(body) as ExtensionHostRequest;
    seen.push(value.operation);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responseFor(value)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const client = new LoopbackExtensionHostClient({ ...config, origin });
  const rejected = new LoopbackExtensionHostClient({
    ...config,
    origin,
    token: "wrong-token-with-at-least-32-byte-value",
  });
  context.after(() => Promise.all([client.close(), rejected.close()]));
  await client.loadCatalog(actor);
  await client.validateConfiguration(input);
  assert.equal((await client.evaluate(input)).outcome, "ready");
  assert.deepEqual(seen, ["catalog", "validateConfiguration", "readiness"]);
  await assert.rejects(
    rejected.loadCatalog(actor),
    code("extension_host_authentication_failed"),
  );
});
