import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  createExtensionConfiguration,
  createExtensionRunBinding,
  extensionCanonicalJson,
  parseExtensionManifest,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import {
  INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
  parseInstalledPluginPeerRequest,
  type InstalledPluginPeerRequest,
} from "@crewon/contracts/plugins";
import {
  InstalledPluginPeerClient,
  InstalledPluginPeerError,
} from "./installed-plugin-peer-client.ts";
import { requireExtensionRegistration } from "../../../packages/application/src/extension-application-support.ts";

// Protocol fixtures only: these DTOs never stand in for installed bytes, real balances or paid admission.
const actor = {
  principalId: "principal-1",
  actorId: "actor-1",
  tenantId: "tenant-1",
  spaceId: "space-1",
};
const scope = {
  tenantId: actor.tenantId,
  spaceId: actor.spaceId,
  profileId: "profile-1",
};
const digester = {
  sha256: (input: string) =>
    `sha256:${createHash("sha256").update(input).digest("hex")}`,
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
  title: "Protocol fixture",
  description: "Protocol fixture only",
  task: { instructions: "Report an external result.", inputSchema: schema },
  configurationSchema: schema,
  credentialSlots: [],
  tools: [
    {
      operationId: "observe",
      adapterId: "example.video-api",
      description: "Observe",
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
const identity = {
  pluginId: manifest.pluginId,
  publisherId: "example.publisher",
  version: manifest.version,
  packageDigest: digester.sha256("package fixture"),
  manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
  implementationDigest: digester.sha256("implementation fixture"),
};
const configuration = createExtensionConfiguration(
  {
    schemaVersion: "crewon.extension-configuration.v0",
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    pluginId: identity.pluginId,
    revision: 1,
    pluginVersion: identity.version,
    manifestDigest: identity.manifestDigest,
    implementationDigest: identity.implementationDigest,
    parameters: { prompt: "configured fixture" },
    credentialBindings: [],
    createdByActorId: actor.actorId,
    createdAt: "2026-10-03T00:00:00.000Z",
  },
  digester,
);
const target = {
  executionAuthority: "crewonKernel" as const,
  agentVersionId: "agent-1",
  agentVersionContentDigest: digester.sha256("agent fixture"),
  materializationDigest: digester.sha256("runtime fixture"),
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
};
const entry = { identity, manifest, configuration, configuredTarget: target };
const clientConfiguration = {
  origin: "http://127.0.0.1:3217",
  token: "installed-peer-test-token-at-least-32-bytes",
};
function response(
  request: InstalledPluginPeerRequest,
): Record<string, unknown> {
  const common = {
    protocol: INSTALLED_PLUGIN_PEER_RESPONSE_PROTOCOL,
    operation: request.operation,
    requestId: request.requestId,
    actor: request.actor,
    scope: request.scope,
  };
  if (request.operation === "catalog") return { ...common, entries: [entry] };
  if (request.operation === "queryResolveRegistration")
    return {
      ...common,
      expectedSource: request.expectedSource,
      registration: { identity, manifest },
    };
  const configured = {
    ...common,
    identity: request.identity,
    configurationDigest: configuration.contentDigest,
  };
  if (request.operation === "validateConfiguration") return configured;
  return {
    ...configured,
    ...(request.operation === "queryReadiness"
      ? { expectedSource: request.expectedSource }
      : {}),
    expectedTarget: request.expectedTarget,
    result: { outcome: "ready", target },
  };
}
function code(expected: string) {
  return (error: unknown) =>
    error instanceof InstalledPluginPeerError &&
    error.code === `installed_plugin_peer_${expected}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function sourceFixture() {
  const binding = createExtensionRunBinding(
    {
      schemaVersion: "crewon.extension-run-binding.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: identity.pluginId,
      runId: "source-run",
      threadId: "source-thread",
      actorId: actor.actorId,
      configurationRevision: configuration.revision,
      configurationDigest: configuration.contentDigest,
      target,
      inputDigest: digester.sha256("source input"),
      source: null,
    },
    digester,
  );
  const admission = parsePluginTaskAdmission({
    schemaVersion: "crewon.plugin-task-admission.v1",
    ...scope,
    pluginId: identity.pluginId,
    publisherId: identity.publisherId,
    version: identity.version,
    packageDigest: identity.packageDigest,
    selectionRevision: 1,
    principalId: actor.principalId,
    actorId: actor.actorId,
    contributionId: "example.studio",
    action: "image.generate",
    authorityEpoch: "epoch-1",
    runId: binding.runId,
    threadId: binding.threadId,
    extensionBindingDigest: binding.bindingDigest,
    requestDigest: digester.sha256("source request"),
    idempotencyKey: "source-key",
  });
  return { admission, binding, operationId: randomUUID() };
}

test("actual private HTTP negotiates actor/profile metadata and carries complete immutable package and target pins", async (t) => {
  const seen: InstalledPluginPeerRequest[] = [];
  const server = createServer(async (request, reply) => {
    assert.equal(request.url, "/private/v1/installed-plugins");
    assert.equal(
      request.headers.authorization,
      `Bearer ${clientConfiguration.token}`,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = parseInstalledPluginPeerRequest(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    seen.push(input);
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify(response(input)));
  });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(
    () =>
      new Promise<void>((yes) => {
        server.closeAllConnections();
        server.close(() => yes());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new InstalledPluginPeerClient({
    ...clientConfiguration,
    origin: `http://127.0.0.1:${address.port}`,
  });
  t.after(() => client.close());
  const prepared = await client.prepare({ actor, scope });
  const registration = prepared.catalog.list()[0]!;
  assert.ok(Object.isFrozen(registration.manifest.tools));
  assert.equal(
    prepared.catalog.resolve({
      pluginId: identity.pluginId,
      pluginVersion: identity.version,
    }),
    registration,
  );
  assert.equal(
    prepared.host.taskAdmissionMode?.({ registration }),
    "installed",
  );
  await prepared.host.validateConfiguration({
    actor,
    registration,
    configuration,
  });
  assert.deepEqual(
    await prepared.host.evaluate({
      actor,
      registration,
      configuration,
      agentVersionId: target.agentVersionId,
    }),
    { outcome: "ready", target },
  );
  assert.deepEqual(
    seen.map((request) => request.operation),
    ["catalog", "validateConfiguration", "readiness"],
  );
  const last = seen[2]!;
  assert.equal(last.operation, "readiness");
  if (last.operation === "readiness") {
    assert.deepEqual(last.identity, identity);
    assert.deepEqual(last.expectedTarget, target);
  }
});

test("prepared snapshots accept the original Application projection and reject actor, profile or metadata drift", async (t) => {
  let calls = 0;
  const client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async (_, init) => {
      calls++;
      return Response.json(
        response(
          parseInstalledPluginPeerRequest(JSON.parse(String(init?.body))),
        ),
      );
    },
  });
  t.after(() => client.close());
  const first = await client.prepare({ actor, scope });
  const second = await client.prepare({ actor, scope });
  const registration = first.catalog.list()[0]!;
  await assert.rejects(
    first.host.evaluate({
      actor: { ...actor, principalId: "other-principal" },
      registration,
      configuration,
      agentVersionId: target.agentVersionId,
    }),
    code("request_invalid"),
  );
  assert.deepEqual(
    await first.host.evaluate({
      actor,
      registration: second.catalog.list()[0]!,
      configuration,
      agentVersionId: target.agentVersionId,
    }),
    { outcome: "ready", target },
  );
  const projected = requireExtensionRegistration(
    first.catalog,
    digester,
    configuration,
  );
  assert.notEqual(projected, registration);
  assert.equal(
    first.host.taskAdmissionMode?.({ registration: projected }),
    "installed",
  );
  await first.host.validateConfiguration({
    actor,
    registration: projected,
    configuration,
  });
  await assert.rejects(
    first.host.evaluate({
      actor,
      registration: {
        ...projected,
        implementationDigest: digester.sha256("forged implementation"),
      },
      configuration,
      agentVersionId: target.agentVersionId,
    }),
    code("request_invalid"),
  );
  await assert.rejects(
    client.prepare({ actor, scope: { ...scope, tenantId: "other-tenant" } }),
    code("request_invalid"),
  );
  assert.equal(calls, 4);
});

for (const field of [
  "requestId",
  "principalId",
  "profileId",
  "publisherId",
  "packageDigest",
  "configurationDigest",
  "materializationDigest",
  "runtimeGeneration",
] as const) {
  test(`rejects ${field} response drift without substituting a ready target`, async (t) => {
    const client = new InstalledPluginPeerClient(clientConfiguration, {
      fetch: async (_, init) => {
        const request = parseInstalledPluginPeerRequest(
          JSON.parse(String(init?.body)),
        );
        const result = response(request);
        if (request.operation !== "catalog") {
          if (field === "requestId") result.requestId = "wrong-id";
          else if (field === "principalId")
            result.actor = { ...request.actor, principalId: "wrong-principal" };
          else if (field === "profileId")
            result.scope = { ...request.scope, profileId: "wrong-profile" };
          else if (field === "publisherId" || field === "packageDigest")
            result.identity = {
              ...identity,
              [field]:
                field === "publisherId"
                  ? "wrong.publisher"
                  : digester.sha256("wrong package"),
            };
          else if (field === "configurationDigest")
            result.configurationDigest = digester.sha256("wrong configuration");
          else
            result.result = {
              outcome: "ready",
              target: {
                ...target,
                [field]:
                  field === "materializationDigest"
                    ? digester.sha256("wrong runtime")
                    : "wrong-generation",
              },
            };
        }
        return Response.json(result);
      },
    });
    t.after(() => client.close());
    const prepared = await client.prepare({ actor, scope });
    await assert.rejects(
      prepared.host.evaluate({
        actor,
        registration: prepared.catalog.list()[0]!,
        configuration,
        agentVersionId: target.agentVersionId,
      }),
      code("response_invalid"),
    );
  });
}

test("one package can publish multiple Agents without selecting the first target or accepting ambiguous materializations", async (t) => {
  const secondTarget = {
    ...target,
    agentVersionId: "explicit-second-agent",
    runtimeGeneration: "second-generation",
  };
  const client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async (_, init) => {
      const request = parseInstalledPluginPeerRequest(
        JSON.parse(String(init?.body)),
      );
      const result = response(request);
      if (request.operation === "catalog")
        result.entries = [entry, { ...entry, configuredTarget: secondTarget }];
      if (request.operation === "readiness")
        result.result = { outcome: "ready", target: request.expectedTarget };
      return Response.json(result);
    },
  });
  t.after(() => client.close());
  const prepared = await client.prepare({ actor, scope });
  assert.equal(prepared.catalog.list().length, 1);
  const registration = prepared.catalog.list()[0]!;
  assert.deepEqual(
    await prepared.host.evaluate({
      actor,
      registration,
      configuration,
      agentVersionId: secondTarget.agentVersionId,
    }),
    { outcome: "ready", target: secondTarget },
  );
  const ambiguous = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async (_, init) => {
      const request = parseInstalledPluginPeerRequest(
        JSON.parse(String(init?.body)),
      );
      assert.equal(request.operation, "catalog");
      return Response.json({
        ...response(request),
        entries: [
          entry,
          {
            ...entry,
            configuredTarget: {
              ...target,
              runtimeGeneration: "other-materialization",
            },
          },
        ],
      });
    },
  });
  t.after(() => ambiguous.close());
  const other = await ambiguous.prepare({ actor, scope });
  await assert.rejects(
    other.host.evaluate({
      actor,
      registration: other.catalog.list()[0]!,
      configuration,
      agentVersionId: target.agentVersionId,
    }),
    code("request_invalid"),
  );
});

test("same business version from a different publisher or package cannot replace metadata in a prepared snapshot", async (t) => {
  for (const changed of [
    { ...identity, publisherId: "other.publisher" },
    { ...identity, packageDigest: digester.sha256("other package") },
  ]) {
    const client = new InstalledPluginPeerClient(clientConfiguration, {
      fetch: async (_, init) => {
        const request = parseInstalledPluginPeerRequest(
          JSON.parse(String(init?.body)),
        );
        return Response.json({
          ...response(request),
          entries: [
            entry,
            {
              ...entry,
              identity: changed,
              configuredTarget: { ...target, agentVersionId: "other-agent" },
            },
          ],
        });
      },
    });
    t.after(() => client.close());
    await assert.rejects(
      client.prepare({ actor, scope }),
      code("response_invalid"),
    );
  }
});

test("historical query preserves the original source package and full target when today's generation metadata differs", async (t) => {
  const source = sourceFixture();
  const requests: InstalledPluginPeerRequest[] = [];
  const client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async (_, init) => {
      const request = parseInstalledPluginPeerRequest(
        JSON.parse(String(init?.body)),
      );
      requests.push(request);
      const result = response(request);
      if (request.operation === "catalog")
        result.entries = [
          {
            ...entry,
            configuredTarget: { ...target, agentVersionId: "current-agent" },
          },
        ];
      return Response.json(result);
    },
  });
  t.after(() => client.close());
  const prepared = await client.prepare({ actor, scope });
  const registration = await prepared.pluginQueryHost.resolveRegistration({
    actor,
    source,
  });
  assert.ok(registration);
  assert.deepEqual(
    await prepared.pluginQueryHost.evaluate({
      actor,
      source,
      registration,
      configuration,
      expectedTarget: target,
    }),
    { outcome: "ready", target },
  );
  const query = requests.at(-1)!;
  assert.equal(query.operation, "queryReadiness");
  if (query.operation === "queryReadiness") {
    assert.deepEqual(query.expectedSource, source);
    assert.deepEqual(query.expectedTarget, target);
    assert.deepEqual(query.identity, identity);
  }
  const changedSource = {
    ...source,
    admission: { ...source.admission, profileId: "other-profile" },
  };
  await assert.rejects(
    prepared.pluginQueryHost.resolveRegistration({
      actor,
      source: changedSource,
    }),
    code("request_invalid"),
  );
  await assert.rejects(
    prepared.pluginQueryHost.evaluate({
      actor,
      source,
      registration,
      configuration,
      expectedTarget: { ...target, runtimeGeneration: "new-generation" },
    }),
    code("request_invalid"),
  );
});

test("timeout retains physical request capacity and close joins late ignored cancellation", async () => {
  const started = deferred<void>();
  const finish = deferred<Response>();
  let captured!: InstalledPluginPeerRequest;
  const client = new InstalledPluginPeerClient(
    { ...clientConfiguration, deadlineMs: 10, maximumRequests: 1 },
    {
      fetch: async (_, init) => {
        captured = parseInstalledPluginPeerRequest(
          JSON.parse(String(init?.body)),
        );
        started.resolve();
        return finish.promise;
      },
    },
  );
  const first = client.prepare({ actor, scope }).then(
    () => null,
    (error: unknown) => error,
  );
  await started.promise;
  await delay(20);
  assert.ok(code("deadline_exceeded")(await first));
  await assert.rejects(
    client.prepare({ actor, scope }),
    code("capacity_exceeded"),
  );
  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  await assert.rejects(client.prepare({ actor, scope }), code("closed"));
  finish.resolve(Response.json(response(captured)));
  await closing;
  assert.equal(closed, true);
});

test("reentrant fetch close sees its own already registered physical work", async () => {
  const finish = deferred<Response>();
  const entered = deferred<void>();
  let closing!: Promise<void>, captured!: InstalledPluginPeerRequest;
  let client!: InstalledPluginPeerClient;
  client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async (_, init) => {
      captured = parseInstalledPluginPeerRequest(
        JSON.parse(String(init?.body)),
      );
      closing = client.close();
      entered.resolve();
      return finish.promise;
    },
  });
  const result = client.prepare({ actor, scope }).then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  assert.ok(code("closed")(await result));
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  await delay(5);
  assert.equal(settled, false);
  finish.resolve(Response.json(response(captured)));
  await closing;
});

test("close also joins asynchronous body cancellation after a logical timeout", async () => {
  const cancelling = deferred<void>(),
    finish = deferred<void>();
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelling.resolve();
      return finish.promise;
    },
  });
  const client = new InstalledPluginPeerClient(
    { ...clientConfiguration, deadlineMs: 10, maximumRequests: 1 },
    {
      fetch: async () =>
        new Response(body, { headers: { "content-type": "text/html" } }),
    },
  );
  const first = client.prepare({ actor, scope }).then(
    () => null,
    (error: unknown) => error,
  );
  await cancelling.promise;
  await delay(20);
  assert.ok(code("deadline_exceeded")(await first));
  await assert.rejects(
    client.prepare({ actor, scope }),
    code("capacity_exceeded"),
  );
  let done = false;
  const closing = client.close().then(() => {
    done = true;
  });
  await delay(5);
  assert.equal(done, false);
  finish.resolve();
  await closing;
});

test("rejects invalid UTF-8, false body lengths and excessive empty response chunks", async (t) => {
  for (const malformed of [
    new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "3" },
    }),
  ]) {
    const client = new InstalledPluginPeerClient(clientConfiguration, {
      fetch: async () => malformed,
    });
    t.after(() => client.close());
    await assert.rejects(
      client.prepare({ actor, scope }),
      code("response_invalid"),
    );
  }
  let pulls = 0,
    cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(0));
    },
    cancel() {
      cancelled++;
    },
  });
  const client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async () =>
      new Response(body, { headers: { "content-type": "application/json" } }),
  });
  t.after(() => client.close());
  await assert.rejects(
    client.prepare({ actor, scope }),
    code("response_invalid"),
  );
  await client.close();
  assert.equal(cancelled, 1);
  assert.ok(pulls <= 16386);
});

test("rejects unsafe origin, token, accessors and input hooks before transport", async () => {
  for (const origin of [
    "http://localhost:3217",
    "http://127.1:3217",
    "http://2130706433:3217",
    "http://127.0.0.1:0",
    "http://127.0.0.1:3217/",
    "http://user@127.0.0.1:3217",
    "https://127.0.0.1:3217",
    "http://127.0.0.1:3217/path",
  ])
    assert.throws(
      () => new InstalledPluginPeerClient({ ...clientConfiguration, origin }),
      code("origin_invalid"),
    );
  for (const token of [
    "short",
    "x".repeat(8193),
    `${clientConfiguration.token}\n`,
  ])
    assert.throws(
      () => new InstalledPluginPeerClient({ ...clientConfiguration, token }),
      code("token_invalid"),
    );
  for (const value of [null, -1, 30001, 1.5])
    assert.throws(
      () =>
        new InstalledPluginPeerClient({
          ...clientConfiguration,
          deadlineMs: value as number,
        }),
      code("deadline_invalid"),
    );
  for (const value of [null, 0, 129, 1.5])
    assert.throws(
      () =>
        new InstalledPluginPeerClient({
          ...clientConfiguration,
          maximumRequests: value as number,
        }),
      code("capacity_invalid"),
    );
  let getterCalls = 0;
  assert.throws(
    () =>
      new InstalledPluginPeerClient({
        ...clientConfiguration,
        get deadlineMs() {
          getterCalls++;
          return 1000;
        },
      }),
    code("request_invalid"),
  );
  const client = new InstalledPluginPeerClient(clientConfiguration, {
    fetch: async () => {
      assert.fail("no transport");
    },
  });
  await assert.rejects(
    client.prepare({
      get actor() {
        getterCalls++;
        return actor;
      },
      scope,
    }),
    code("request_invalid"),
  );
  assert.equal(getterCalls, 0);
  await client.close();
});
