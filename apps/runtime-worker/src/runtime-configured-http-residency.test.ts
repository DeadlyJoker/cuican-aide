import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { ToolResultCapacity } from "@crewon/tool-broker";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import {
  copyVersion,
  digester,
} from "./shared-agent-runtime-cache.test-support.ts";
import {
  httpBinding,
  loadedHttpFactory,
} from "./http-runtime-residency.test-support.ts";

const responseHeaders = { "x-codex-turn-state": "run-private-http-86" };
type FixtureOptions = Parameters<typeof createFixture>[1];
async function configuredFixture(t: TestContext, options: FixtureOptions) {
  let resolver!: StoreBackedAgentVersionRuntimeResolver,
    registered!: Promise<void>,
    versions!: CompiledAgentVersion[];
  let materializations = 0;
  const headers: {
    method: string | undefined;
    authorization: string | string[] | undefined;
    turn: string | string[] | undefined;
  }[] = [];
  const f = await createFixture(t, {
    ...options,
    modelResponseHeaders: responseHeaders,
    observeModelHeaders: (request) =>
      headers.push({
        method: request.method,
        authorization: request.headers.authorization,
        turn: request.headers["x-codex-turn-state"],
      }),
    runtimeResolverFactory: (runtime, store, shared) => {
      resolver?.close();
      versions = [
        runtime.version,
        ...Array.from({ length: 64 }, (_, i) =>
          copyVersion(runtime.version, `manifest-${i}`),
        ),
      ];
      const factory = loadedHttpFactory(
        t,
        versions.map((version) =>
          httpBinding(version, {
            tenantId: "tenant-1",
            authorityId: shared.route.authorityId,
            endpoint: shared.endpoint,
            storeResponses: options.storeResponses,
            apiKeyEnvironment: "FIXTURE_KEY",
          }),
        ),
        { FIXTURE_KEY: "fixture-http-key" },
      ).bindSharedToolRuntime(runtime.toolRuntime);
      const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
      t.after(() => registry.close());
      registered = (async () => {
        for (const version of versions)
          await store.registerAgentVersion(
            createAgentVersionAsset({
              tenantId: "tenant-1",
              version,
              createdAt: "2026-09-15T00:00:00Z",
            }),
          );
      })();
      const ready = registered;
      resolver = new StoreBackedAgentVersionRuntimeResolver({
        store,
        registry,
        digester,
        factory: {
          ...factory,
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
          await ready;
          return inner.resolve(locator);
        },
        nextToolResultMaintenanceRuntime: () =>
          inner.nextToolResultMaintenanceRuntime(),
      };
    },
  });
  await registered;
  const reopen = f.reopen;
  f.reopen = async () => {
    await reopen();
    await registered;
  };
  return {
    f,
    headers,
    count: () => materializations,
    resolver: () => resolver,
    churn: async () => {
      await registered;
      for (const version of versions.slice(1))
        assert.ok(
          await resolver.resolve({
            tenantId: "tenant-1",
            agentVersionId: version.agentVersionId,
          }),
        );
      assert.equal(resolver.sharedRuntimeCacheSnapshot().entries, 64);
      assert.equal(
        resolver.resolveResident({
          tenantId: "tenant-1",
          agentVersionId: versions[0]!.agentVersionId,
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
  for (const storeResponses of [false, true])
    test(
      `${backend}: configured HTTP recovery after cache eviction preserves committed tools and private turn state, stored=${storeResponses}`,
      options,
      async (t) => {
        const normal = await createFixture(t, {
          backend,
          storeResponses,
          crashAfterCommit: false,
          modelResponseHeaders: responseHeaders,
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        const p = await configuredFixture(t, {
            backend,
            storeResponses,
            crashAfterCommit: false,
            crashAfterResolved: true,
          }),
          f = p.f;
        assert.equal((await f.worker().wake()).kind, "retried");
        assert.equal(f.executions(), 1);
        assert.equal(f.requests.length, 1);
        const before = { history: await f.history(), events: await f.events() };
        await p.churn();
        assert.deepEqual(
          { history: await f.history(), events: await f.events() },
          before,
        );
        await f.makeDue();
        if (storeResponses) await f.reopen();
        assert.equal((await f.worker().wake()).kind, "completed");
        assert.equal(f.executions(), 1);
        assert.equal(p.count(), 66);
        assert.deepEqual(f.requests, normal.requests);
        assert.deepEqual(
          p.headers
            .filter((h) => h.method === "POST")
            .map((h) => [h.authorization, h.turn]),
          [
            ["Bearer fixture-http-key", undefined],
            ["Bearer fixture-http-key", "run-private-http-86"],
          ],
        );
        assert.ok(
          !JSON.stringify(await f.history()).includes("run-private-http-86"),
        );
        if (storeResponses)
          assert.equal(f.requests[1]?.previous_response_id, "resp-tools");
      },
    );

  test(
    `${backend}: cancellation still settles a returned effect after its configured HTTP projection is evicted`,
    options,
    async (t) => {
      const p = await configuredFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          crashAfterResolved: true,
        }),
        f = p.f;
      assert.equal((await f.worker().wake()).kind, "retried");
      await p.churn();
      await f.cancel();
      await f.makeDue();
      assert.equal((await f.worker().wake()).kind, "canceled");
      assert.equal(f.executions(), 1);
      assert.equal(f.requests.length, 1);
      assert.equal((await f.run())?.status, "canceled");
      assert.equal(
        (await f.events()).filter((e) => e.type === "run.canceled").length,
        1,
      );
    },
  );

  test(
    `${backend}: configured shared Tools keep ACK maintenance independent of cached HTTP projections`,
    options,
    async (t) => {
      const capacity = new ToolResultCapacity({ maximumExecutions: 1 });
      const p = await configuredFixture(t, {
          backend,
          storeResponses: true,
          crashAfterCommit: false,
          resultCapacity: capacity,
        }),
        f = p.f;
      const ignored = t.mock.method(
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
      ignored.mock.restore();
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
      assert.equal(f.executions(), 1);
    },
  );

  test(
    `${backend}: active configured HTTP stream recovers the same response after eviction and body disconnect`,
    options,
    async (t) => {
      const response = {
        id: "response-http-86",
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
      let p!: Awaited<ReturnType<typeof configuredFixture>>,
        churned = false;
      let checkpointed!: () => void;
      const checkpoint = new Promise<void>((resolve) => {
        checkpointed = resolve;
      });
      p = await configuredFixture(t, {
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
        beforeFirstStreamInterrupted: () => checkpoint,
        retrievedResponse: response,
        afterProviderResponseCheckpointed: async () => {
          checkpointed();
          if (!churned) {
            churned = true;
            await p.churn();
          }
        },
      });
      assert.equal((await p.f.worker().wake()).kind, "completed");
      assert.equal(churned, true);
      assert.equal(p.f.requests.length, 1);
      assert.equal(p.f.retrievals(), 1);
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
      assert.equal(report.generations.missingUsage, 0);
      assert.equal(report.total.usage.cacheReadHitRate, 0.8); // Simulated usage, not a real cache benchmark.
      // Response retrieval uses the response ID plus credential, not the generation-only turn header.
      const baselineHeaders: {
        method: string | undefined;
        turn: string | string[] | undefined;
      }[] = [];
      let baselineCheckpointed!: () => void;
      const baselineCheckpoint = new Promise<void>((resolve) => {
        baselineCheckpointed = resolve;
      });
      const baseline = await createFixture(t, {
        backend,
        storeResponses: true,
        crashAfterCommit: false,
        streamMaxRetries: 1,
        modelResponseHeaders: responseHeaders,
        observeModelHeaders: (request) =>
          baselineHeaders.push({
            method: request.method,
            turn: request.headers["x-codex-turn-state"],
          }),
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
        beforeFirstStreamInterrupted: () => baselineCheckpoint,
        afterProviderResponseCheckpointed: async () => baselineCheckpointed(),
        retrievedResponse: response,
      });
      assert.equal((await baseline.worker().wake()).kind, "completed");
      assert.deepEqual(
        p.headers.map((h) => [h.method, h.turn]),
        baselineHeaders.map((h) => [h.method, h.turn]),
      );
      assert.deepEqual(p.f.requests, baseline.requests);
      assert.ok(
        p.headers.every((h) => h.authorization === "Bearer fixture-http-key"),
      );
      const history = await p.f.history();
      await p.f.reopen();
      assert.equal((await p.f.worker().wake()).kind, "idle");
      assert.deepEqual(await p.f.history(), history);
      assert.deepEqual(await p.f.callRecords(), calls);
    },
  );
}
