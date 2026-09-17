import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentVersionAsset,
  type CompiledAgentVersion,
} from "@crewon/agent-version";
import { DirectResponsesTransport } from "@crewon/agent-responses";
import { InMemoryToolBroker } from "@crewon/tool-broker";
import { InMemoryAgentVersionRuntimeRegistry } from "./agent-version-runtime.ts";
import { ConfiguredAgentVersionRuntimeFactory } from "./configured-agent-version-runtime-factory.ts";
import { StoreBackedAgentVersionRuntimeResolver } from "./store-backed-agent-version-runtime-resolver.ts";
import { createFixture } from "./runtime-tool-continuation.test-support.ts";
import { digester } from "./shared-agent-runtime-cache.test-support.ts";
import { httpVersion } from "./http-runtime-residency.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const stored of [false, true]) {
    test(
      `${backend}: owned runtime retirement preserves crash recovery, HTTP prefix and turn state, stored=${stored}`,
      {
        timeout: 30000,
        skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      },
      async (t) => {
        const headers = { "x-codex-turn-state": "stable-turn-state" };
        const normalHeaders: unknown[] = [],
          recoveredHeaders: unknown[] = [];
        const normal = await createFixture(t, {
          backend,
          storeResponses: stored,
          crashAfterCommit: false,
          modelResponseHeaders: headers,
          observeModelHeaders: ({ headers }) =>
            normalHeaders.push(headers["x-codex-turn-state"]),
        });
        assert.equal((await normal.worker().wake()).kind, "completed");
        await normal.nextUserTurn();
        await normal.reopen();
        assert.equal((await normal.worker().wake()).kind, "completed");

        const registry = new InMemoryAgentVersionRuntimeRegistry(digester);
        const cold = Array.from({ length: 100 }, (_, n) =>
          httpVersion(`cold-${n}`),
        );
        let resolver!: StoreBackedAgentVersionRuntimeResolver;
        let target!: CompiledAgentVersion;
        let effects = 0,
          targetCreations = 0,
          targetCloses = 0;
        const recovered = await createFixture(t, {
          backend,
          storeResponses: stored,
          crashAfterCommit: false,
          crashAfterResolved: true,
          modelResponseHeaders: headers,
          observeModelHeaders: ({ headers }) =>
            recoveredHeaders.push(headers["x-codex-turn-state"]),
          runtimeResolverFactory(base, store, shared) {
            resolver?.close();
            target = base.version;
            const factory = new ConfiguredAgentVersionRuntimeFactory(
              [target, ...cold].map((version) => ({
                tenantId: "tenant-1",
                agentVersionId: version.agentVersionId,
                contentDigest: version.contentDigest,
                authorityId: shared.route.authorityId,
                workspaceBindingId: null,
                materializationDigest: `sha256:${"d".repeat(64)}`,
                executionAuthority: "crewonKernel",
                transportOwnership: "request",
                createTransport: () =>
                  new DirectResponsesTransport({
                    endpoint: shared.endpoint,
                    model: "fixture-model",
                    storeResponses: stored,
                  }),
                createToolRuntime() {
                  const isTarget =
                    version.agentVersionId === target.agentVersionId;
                  if (isTarget) targetCreations++;
                  const tools = new InMemoryToolBroker(
                    version.tools,
                    isTarget
                      ? new Map([
                          [
                            "function:fixture_tool",
                            async () => {
                              effects++;
                              return { output: "tool-result" };
                            },
                          ],
                        ])
                      : undefined,
                    isTarget
                      ? new Map([
                          [
                            "function:fixture_tool",
                            base.toolRuntime.executionPolicy(
                              "function",
                              "fixture_tool",
                            )!,
                          ],
                        ])
                      : undefined,
                  );
                  return Object.assign(tools, {
                    close: async () => {
                      if (isTarget) targetCloses++;
                    },
                  });
                },
              })),
            );
            resolver = new StoreBackedAgentVersionRuntimeResolver({
              registry,
              store,
              digester,
              factory,
            });
            return resolver;
          },
        });
        t.after(async () => {
          await recovered.worker().close();
          resolver.close();
          await registry.close();
        });
        for (const version of [target, ...cold]) {
          await recovered.store().registerAgentVersion(
            createAgentVersionAsset({
              tenantId: "tenant-1",
              version,
              createdAt: "2026-09-15T00:00:00Z",
            }),
          );
        }
        const locator = {
          tenantId: "tenant-1",
          agentVersionId: target.agentVersionId,
        };
        const churn = async () => {
          for (const version of cold) {
            const lease = await resolver.acquire({
              tenantId: "tenant-1",
              agentVersionId: version.agentVersionId,
            });
            assert.ok(lease);
            lease.release();
          }
          for (let n = 0; n < 50; n++) {
            registry.nextToolResultMaintenanceLease()?.release();
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (
              registry.retirementSnapshot().retiring === 0 &&
              registry.retirementSnapshot().candidates <= 64
            )
              return;
          }
          assert.fail("retirement did not converge");
        };
        assert.equal((await recovered.worker().wake()).kind, "retried");
        assert.equal(effects, 1);
        assert.equal(registry.resourceSnapshot().activeLeases, 0);
        const first = registry.peekResident(locator);
        assert.ok(first);
        assert.equal(first.canRetire!(), false);
        await churn();
        assert.equal(registry.peekResident(locator), first);
        assert.equal(targetCloses, 0);
        await recovered.reopen();
        assert.equal((await recovered.worker().wake()).kind, "completed");
        assert.equal(effects, 1);
        assert.equal(first.canRetire!(), true);
        assert.equal(targetCreations, 1);
        await churn();
        assert.equal(registry.peekResident(locator), null);
        assert.equal(targetCloses, 1);
        await recovered.nextUserTurn();
        await recovered.reopen();
        assert.equal((await recovered.worker().wake()).kind, "completed");
        assert.equal(targetCreations, 2);
        assert.notEqual(registry.peekResident(locator), first);
        assert.deepEqual(
          registry.peekResident(locator)!.version,
          first.version,
        );
        assert.equal(effects, 1);
        assert.deepEqual(recovered.requests, normal.requests);
        assert.deepEqual(recoveredHeaders, normalHeaders);
        assert.equal(recovered.requests.length, 3);
        assert.equal(recoveredHeaders[1], "stable-turn-state");
        assert.equal(registry.resourceSnapshot().activeLeases, 0);
      },
    );
  }
}
