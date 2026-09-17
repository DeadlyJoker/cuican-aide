import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createAgentVersionAsset } from "@crewon/agent-version";
import type { ModelTransportPort } from "@crewon/agent-kernel";
import { ToolResultCapacity } from "@crewon/tool-broker";
import {
  InMemoryAgentVersionRuntimeRegistry,
  type AgentVersionRuntime,
} from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { sharedAgentVersionRuntimeFactory } from "./shared-agent-version-runtime-factory.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  copyVersion,
  digester,
} from "./shared-agent-runtime-cache.test-support.ts";
import { deferred } from "./runtime-store-access.test-support.ts";

type FixtureOptions = Parameters<typeof createFixture>[1];
async function projectedFixture(t: TestContext, options: FixtureOptions) {
  let resolver!: StoreBackedAgentVersionRuntimeResolver,
    base!: AgentVersionRuntime;
  let materializations = 0,
    transportCloses = 0,
    streams = 0;
  const f = await createFixture(t, {
    ...options,
    runtimeResolverFactory: (runtime, store, shared) => {
      resolver?.close();
      base = runtime;
      const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
      t.after(() => registry.close());
      const transport: ModelTransportPort = {
        adapterName: shared.transport.adapterName,
        adapterVersion: shared.transport.adapterVersion,
        modelId: shared.transport.modelId,
        supportsResponseRetrieve: shared.transport.supportsResponseRetrieve,
        stream: (...args) => {
          streams++;
          return shared.transport.stream(...args);
        },
        releaseRun: (id) => shared.transport.releaseRun?.(id),
        close: async () => {
          transportCloses++;
          await shared.transport.close?.();
        },
      };
      const factory = sharedAgentVersionRuntimeFactory(
        { ...shared, transport },
        runtime.toolRuntime,
      );
      const registered = store.registerAgentVersion(
        createAgentVersionAsset({
          tenantId: "tenant-1",
          version: runtime.version,
          createdAt: "2026-09-15T00:00:00Z",
        }),
      );
      resolver = new StoreBackedAgentVersionRuntimeResolver({
        store,
        registry,
        digester,
        factory: {
          sharedResourceOwner: runtime.toolRuntime,
          create: (input) => {
            materializations++;
            return factory.create(input);
          },
        },
      });
      const inner = resolver;
      t.after(() => inner.close());
      return {
        resolveResident: (locator) => inner.resolveResident(locator),
        resolve: async (locator) => {
          await registered;
          return inner.resolve(locator);
        },
        nextToolResultMaintenanceRuntime: () =>
          inner.nextToolResultMaintenanceRuntime(),
      };
    },
  });
  let generation = 0;
  return {
    f,
    resolver: () => resolver,
    base: () => base,
    counts: () => ({ materializations, transportCloses, streams }),
    churn: async () => {
      for (let i = 0; i < 64; i++) {
        const version = copyVersion(base.version, `cold-${generation}-${i}`);
        await f.store().registerAgentVersion(
          createAgentVersionAsset({
            tenantId: "tenant-1",
            version,
            createdAt: "2026-09-15T00:00:00Z",
          }),
        );
        assert.ok(
          await resolver.resolve({
            tenantId: "tenant-1",
            agentVersionId: version.agentVersionId,
          }),
        );
      }
      generation++;
      assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 64);
      assert.equal(
        resolver.resolveResident({
          tenantId: "tenant-1",
          agentVersionId: base.version.agentVersionId,
        }),
        null,
      );
    },
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 30000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  for (const storeResponses of [false, true]) {
    test(
      `${backend}: eviction after tool-result interruption preserves exactly one effect and the full model request, stored=${storeResponses}`,
      options,
      async (t) => {
        const normal = await createFixture(t, {
          backend,
          storeResponses,
          crashAfterCommit: false,
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        const p = await projectedFixture(t, {
            backend,
            storeResponses,
            crashAfterCommit: false,
            crashAfterResolved: true,
          }),
          f = p.f;
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, 1);
        const history = await f.history(),
          events = await f.events();
        await p.churn();
        assert.deepEqual(await f.history(), history);
        assert.deepEqual(await f.events(), events);
        assert.equal(p.counts().transportCloses, 0);
        assert.equal(p.counts().streams, 1);
        await f.makeDue();
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.executions(), 1);
        assert.deepEqual(f.requests, normal.requests);
        assert.equal(p.counts().materializations, 66);
        assert.equal(p.counts().transportCloses, 0);
        if (storeResponses)
          assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
        const before = await f.events();
        await f.reopen();
        assert.equal((await f.worker().wake()).kind, "idle");
        assert.deepEqual(await f.events(), before);
        assert.equal(f.executions(), 1);
      },
    );
  }

  test(
    `${backend}: active execution survives reference eviction without closing its shared transport or Tool owner`,
    options,
    async (t) => {
      const held = deferred(),
        entered = deferred();
      t.after(() => held.resolve());
      const p = await projectedFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          afterToolProviderResolved: async () => {
            entered.resolve();
            await held.promise;
          },
        }),
        f = p.f;
      const wake = f.worker().wake();
      await entered.promise;
      assert.equal(f.executions(), 1);
      assert.equal(f.requests.length, 1);
      await p.churn();
      assert.equal(p.counts().transportCloses, 0);
      held.resolve();
      assert.equal((await wake).kind, "completed");
      assert.equal(f.executions(), 1);
      assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      assert.equal(p.counts().transportCloses, 0);
    },
  );

  test(
    `${backend}: shared-owner maintenance acknowledges a completed result after its projection has been evicted`,
    options,
    async (t) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const p = await projectedFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          resultCapacity: capacity,
        }),
        f = p.f;
      const interrupted = t.mock.method(
        f.broker,
        "acknowledgeExecutionResult",
        () => undefined,
      );
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(capacity.resourceSnapshot().executionCount, 1);
      const before = {
        history: await f.history(),
        events: await f.events(),
        requests: structuredClone(f.requests),
      };
      await p.churn();
      interrupted.mock.restore();
      assert.equal((await f.worker().wake()).kind, "idle");
      assert.equal(capacity.resourceSnapshot().executionCount, 0);
      assert.equal(f.worker().toolResultMaintenanceSnapshot().acknowledged, 1);
      assert.deepEqual(
        {
          history: await f.history(),
          events: await f.events(),
          requests: f.requests,
        },
        before,
      );
      await f.nextUserTurn();
      assert.equal((await f.worker().wake()).kind, "completed");
      assert.equal(f.requests[2]?.previous_response_id, "resp-answer");
      assert.deepEqual(f.requests[2]?.input, [
        { role: "user", content: "next user turn" },
      ]);
      for (const key of ["model", "instructions", "tools"])
        assert.deepEqual(f.requests[2]?.[key], f.requests[0]?.[key]);
      assert.equal(f.executions(), 1);
      assert.equal(p.counts().transportCloses, 0);
    },
  );
  test(
    `${backend}: a streaming disconnect retrieves the same response after the active projection leaves the cache`,
    options,
    async (t) => {
      const response = {
        id: "response-1",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "answer" }],
          },
        ],
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 80 },
          output_tokens: 10,
          total_tokens: 110,
        },
      };
      let p!: Awaited<ReturnType<typeof projectedFixture>>,
        interrupted = false;
      p = await projectedFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        streamMaxRetries: 1,
        modelResponseEvents: () => [
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
        ],
        interruptFirstStreamAfterEvents: 2,
        retrievedResponse: response,
        afterProviderResponseCheckpointed: async () => {
          if (!interrupted) {
            interrupted = true;
            await p.churn();
          }
        },
      });
      assert.equal((await p.f.worker().wake()).kind, "completed");
      assert.equal(interrupted, true);
      assert.equal(p.f.requests.length, 1);
      assert.equal(p.f.retrievals(), 1);
      assert.equal(p.counts().transportCloses, 0);
      const calls = await p.f.callRecords();
      assert.deepEqual(
        calls.map((row) => [
          row.record.observation.operation,
          row.record.observation.outcome,
        ]),
        [
          ["generate", "failed"],
          ["retrieve", "completed"],
        ],
      );
      const report = await p.f.accountingReport();
      assert.equal(report.total.usage.inputTokens, 100);
      assert.equal(report.total.usage.cacheReadHitRate, 0.8); // Controlled fixture usage, not a real Provider cache measurement.
      assert.equal(report.generations.missingUsage, 0);
      const history = await p.f.history();
      await p.f.reopen();
      assert.equal((await p.f.worker().wake()).kind, "idle");
      assert.deepEqual(await p.f.history(), history);
      assert.deepEqual(await p.f.callRecords(), calls);
    },
  );
}
