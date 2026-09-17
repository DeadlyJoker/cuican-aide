import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseRuntimeBindingConfig } from "./runtime-binding-config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import { InMemoryRunStore } from "@crewon/store";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import type { AgentSegmentContract } from "@crewon/agent-kernel";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import {
  ConfiguredAgentVersionRuntimeFactory,
  type AgentVersionRuntimeBinding,
} from "./configured-agent-version-runtime-factory.ts";
import { digester } from "./shared-agent-runtime-cache.test-support.ts";
import {
  httpVersion,
  httpBinding,
  loadedHttpFactory,
} from "./http-runtime-residency.test-support.ts";

const createdAt = "2026-09-15T00:00:00Z";
test("the actual 256-version HTTP manifest keeps only 64 projections and preserves its deployment identity", async (t) => {
  const versions = Array.from({ length: 256 }, (_, i) => httpVersion(`v-${i}`)),
    store = new InMemoryRunStore();
  const factory = loadedHttpFactory(
      t,
      versions.map((v) => httpBinding(v)),
    ),
    owner = new InMemoryToolBroker();
  const deployments = factory.deploymentBindings("tenant");
  const registry = new InMemoryAgentVersionRuntimeRegistry(digester),
    bound = factory.bindSharedToolRuntime(owner);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    digester,
    factory: bound,
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  for (const version of versions) {
    await store.registerAgentVersion(
      createAgentVersionAsset({ tenantId: "tenant", version, createdAt }),
    );
    const runtime = await resolver.resolve({
      tenantId: "tenant",
      agentVersionId: version.agentVersionId,
    });
    assert.ok(runtime);
    assert.equal(runtime.close, undefined);
    assert.equal(runtime.toolRuntime, owner);
  }
  assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 64);
  assert.ok(
    versions.every(
      (version) =>
        registry.resolve({
          tenantId: "tenant",
          agentVersionId: version.agentVersionId,
        }) === null,
    ),
  );
  assert.deepEqual(factory.deploymentBindings("tenant"), deployments);
  const locator = { tenantId: "tenant", agentVersionId: "v-0" };
  assert.equal(resolver.resolveResident(locator), null);
  const restored = await resolver.resolve(locator);
  for (let i = 0; i < 10000; i++)
    assert.equal(resolver.resolveResident(locator), restored);
  assert.equal(resolver.nextToolResultMaintenanceRuntime(), owner);
  assert.equal(
    bound.runtimeOwnership?.({ tenantId: "tenant", version: versions[0]! }),
    "sharedProjection",
  );
  assert.throws(
    () =>
      bound.runtimeOwnership?.({ tenantId: "other", version: versions[0]! }),
    { message: "agent_version_runtime_not_deployed" },
  );
});

test("a mixed factory keeps real owned transports and independently owned Tools pinned", async (t) => {
  const shared = httpVersion("shared"),
    owned = httpVersion("owned"),
    store = new InMemoryRunStore();
  const baseFactory = loadedHttpFactory(t, [
    httpBinding(shared),
    httpBinding(owned, { toolRuntimeMode: "independent" }),
  ]);
  const owner = new InMemoryToolBroker(),
    bound = baseFactory.bindSharedToolRuntime(owner),
    registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    digester,
    factory: bound,
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  for (const version of [shared, owned])
    await store.registerAgentVersion(
      createAgentVersionAsset({ tenantId: "tenant", version, createdAt }),
    );
  const projection = await resolver.resolve({
    tenantId: "tenant",
    agentVersionId: shared.agentVersionId,
  });
  const independent = await resolver.resolve({
    tenantId: "tenant",
    agentVersionId: owned.agentVersionId,
  });
  assert.ok(projection && independent);
  assert.equal(projection.close, undefined);
  assert.equal(typeof independent.close, "function");
  assert.notEqual(independent.toolRuntime, owner);
  assert.equal(
    registry.resolve({ tenantId: "tenant", agentVersionId: "owned" }),
    independent,
  );
  assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 1);
  assert.equal(
    bound.runtimeOwnership?.({ tenantId: "tenant", version: owned }),
    "ownedRuntime",
  );
  assert.equal(resolver.nextToolResultMaintenanceRuntime(), owner);
  assert.equal(
    resolver.nextToolResultMaintenanceRuntime(),
    independent.toolRuntime,
  );

  let prewarms = 0,
    closes = 0;
  const binding: AgentVersionRuntimeBinding = {
    tenantId: "tenant",
    agentVersionId: shared.agentVersionId,
    contentDigest: shared.contentDigest,
    authorityId: "authority",
    workspaceBindingId: null,
    materializationDigest: `sha256:${"a".repeat(64)}`,
    executionAuthority: "crewonKernel",
    toolRuntimeMode: "shared",
    createTransport: () => ({
      ...shared.model,
      prewarm: async () => {
        prewarms++;
      },
      close: async () => {
        closes++;
      },
      async *stream() {
        throw Error("no model");
      },
    }),
    createToolRuntime: () => {
      throw Error("must use shared Tools");
    },
  };
  const custom = new ConfiguredAgentVersionRuntimeFactory([
    binding,
  ]).bindSharedToolRuntime(owner);
  assert.equal(
    custom.runtimeOwnership?.({ tenantId: "tenant", version: shared }),
    "ownedRuntime",
  );
  const runtime = await custom.create({ tenantId: "tenant", version: shared });
  assert.equal(prewarms, 1);
  await runtime.close?.();
  await runtime.close?.();
  assert.equal(closes, 1);
});

for (const resource of ["close", "prewarm"] as const)
  test(`a transport falsely marked request-owned with ${resource} is rejected before Tool initialization`, async () => {
    const version = httpVersion("wrong"),
      owner = new InMemoryToolBroker();
    let closed = 0,
      warmed = 0,
      tools = 0;
    const transport = {
      ...version.model,
      async *stream() {
        throw Error("no model");
      },
      ...(resource === "close"
        ? {
            close: async () => {
              closed++;
            },
          }
        : {
            prewarm: async () => {
              warmed++;
            },
          }),
    };
    const factory = new ConfiguredAgentVersionRuntimeFactory([
      {
        tenantId: "tenant",
        agentVersionId: version.agentVersionId,
        contentDigest: version.contentDigest,
        authorityId: "authority",
        workspaceBindingId: null,
        materializationDigest: `sha256:${"a".repeat(64)}`,
        executionAuthority: "crewonKernel",
        toolRuntimeMode: "shared",
        transportOwnership: "request",
        createTransport: () => transport,
        createToolRuntime: () => {
          tools++;
          return owner;
        },
      },
    ]).bindSharedToolRuntime(owner);
    await assert.rejects(
      async () => factory.create({ tenantId: "tenant", version }),
      { message: "agent_version_request_transport_owns_resources" },
    );
    assert.equal(tools, 0);
    assert.equal(warmed, 0);
    assert.equal(closed, resource === "close" ? 1 : 0);
  });

test("a shared projection selection without a surviving Tool owner fails before materialization", async (t) => {
  const store = new InMemoryRunStore(),
    version = httpVersion("missing-owner"),
    registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  let created = 0;
  await store.registerAgentVersion(
    createAgentVersionAsset({ tenantId: "tenant", version, createdAt }),
  );
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    digester,
    factory: {
      runtimeOwnership: () => "sharedProjection",
      create: () => {
        created++;
        throw Error("must not initialize");
      },
    },
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  await assert.rejects(
    resolver.resolve({
      tenantId: "tenant",
      agentVersionId: version.agentVersionId,
    }),
    { message: "agent_version_runtime_ownership_invalid" },
  );
  assert.equal(created, 0);
});

test("HTTP projection recreation preserves endpoint, credential, request prefix and Run-private turn state isolation", async (t) => {
  const version = httpVersion("same"),
    versions = Array.from({ length: 64 }, (_, i) => httpVersion(`cold-${i}`));
  const bindings = [
    httpBinding(version, {
      tenantId: "a",
      endpoint: "https://one.invalid/v1/responses",
      apiKeyEnvironment: "KEY_A",
    }),
    httpBinding(version, {
      tenantId: "b",
      endpoint: "https://two.invalid/v1/responses",
      apiKeyEnvironment: "KEY_B",
    }),
    ...versions.map((v) => httpBinding(v)),
  ];
  const requests: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      requests.push({
        url: String(url),
        headers,
        body: JSON.parse(String(init.body)),
      });
      const token = String(url).includes("one.invalid") ? "turn-a" : "turn-b";
      const response = {
        id: `response-${requests.length}`,
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      };
      const events = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { id: response.id },
        },
        {
          type: "response.output_text.delta",
          sequence_number: 1,
          delta: "answer",
        },
        { type: "response.completed", sequence_number: 2, response },
      ];
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-codex-turn-state": token,
          },
        },
      );
    },
  );
  const factory = loadedHttpFactory(t, bindings, {
    KEY_A: "fixture-a",
    KEY_B: "fixture-b",
  }).bindSharedToolRuntime(new InMemoryToolBroker());
  const store = new InMemoryRunStore(),
    registry = new InMemoryAgentVersionRuntimeRegistry(digester),
    resolver = new StoreBackedAgentVersionRuntimeResolver({
      store,
      registry,
      digester,
      factory,
    });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  for (const tenantId of ["a", "b"])
    await store.registerAgentVersion(
      createAgentVersionAsset({ tenantId, version, createdAt }),
    );
  async function invoke(tenantId: string, turn?: string) {
    const runtime = await resolver.resolve({
      tenantId,
      agentVersionId: version.agentVersionId,
    });
    assert.ok(runtime);
    const contract: AgentSegmentContract = {
      schemaVersion: "crewon.agent-segment.v0",
      purpose: "agent",
      runId: `run-${tenantId}`,
      segmentId: "segment",
      attempt: 1,
      agentVersionId: version.agentVersionId,
      policySnapshotId: version.policySnapshotId,
      collaborationMode: "default",
      allowedTools: null,
      history: [{ type: "message", role: "user", content: "stable input" }],
      continuation: { kind: "manual" },
      budget: { maxOutputBytes: 32000 },
      ...(turn === undefined ? {} : { providerTurnState: turn }),
    };
    const events = [];
    for await (const event of runtime.kernel.runSegment(
      contract,
      new AbortController().signal,
    ))
      events.push(event);
    assert.ok(events.some((event) => event.type === "segment.completed"));
    return runtime;
  }
  const a = await invoke("a"),
    b = await invoke("b");
  assert.notEqual(a, b);
  for (const v of versions) {
    await store.registerAgentVersion(
      createAgentVersionAsset({ tenantId: "tenant", version: v, createdAt }),
    );
    await resolver.resolve({
      tenantId: "tenant",
      agentVersionId: v.agentVersionId,
    });
  }
  const restored = await invoke("a", "turn-a");
  assert.notEqual(restored, a);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.url, requests[2]?.url);
  assert.equal(requests[0]?.headers.authorization, "Bearer fixture-a");
  assert.equal(requests[1]?.headers.authorization, "Bearer fixture-b");
  assert.equal(requests[2]?.headers.authorization, "Bearer fixture-a");
  assert.equal(requests[0]?.headers["x-codex-turn-state"], undefined);
  assert.equal(requests[1]?.headers["x-codex-turn-state"], undefined);
  assert.equal(requests[2]?.headers["x-codex-turn-state"], "turn-a");
  assert.deepEqual(requests[2]?.body, requests[0]?.body);
});

test("a malformed explicit ownership selector cannot silently fall back to shared projection mode", async (t) => {
  const store = new InMemoryRunStore(),
    version = httpVersion("bad-selector"),
    registry = new InMemoryAgentVersionRuntimeRegistry(digester);
  await store.registerAgentVersion(
    createAgentVersionAsset({ tenantId: "tenant", version, createdAt }),
  );
  let created = 0;
  const resolver = new StoreBackedAgentVersionRuntimeResolver({
    store,
    registry,
    digester,
    factory: {
      sharedResourceOwner: new InMemoryToolBroker(),
      runtimeOwnership: () => undefined as never,
      create: () => {
        created++;
        throw Error("must not create");
      },
    },
  });
  t.after(async () => {
    resolver.close();
    await registry.close();
    await store.close();
  });
  await assert.rejects(
    resolver.resolve({
      tenantId: "tenant",
      agentVersionId: version.agentVersionId,
    }),
    { message: "agent_version_runtime_ownership_invalid" },
  );
  assert.equal(created, 0);
});

test("an external manifest cannot declare a transport to be request-owned", () => {
  const binding = {
    ...httpBinding(httpVersion("external")),
    transportOwnership: "request",
  };
  assert.throws(
    () =>
      parseRuntimeBindingConfig({
        schemaVersion: "crewon.agent-version-runtime-bindings.v0",
        bindings: [binding],
      }),
    { message: "agent_version_runtime_binding_invalid" },
  );
});

test("actual configured HTTP projections become collectable while the shared Tool owner remains live", async (t) => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./http-runtime-gc.test-support.ts", import.meta.url),
      ),
    ],
    { timeout: 10000, maxBuffer: 32768 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.evictedProjectionsCollected, 64);
  assert.equal(result.hotEntries, 64);
  assert.equal(result.modelCalls, 0);
  t.diagnostic(JSON.stringify(result));
});
