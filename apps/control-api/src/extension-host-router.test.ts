import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import type { ExtensionRegistration } from "@crewon/application";
import type { ExtensionHostRequest } from "@crewon/contracts";
import {
  createExtensionConfiguration,
  extensionCanonicalJson,
  parseExtensionExecutionTarget,
  parseExtensionManifest,
  type ExtensionExecutionTarget,
} from "@crewon/domain";
import {
  ExtensionHostRouter,
  parseExtensionWorkerRouterConfig,
  type ExtensionWorkerRouterConfig,
} from "./extension-host-router.ts";
import { LoopbackExtensionHostClient } from "./extension-worker-client.ts";

test("router close drains every owner and preserves all peer cleanup failures", async (t) => {
  const original = LoopbackExtensionHostClient.prototype.close;
  const failures = [
    new Error("current_peer_close_failed"),
    new Error("historical_peer_close_failed"),
  ];
  let closed = 0;
  t.mock.method(
    LoopbackExtensionHostClient.prototype,
    "close",
    async function (this: LoopbackExtensionHostClient) {
      const index = closed++;
      await original.call(this);
      if (index < failures.length) throw failures[index];
    },
  );
  const router = new ExtensionHostRouter(config);
  await assert.rejects(router.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    return true;
  });
  assert.equal(closed, 1 + config.historicalPeers.length);
  await assert.rejects(router.loadCatalog(actor), /extension_host_closed/u);
  await assert.rejects(
    router.queryHost.evaluate(queryInput()),
    /extension_host_closed/u,
  );
});

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
  title: "Router fixture",
  description: "An isolated external operation fixture",
  task: { instructions: "Report the external operation", inputSchema: schema },
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
const oldRegistration = registration("a");
const currentRegistration = registration("d");
function registration(hex: string): ExtensionRegistration {
  return {
    manifest,
    manifestDigest: digester.sha256(extensionCanonicalJson(manifest)),
    implementationDigest: `sha256:${hex.repeat(64)}`,
  };
}
const target = parseExtensionExecutionTarget({
  executionAuthority: "crewonKernel",
  agentVersionId: "old-agent",
  agentVersionContentDigest: `sha256:${"b".repeat(64)}`,
  materializationDigest: `sha256:${"c".repeat(64)}`,
  authorityId: "authority-1",
  runtimeGeneration: "runtime-1",
  policySnapshotId: "policy-1",
  workspaceBindingId: null,
});
function configuration(selected: ExtensionRegistration = oldRegistration) {
  return createExtensionConfiguration(
    {
      schemaVersion: "crewon.extension-configuration.v0",
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      pluginId: manifest.pluginId,
      revision: 1,
      pluginVersion: manifest.version,
      manifestDigest: selected.manifestDigest,
      implementationDigest: selected.implementationDigest,
      parameters: { prompt: "configuration" },
      credentialBindings: [],
      createdByActorId: actor.actorId,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    digester,
  );
}
function queryInput() {
  return {
    actor,
    registration: oldRegistration,
    configuration: configuration(),
    agentVersionId: target.agentVersionId,
    expectedTarget: target,
  };
}
function identity(selected: ExtensionRegistration = oldRegistration) {
  return {
    pluginId: selected.manifest.pluginId,
    pluginVersion: selected.manifest.version,
    manifestDigest: selected.manifestDigest,
    implementationDigest: selected.implementationDigest,
  };
}
const config = {
  origin: "http://127.0.0.1:3201",
  token: "current-extension-host-token-with-at-least-32-bytes",
  historicalPeers: [
    {
      origin: "http://127.0.0.1:3202",
      token: "historical-extension-host-token-with-at-least-32-bytes",
    },
  ],
};
type FixtureReply = {
  registrations: readonly ExtensionRegistration[];
  target: ExtensionExecutionTarget;
};
function reply(request: ExtensionHostRequest, selected: FixtureReply) {
  const common = {
    protocol: "crewon.extension-host-response.v0",
    operation: request.operation,
    actor: request.actor,
  };
  if (request.operation === "catalog")
    return { ...common, registrations: selected.registrations };
  const configured = {
    ...common,
    registration: request.registration,
    configurationDigest: request.configuration.contentDigest,
  };
  if (request.operation === "validateConfiguration") return configured;
  return {
    ...configured,
    agentVersionId: request.agentVersionId,
    result: { outcome: "ready", target: selected.target },
  };
}
type Call = {
  origin: string;
  request: ExtensionHostRequest;
  init: RequestInit;
};
function fixture(
  t: TestContext,
  respond: (call: Call) => unknown | Promise<unknown>,
  selectedConfig: ExtensionWorkerRouterConfig = config,
) {
  const calls: Call[] = [];
  const router = new ExtensionHostRouter(selectedConfig, {
    fetch: async (url, init = {}) => {
      const call = {
        origin: new URL(String(url)).origin,
        request: JSON.parse(String(init.body)) as ExtensionHostRequest,
        init,
      };
      calls.push(call);
      assert.equal(new URL(String(url)).pathname, "/private/v0/extensions");
      assert.equal(init.redirect, "error");
      return Response.json(await respond(call));
    },
  });
  t.after(() => router.close());
  return { router, calls };
}
function defaultReply(call: Call) {
  return reply(call.request, {
    registrations: [
      call.origin === config.origin ? currentRegistration : oldRegistration,
    ],
    target,
  });
}

test("public catalog, validation and current readiness contact only the current peer", async (t) => {
  const { router, calls } = fixture(t, defaultReply);
  const catalog = await router.loadCatalog(actor);
  assert.deepEqual(catalog.list(), [currentRegistration]);
  const input = {
    actor,
    registration: currentRegistration,
    configuration: configuration(currentRegistration),
    agentVersionId: target.agentVersionId,
  };
  await router.validateConfiguration(input);
  assert.equal((await router.evaluate(input)).outcome, "ready");
  assert.deepEqual(
    calls.map((call) => call.request.operation),
    ["catalog", "validateConfiguration", "readiness"],
  );
  assert.ok(calls.every((call) => call.origin === config.origin));
  assert.ok(
    calls.every(
      (call) =>
        new Headers(call.init.headers).get("authorization") ===
        `Bearer ${config.token}`,
    ),
  );
});

test("authorized query metadata finds the exact implementation without polluting current catalog", async (t) => {
  const { router, calls } = fixture(t, defaultReply);
  assert.deepEqual(
    await router.queryHost.resolveRegistration({ actor, identity: identity() }),
    oldRegistration,
  );
  assert.deepEqual(await router.queryHost.evaluate(queryInput()), {
    outcome: "ready",
    target,
  });
  assert.ok(
    calls
      .filter((call) => call.request.operation === "readiness")
      .every((call) => call.origin === config.historicalPeers[0]!.origin),
  );
  assert.deepEqual((await router.loadCatalog(actor)).list(), [
    currentRegistration,
  ]);
  assert.deepEqual(
    await router.queryHost.resolveRegistration({
      actor,
      identity: {
        ...identity(),
        implementationDigest: `sha256:${"e".repeat(64)}`,
      },
    }),
    null,
  );
});

test("same implementation on several prepared Agents selects only the exact durable target", async (t) => {
  const second = {
    origin: "http://127.0.0.1:3203",
    token: "second-historical-extension-host-token-at-least-32-bytes",
  };
  const { router, calls } = fixture(
    t,
    (call) =>
      reply(call.request, {
        registrations: [oldRegistration],
        target:
          call.origin === second.origin
            ? target
            : { ...target, agentVersionId: "different-prepared-agent" },
      }),
    { ...config, historicalPeers: [...config.historicalPeers, second] },
  );
  assert.deepEqual(await router.queryHost.evaluate(queryInput()), {
    outcome: "ready",
    target,
  });
  assert.equal(
    calls.filter((call) => call.request.operation === "readiness").length,
    3,
  );
  for (const selected of [config, config.historicalPeers[0]!, second]) {
    const request = calls.find(
      (call) =>
        call.origin === selected.origin &&
        call.request.operation === "readiness",
    )!;
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      `Bearer ${selected.token}`,
    );
  }
});

test("every durable target field rejects peer substitution even with the same AgentVersion", async (t) => {
  const changes = [
    { agentVersionId: "other-agent" },
    { agentVersionContentDigest: `sha256:${"f".repeat(64)}` },
    { materializationDigest: `sha256:${"f".repeat(64)}` },
    { authorityId: "other-authority" },
    { runtimeGeneration: "other-runtime" },
    { policySnapshotId: "other-policy" },
    { workspaceBindingId: "other-workspace" },
  ];
  for (const change of changes) {
    const { router } = fixture(t, (call) =>
      reply(call.request, {
        registrations: [oldRegistration],
        target: { ...target, ...change },
      }),
    );
    assert.deepEqual(await router.queryHost.evaluate(queryInput()), {
      outcome: "unavailable",
      reasonCode: "extension_runtime_unavailable",
    });
    await router.close();
  }
});

test("foreign owner echoes and all registration substitutions cannot resolve an old source", async (t) => {
  for (const field of [
    "principalId",
    "actorId",
    "tenantId",
    "spaceId",
  ] as const) {
    const { router } = fixture(t, (call) => ({
      ...defaultReply(call),
      actor: { ...actor, [field]: "foreign-owner" },
    }));
    assert.equal(
      await router.queryHost.resolveRegistration({
        actor,
        identity: identity(),
      }),
      null,
    );
    await router.close();
  }
  for (const change of [
    { pluginId: "other.plugin" },
    { pluginVersion: "0.2.0" },
    { manifestDigest: `sha256:${"f".repeat(64)}` },
    { implementationDigest: `sha256:${"f".repeat(64)}` },
  ]) {
    const { router } = fixture(t, defaultReply);
    assert.equal(
      await router.queryHost.resolveRegistration({
        actor,
        identity: { ...identity(), ...change },
      }),
      null,
    );
    await router.close();
  }
});

test("query readiness rechecks identity and configuration echoes on every call", async (t) => {
  for (const change of [
    { configurationDigest: `sha256:${"f".repeat(64)}` },
    {
      registration: {
        ...identity(),
        implementationDigest: `sha256:${"f".repeat(64)}`,
      },
    },
    { agentVersionId: "other-agent" },
    { actor: { ...actor, tenantId: "other-tenant" } },
  ]) {
    const { router } = fixture(t, (call) =>
      call.request.operation === "readiness"
        ? { ...defaultReply(call), ...change }
        : defaultReply(call),
    );
    assert.equal(
      (await router.queryHost.evaluate(queryInput())).outcome,
      "unavailable",
    );
    await router.close();
  }
  let ready = true;
  const { router, calls } = fixture(t, (call) => {
    if (!ready && call.request.operation === "readiness")
      throw new Error("peer offline");
    return defaultReply(call);
  });
  assert.equal(
    (await router.queryHost.evaluate(queryInput())).outcome,
    "ready",
  );
  ready = false;
  assert.equal(
    (await router.queryHost.evaluate(queryInput())).outcome,
    "unavailable",
  );
  assert.equal(
    calls.filter((call) => call.request.operation === "readiness").length,
    2,
  );
});

test("constructor and admission snapshot caller-owned values before asynchronous catalog negotiation", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutableConfig = structuredClone(config);
  const input = {
    ...queryInput(),
    actor: { ...actor },
    registration: { ...oldRegistration },
    configuration: { ...configuration() },
    expectedTarget: { ...target },
  };
  const { router, calls } = fixture(
    t,
    async (call) => {
      if (call.request.operation === "catalog") await gate;
      return defaultReply(call);
    },
    mutableConfig,
  );
  const query = router.queryHost.evaluate(input);
  mutableConfig.origin = "http://127.0.0.1:3291";
  mutableConfig.token = "changed-current-token-with-at-least-32-bytes";
  mutableConfig.historicalPeers[0]!.origin = "http://127.0.0.1:3292";
  mutableConfig.historicalPeers[0]!.token =
    "changed-historical-token-with-at-least-32-bytes";
  input.actor.tenantId = "changed-tenant";
  input.configuration.parameters = { prompt: "changed configuration" };
  input.expectedTarget.materializationDigest = `sha256:${"f".repeat(64)}`;
  input.registration.implementationDigest = `sha256:${"f".repeat(64)}`;
  release();
  assert.deepEqual(await query, { outcome: "ready", target });
  assert.ok(
    calls.every((call) => call.request.actor.tenantId === actor.tenantId),
  );
  const readiness = calls.find(
    (call) => call.request.operation === "readiness",
  )!;
  assert.equal(readiness.origin, config.historicalPeers[0]!.origin);
  assert.equal(
    new Headers(readiness.init.headers).get("authorization"),
    `Bearer ${config.historicalPeers[0]!.token}`,
  );
});

test("close aborts catalog and readiness across every peer and prevents late or new work", async (t) => {
  for (const blockedOperation of ["catalog", "readiness"] as const) {
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const signals: AbortSignal[] = [];
    const { router, calls } = fixture(t, async (call) => {
      if (call.request.operation === blockedOperation) {
        signals.push(call.init.signal as AbortSignal);
        if (signals.length === 2) announce();
        await gate;
      }
      return reply(call.request, { registrations: [oldRegistration], target });
    });
    const pending = router.queryHost.evaluate(queryInput());
    const rejected = assert.rejects(pending, /extension_host_closed/u);
    await started;
    await router.close();
    await rejected;
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
    const previousCalls = calls.length;
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(
      router.queryHost.resolveRegistration({ actor, identity: identity() }),
      /extension_host_closed/u,
    );
    await assert.rejects(router.loadCatalog(actor), /extension_host_closed/u);
    assert.equal(calls.length, previousCalls);
  }
});

test("one phase deadline cancels all peers instead of waiting sequential peer deadlines", async (t) => {
  const signals: AbortSignal[] = [];
  const { router } = fixture(
    t,
    async (call) => {
      signals.push(call.init.signal as AbortSignal);
      return new Promise<never>(() => {});
    },
    {
      ...config,
      deadlineMs: 1000,
      historicalPeers: config.historicalPeers.map((peer) => ({
        ...peer,
        deadlineMs: 1000,
      })),
    },
  );
  const started = Date.now();
  // A real referenced timer keeps this deliberately idle fetch fixture alive.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(
      router.queryHost.resolveRegistration({ actor, identity: identity() }),
      /extension_host_deadline_exceeded/u,
    );
    assert.ok(Date.now() - started < 4000);
    assert.equal(signals.length, 2);
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    clearTimeout(keepAlive);
  }
});

test("invalid expected target and mismatched configuration are rejected before any peer dispatch", async (t) => {
  const { router, calls } = fixture(t, defaultReply);
  for (const input of [
    { ...queryInput(), agentVersionId: "other-agent" },
    {
      ...queryInput(),
      expectedTarget: { ...target, executionAuthority: "providerAgent" },
    },
    { ...queryInput(), configuration: configuration(currentRegistration) },
    { ...queryInput(), actor: { ...actor, tenantId: "other-tenant" } },
  ])
    await assert.rejects(
      router.queryHost.evaluate(input as ReturnType<typeof queryInput>),
    );
  assert.equal(calls.length, 0);
});

test("strict peer parsing bounds historical entries and never invokes getters or exposes tokens", () => {
  const parsed = parseExtensionWorkerRouterConfig(config);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.historicalPeers));
  assert.ok(Object.isFrozen(parsed.historicalPeers![0]));
  assert.equal(inspect(parsed).includes(config.token), false);
  assert.equal(
    inspect(parsed.historicalPeers).includes(config.historicalPeers[0]!.token),
    false,
  );
  let getterCalls = 0;
  const getter = Object.defineProperty({}, "origin", {
    enumerable: true,
    get() {
      getterCalls++;
      return config.origin;
    },
  });
  const sparse = new Array(1);
  for (const value of [
    { ...config, extra: "unknown" },
    {
      ...config,
      historicalPeers: Array.from({ length: 5 }, (_, index) => ({
        ...config.historicalPeers[0],
        origin: `http://127.0.0.1:${3300 + index}`,
      })),
    },
    { ...config, historicalPeers: [config] },
    {
      ...config,
      historicalPeers: [config.historicalPeers[0], config.historicalPeers[0]],
    },
    { ...config, historicalPeers: [getter] },
    { ...config, historicalPeers: sparse },
    {
      ...config,
      historicalPeers: [{ ...config.historicalPeers[0], token: "short" }],
    },
    {
      ...config,
      historicalPeers: [
        { ...config.historicalPeers[0], origin: "http://localhost:3202" },
      ],
    },
    {
      ...config,
      historicalPeers: [
        { ...config.historicalPeers[0], origin: "http://127.0.0.1:3202/path" },
      ],
    },
  ])
    assert.throws(() => parseExtensionWorkerRouterConfig(value));
  assert.equal(getterCalls, 0);
});

test("real loopback current startup remains usable with an offline historical host and query cannot substitute current target", async (t) => {
  const requests: ExtensionHostRequest[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${config.token}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as ExtensionHostRequest;
    requests.push(parsed);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        reply(parsed, {
          registrations: [oldRegistration],
          target: {
            ...target,
            materializationDigest: `sha256:${"f".repeat(64)}`,
          },
        }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const offline = createServer();
  await new Promise<void>((resolve) => offline.listen(0, "127.0.0.1", resolve));
  const offlineAddress = offline.address();
  assert.ok(offlineAddress && typeof offlineAddress === "object");
  await new Promise<void>((resolve, reject) =>
    offline.close((error) => (error ? reject(error) : resolve())),
  );
  const router = new ExtensionHostRouter({
    ...config,
    origin: `http://127.0.0.1:${address.port}`,
    historicalPeers: [
      {
        ...config.historicalPeers[0]!,
        origin: `http://127.0.0.1:${offlineAddress.port}`,
      },
    ],
  });
  t.after(async () => {
    await router.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  assert.deepEqual((await router.loadCatalog(actor)).list(), [oldRegistration]);
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["catalog"],
  );
  assert.deepEqual(await router.queryHost.evaluate(queryInput()), {
    outcome: "unavailable",
    reasonCode: "extension_runtime_unavailable",
  });
});
